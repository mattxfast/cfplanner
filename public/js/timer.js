// FitFactory — chronomètre de WOD (onglet « Chrono ») : For Time, AMRAP, EMOM, Tabata / intervalles.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.
// Le temps est calculé à partir de performance.now() (pas de dérive), l’écran reste allumé pendant le chrono
// (Screen Wake Lock) et des bips signalent le décompte 3-2-1 et chaque changement de phase.

const TIMER_PREP = 10; // secondes de décompte avant le départ
// Valeurs proposées par les boutons −/＋ (en secondes pour les durées).
const timerRange = (from, to, step) =>
  Array.from({length: Math.floor((to - from) / step) + 1}, (_, i) => from + i * step);
// AMRAP et EMOM : 15 s, 20 s, 30 s, 45 s, puis toutes les 15 s jusqu’à 3 min, 3 min 30, 4 min, puis chaque minute.
const TIMER_DURATIONS = [15, 20, 30, 45, ...timerRange(60, 180, 15), 210, 240, ...timerRange(300, 3600, 60)];
// Tabata : chaque seconde jusqu’à 30 s, 5 s jusqu’à 1 min, 10 s jusqu’à 3 min, 15 s jusqu’à 8 min, 30 s jusqu’à
// 10 min, puis chaque minute jusqu’à 15 min.
const TIMER_INTERVALS = [
  ...timerRange(1, 30, 1),
  ...timerRange(35, 60, 5),
  ...timerRange(70, 180, 10),
  ...timerRange(195, 480, 15),
  ...timerRange(510, 600, 30),
  ...timerRange(660, 900, 60),
];
// 75 → « 1 min 15 », 60 → « 1 min », 20 → « 20 s ».
const timerDuration = sec =>
  sec < 60 ? sec + " s" : Math.floor(sec / 60) + " min" + (sec % 60 ? " " + String(sec % 60).padStart(2, "0") : "");
const TIMER_MODES = {
  fortime: {
    label: "For Time",
    fields: [
      {
        key: "cap",
        label: "Temps limite",
        values: timerRange(0, 90, 1),
        value: 0,
        format: v => (v ? v + " min" : "aucun"),
      },
    ],
  },
  amrap: {
    label: "AMRAP",
    fields: [{key: "duration", label: "Durée", values: TIMER_DURATIONS, value: 720, format: timerDuration}],
  },
  emom: {
    label: "EMOM",
    fields: [
      {key: "every", label: "Toutes les", values: TIMER_DURATIONS, value: 60, format: timerDuration},
      {key: "rounds", label: "Tours", values: timerRange(1, 99, 1), value: 10, format: String, stepper: true},
    ],
  },
  tabata: {
    label: "Tabata",
    fields: [
      {key: "work", label: "Travail", values: TIMER_INTERVALS, value: 20, format: timerDuration},
      {
        key: "rest",
        label: "Repos",
        values: [0, ...TIMER_INTERVALS],
        value: 10,
        format: v => (v ? timerDuration(v) : "aucun"),
      },
      {key: "rounds", label: "Tours", values: timerRange(1, 99, 1), value: 8, format: String, stepper: true},
    ],
  },
};

const timer = {
  mode: "fortime",
  settings: {},
  plan: [],
  state: "idle",
  startedAt: 0,
  pausedAt: 0,
  pausedTotal: 0,
  rounds: 0,
  lastBeep: "",
  midBeep: false,
  frame: 0,
  wakeLock: null,
  audio: null,
  repeat: 0,
};

function timerLoadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("fitfactory-timer") || "{}");
    if (TIMER_MODES[saved.mode]) timer.mode = saved.mode;
    timer.settings = saved.settings || {};
    // Anciens réglages : durée de l’AMRAP enregistrée en minutes.
    const amrap = timer.settings.amrap;
    if (amrap && amrap.duration === undefined && amrap.minutes) amrap.duration = amrap.minutes * 60;
  } catch {}
  for (const [mode, def] of Object.entries(TIMER_MODES)) {
    timer.settings[mode] = timer.settings[mode] || {};
    for (const f of def.fields) {
      const v = Number(timer.settings[mode][f.key]);
      timer.settings[mode][f.key] = f.values.includes(v) ? v : f.value;
    }
  }
}
function timerSaveSettings() {
  try {
    localStorage.setItem("fitfactory-timer", JSON.stringify({mode: timer.mode, settings: timer.settings}));
  } catch {}
}

// Découpe la séance en segments successifs : décompte, puis travail / repos selon le mode.
function timerBuildPlan() {
  const s = timer.settings[timer.mode],
    plan = [{kind: "prep", label: "Prépare-toi", duration: TIMER_PREP}];
  if (timer.mode === "fortime")
    plan.push({
      kind: "work",
      label: "For Time",
      big: s.cap ? s.cap + " min" : "",
      duration: s.cap ? s.cap * 60 : Infinity,
      countUp: true,
    });
  if (timer.mode === "amrap") plan.push({kind: "work", label: "AMRAP", duration: s.duration});
  if (timer.mode === "emom")
    for (let i = 1; i <= s.rounds; i++)
      plan.push({kind: "work", label: "EMOM", big: `Tour ${i} / ${s.rounds}`, duration: s.every});
  if (timer.mode === "tabata")
    for (let i = 1; i <= s.rounds; i++) {
      plan.push({kind: "work", label: "Travail", big: `Tour ${i} / ${s.rounds}`, duration: s.work});
      if (s.rest && i < s.rounds)
        plan.push({kind: "rest", label: "Repos", big: `Tour ${i} / ${s.rounds}`, duration: s.rest});
    }
  return plan;
}

const timerFormat = seconds => {
  const total = Math.max(0, Math.floor(seconds)),
    m = Math.floor(total / 60),
    s = total % 60;
  return String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
};
function timerElapsed() {
  if (timer.state === "idle") return 0;
  const now = timer.state === "paused" || timer.state === "done" ? timer.pausedAt : performance.now();
  return (now - timer.startedAt - timer.pausedTotal) / 1000;
}
// Segment en cours à l’instant t (secondes depuis le départ, décompte compris).
function timerSegmentAt(t) {
  let start = 0;
  for (let i = 0; i < timer.plan.length; i++) {
    const seg = timer.plan[i];
    if (t < start + seg.duration) return {index: i, seg, into: t - start, left: start + seg.duration - t};
    start += seg.duration;
  }
  return null;
}

// Sons (onde carrée, aigus et forts) : bips courts (3-2-1), long (« Go », changement de phase, fin) et double bip
// très aigu (mi-temps).
// Le contexte audio est créé au premier toucher. Sur iPhone, la session audio « playback » fait sonner les bips
// même quand le bouton silencieux est activé (iOS 17 et plus).
function timerTone(freq, at, length) {
  const ctx = timer.audio,
    osc = ctx.createOscillator(),
    gain = ctx.createGain(),
    t0 = ctx.currentTime + at;
  osc.type = "square"; // timbre plus perçant qu’une sinusoïde, s’entend mieux pendant l’effort
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.9, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + length);
  osc.connect(gain).connect(ctx.destination);
  osc.start(t0);
  osc.stop(t0 + length + 0.05);
}
function timerBeep(kind = "short") {
  try {
    if (navigator.audioSession) navigator.audioSession.type = "playback";
    timer.audio = timer.audio || new (window.AudioContext || window.webkitAudioContext)();
    if (timer.audio.state !== "running") timer.audio.resume();
    if (kind === "none") return; // préparation de l’audio seulement
    if (kind === "mid") {
      timerTone(2349, 0, 0.18);
      timerTone(2349, 0.26, 0.18);
    } else timerTone(kind === "long" ? 1760 : 1319, 0, kind === "long" ? 0.7 : 0.22);
    if (navigator.vibrate) navigator.vibrate(kind === "long" ? 300 : kind === "mid" ? [80, 60, 80] : 80);
  } catch {}
}

// iPhone : sans son pendant plusieurs minutes, iOS met en veille l’audio de la page et les bips de fin (3-2-1, fin
// de chaque intervalle et du chrono) ne sortent plus. Un signal inaudible garde l’audio actif du départ à l’arrêt.
function timerAudioKeepAlive(on) {
  try {
    if (on && !timer.keepAlive) {
      timerBeep("none");
      const ctx = timer.audio,
        osc = ctx.createOscillator(),
        gain = ctx.createGain();
      gain.gain.value = 0.00001;
      osc.frequency.value = 40;
      osc.connect(gain).connect(ctx.destination);
      osc.start();
      timer.keepAlive = osc;
    } else if (!on && timer.keepAlive) {
      timer.keepAlive.stop();
      timer.keepAlive = null;
    }
  } catch {}
}
async function timerKeepAwake(on) {
  try {
    if (on && "wakeLock" in navigator && !timer.wakeLock) {
      timer.wakeLock = await navigator.wakeLock.request("screen");
      timer.wakeLock.addEventListener("release", () => (timer.wakeLock = null));
    } else if (!on && timer.wakeLock) {
      await timer.wakeLock.release();
      timer.wakeLock = null;
    }
  } catch {}
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && timer.state === "running") {
    timerKeepAwake(true);
    if (timer.audio && timer.audio.state !== "running") timer.audio.resume().catch(() => {});
  }
});

function timerRender() {
  const view = $("#view-timer"),
    t = timerElapsed(),
    current = timer.state === "idle" ? null : timerSegmentAt(t),
    phase = $("#timerphase"),
    bigRound = $("#timerrounds"),
    clock = $("#timerclock"),
    sub = $("#timersub"),
    bar = $("#timerprogress span");
  view.classList.toggle("timer-active", timer.state !== "idle");
  view.dataset.phase = timer.state === "done" ? "done" : current?.seg.kind || "idle";
  const workTime = Math.max(0, t - TIMER_PREP);
  // For Time : temps limite ; EMOM et Tabata : numéro du tour. Affichés en grand au-dessus du temps.
  bigRound.hidden = timer.state === "done" || !current?.seg.big;
  if (!bigRound.hidden) bigRound.textContent = current.seg.big;
  if (timer.state === "idle") {
    const plan = timerBuildPlan(),
      total = plan.slice(1).reduce((n, s) => n + s.duration, 0);
    phase.textContent = TIMER_MODES[timer.mode].label;
    clock.textContent = timer.mode === "fortime" ? "00:00" : timerFormat(plan[1].duration);
    // For Time et AMRAP : le chrono affiche déjà le temps ; durée totale seulement pour EMOM et Tabata.
    sub.textContent =
      Number.isFinite(total) && timer.mode !== "amrap" && timer.mode !== "fortime"
        ? "Durée totale : " + timerFormat(total)
        : "";
    bar.style.width = "0%";
  } else if (timer.state === "done") {
    phase.textContent = "Terminé !";
    clock.textContent = timerFormat(
      timer.mode === "fortime" ? workTime : timer.plan.slice(1).reduce((n, s) => n + s.duration, 0)
    );
    sub.textContent = timer.mode === "amrap" ? `${timer.rounds} tour${timer.rounds > 1 ? "s" : ""}` : "Bravo !";
    bar.style.width = "100%";
  } else if (current) {
    const {seg, into, left} = current;
    phase.textContent = seg.label + (timer.state === "paused" ? " · en pause" : "");
    clock.textContent = timerFormat(seg.countUp ? into : Math.ceil(left));
    const total = timer.plan.slice(1).reduce((n, s) => n + s.duration, 0);
    sub.textContent =
      seg.kind === "prep"
        ? "Départ dans " + Math.ceil(left) + " s"
        : timer.mode === "amrap" || timer.mode === "fortime"
          ? ""
          : Number.isFinite(total)
            ? "Total " + timerFormat(workTime) + " / " + timerFormat(total)
            : "Total " + timerFormat(workTime);
    bar.style.width = (Number.isFinite(seg.duration) ? Math.min(100, (into / seg.duration) * 100) : 0) + "%";
  }
  $("#timerstart").textContent =
    timer.state === "running"
      ? "Pause"
      : timer.state === "paused"
        ? "Reprendre"
        : timer.state === "done"
          ? "Recommencer"
          : "Démarrer";
  $("#timerfinish").hidden = !(timer.mode === "fortime" && timer.state !== "idle" && timer.state !== "done");
  $("#timerround").hidden = timer.mode !== "amrap" || timer.state === "idle";
  $("#timerroundcount").textContent = timer.rounds;
}

function timerTick() {
  if (timer.state !== "running") return;
  const t = timerElapsed(),
    current = timerSegmentAt(t);
  if (!current) {
    timerStop("done");
    timerBeep("long");
    return;
  }
  // Un bip par seconde pendant les 3 dernières secondes d’un segment (le décompte 3-2-1 avant le départ compris),
  // un bip long au début de chaque segment de travail/repos (« Go »), un double bip à la moitié du temps total.
  const {index, seg, left, into} = current,
    key = index + ":" + Math.ceil(left),
    total = timer.plan.slice(1).reduce((n, s) => n + s.duration, 0);
  if (Number.isFinite(seg.duration) && left <= 3 && left > 0 && timer.lastBeep !== key) {
    timer.lastBeep = key;
    timerBeep("short");
  }
  if (!timer.midBeep && Number.isFinite(total) && total >= 60 && t - TIMER_PREP >= total / 2) {
    timer.midBeep = true;
    if (into < 0.25) timer.lastBeep = "start:" + index; // le double bip remplace alors le bip de changement de tour
    timerBeep("mid");
  }
  if (index > 0 && into < 0.25 && timer.lastBeep !== "start:" + index) {
    timer.lastBeep = "start:" + index;
    timerBeep("long");
  }
  timerRender();
  timer.frame = requestAnimationFrame(timerTick);
}
function timerStart() {
  if (timer.state === "running") {
    timer.state = "paused";
    timer.pausedAt = performance.now();
    cancelAnimationFrame(timer.frame);
    timerKeepAwake(false);
  } else if (timer.state === "paused") {
    timer.pausedTotal += performance.now() - timer.pausedAt;
    timer.state = "running";
    timerKeepAwake(true);
    timerTick();
  } else {
    timer.plan = timerBuildPlan();
    timer.state = "running";
    timer.startedAt = performance.now();
    timer.pausedTotal = 0;
    timer.rounds = 0;
    timer.lastBeep = "";
    timer.midBeep = false;
    timerBeep("short");
    timerAudioKeepAlive(true);
    timerKeepAwake(true);
    timerTick();
  }
  timerRender();
}
function timerStop(state = "idle") {
  cancelAnimationFrame(timer.frame);
  if (state === "done") timer.pausedAt = performance.now();
  timer.state = state;
  timerKeepAwake(false);
  // Arrêt du signal inaudible après le dernier bip (il garde l’audio actif pendant ce bip).
  setTimeout(() => timer.state !== "running" && timerAudioKeepAlive(false), 1500);
  timerRender();
}

function timerRenderSettings() {
  $("#timermodes").innerHTML = Object.entries(TIMER_MODES)
    .map(
      ([key, m]) =>
        `<label><input type="radio" name="timermode" value="${key}" ${key === timer.mode ? "checked" : ""}><span>${esc(m.label)}</span></label>`
    )
    .join("");
  $("#timermodes")
    .querySelectorAll("input")
    .forEach(
      input =>
        (input.onchange = () => {
          timer.mode = input.value;
          timerSaveSettings();
          timerRenderSettings();
        })
    );
  const def = TIMER_MODES[timer.mode],
    values = timer.settings[timer.mode];
  $("#timerfields").innerHTML = def.fields
    .map(
      f =>
        `<${f.stepper ? "div" : "label"} class="timer-field"><span class="timer-field-label">${esc(f.label)}</span>${
          f.stepper
            ? `<div class="timer-stepper">
      <button type="button" class="smallbtn" data-step="${f.key}" data-dir="-1" aria-label="Moins">−</button>
      <output>${esc(f.format(values[f.key]))}</output>
      <button type="button" class="smallbtn" data-step="${f.key}" data-dir="1" aria-label="Plus">＋</button></div>`
            : `<select class="timer-select" data-field="${f.key}">${f.values
                .map(v => `<option value="${v}" ${v === values[f.key] ? "selected" : ""}>${esc(f.format(v))}</option>`)
                .join("")}</select>`
        }</${f.stepper ? "div" : "label"}>`
    )
    .join("");
  // Durées : liste déroulante.
  $("#timerfields")
    .querySelectorAll("[data-field]")
    .forEach(
      select =>
        (select.onchange = () => {
          values[select.dataset.field] = Number(select.value);
          timerSaveSettings();
          timerRender();
        })
    );
  // Nombre de tours : un appui change d’un cran ; un appui maintenu fait défiler les valeurs.
  $("#timerfields")
    .querySelectorAll("[data-step]")
    .forEach(b => {
      const f = def.fields.find(x => x.key === b.dataset.step),
        step = () => {
          const i = f.values.indexOf(values[f.key]) + Number(b.dataset.dir);
          if (i < 0 || i >= f.values.length) return timerStopRepeat();
          values[f.key] = f.values[i];
          b.parentElement.querySelector("output").textContent = f.format(values[f.key]);
          timerSaveSettings();
          timerRender();
        };
      b.onpointerdown = event => {
        event.preventDefault();
        timerStopRepeat();
        step();
        timer.repeat = setTimeout(function again() {
          step();
          if (timer.repeat) timer.repeat = setTimeout(again, 90);
        }, 450);
      };
      b.onclick = event => event.detail === 0 && step(); // clavier (le toucher est géré par pointerdown)
    });
  timerRender();
}
function timerStopRepeat() {
  clearTimeout(timer.repeat);
  timer.repeat = 0;
}
["pointerup", "pointercancel", "blur"].forEach(type => window.addEventListener(type, timerStopRepeat));

// Chrono préréglé depuis un WOD du jour (page Séances) : réglages proposés par l’IA ramenés aux valeurs les plus
// proches des listes, texte du WOD affiché sous le chrono, puis départ (décompte de 10 s).
const timerNearest = (values, v) =>
  values.reduce((best, x) => (Math.abs(x - v) < Math.abs(best - v) ? x : best), values[0]);
const timerClamp = (v, min, max) => Math.min(max, Math.max(min, Math.round(v)));
function timerPreset(chrono, wod) {
  const s = chrono ? timer.settings[chrono.mode] : null;
  if (s) {
    if (chrono.mode === "fortime") s.cap = timerClamp(chrono.minutes || 0, 0, 90);
    if (chrono.mode === "amrap") s.duration = timerNearest(TIMER_DURATIONS, (chrono.minutes || 12) * 60);
    if (chrono.mode === "emom") {
      s.every = timerNearest(TIMER_DURATIONS, chrono.every_seconds || 60);
      s.rounds = timerClamp(chrono.rounds || ((chrono.minutes || 10) * 60) / s.every, 1, 99);
    }
    if (chrono.mode === "tabata") {
      s.work = timerNearest(TIMER_INTERVALS, chrono.work_seconds || 20);
      s.rest = timerNearest([0, ...TIMER_INTERVALS], chrono.rest_seconds ?? 10);
      s.rounds = timerClamp(chrono.rounds || 8, 1, 99);
    }
    timer.mode = chrono.mode;
    timerSaveSettings();
  }
  timerStop("idle");
  $("#timerwodtitle").textContent = wod?.title || "";
  $("#timerwodcontent").textContent = wod ? dailyBody(wod) : "";
  $("#timerwod").hidden = !wod;
  switchView("timer");
  timerRenderSettings();
  // Sans réglage reconnu (metcon qui ne se chronomètre pas ainsi) : le chrono s’ouvre sans démarrer.
  if (s) timerStart();
}
$("#timerwodclose").onclick = () => ($("#timerwod").hidden = true);

timerLoadSettings();
$("#timerstart").onclick = () => (timer.state === "done" ? (timerStop("idle"), timerStart()) : timerStart());
$("#timerreset").onclick = () => timerStop("idle");
$("#timerfinish").onclick = () => {
  timerStop("done");
  timerBeep("long");
};
$("#timerround").onclick = () => {
  timer.rounds++;
  if (navigator.vibrate) navigator.vibrate(40);
  timerRender();
};
timerRenderSettings();
