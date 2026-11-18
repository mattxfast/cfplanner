// FitFactory — chronomètre de WOD (onglet « Chrono ») : For Time, AMRAP, EMOM, Tabata / intervalles.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.
// Le temps est calculé à partir de performance.now() (pas de dérive), l’écran reste allumé pendant le chrono
// (Screen Wake Lock) et des bips signalent le décompte 3-2-1 et chaque changement de phase.

const TIMER_PREP = 10; // secondes de décompte avant le départ
const TIMER_MODES = {
  fortime: {
    label: "For Time",
    hint: "Chrono croissant, avec un temps limite facultatif.",
    fields: [{key: "cap", label: "Temps limite", unit: "min", min: 0, max: 90, step: 1, value: 0, zero: "aucun"}],
  },
  amrap: {
    label: "AMRAP",
    hint: "Un maximum de tours pendant la durée choisie.",
    fields: [{key: "minutes", label: "Durée", unit: "min", min: 1, max: 90, step: 1, value: 12}],
  },
  emom: {
    label: "EMOM",
    hint: "Un travail au début de chaque intervalle.",
    fields: [
      {key: "every", label: "Toutes les", unit: "s", min: 10, max: 600, step: 10, value: 60},
      {key: "rounds", label: "Tours", unit: "", min: 1, max: 99, step: 1, value: 10},
    ],
  },
  tabata: {
    label: "Tabata",
    hint: "Alternance travail / repos (20 s / 10 s × 8 par défaut).",
    fields: [
      {key: "work", label: "Travail", unit: "s", min: 5, max: 600, step: 5, value: 20},
      {key: "rest", label: "Repos", unit: "s", min: 0, max: 600, step: 5, value: 10},
      {key: "rounds", label: "Tours", unit: "", min: 1, max: 99, step: 1, value: 8},
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
};

function timerLoadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem("fitfactory-timer") || "{}");
    if (TIMER_MODES[saved.mode]) timer.mode = saved.mode;
    timer.settings = saved.settings || {};
  } catch {}
  for (const [mode, def] of Object.entries(TIMER_MODES)) {
    timer.settings[mode] = timer.settings[mode] || {};
    for (const f of def.fields) {
      const v = Number(timer.settings[mode][f.key]);
      timer.settings[mode][f.key] = Number.isFinite(v) && v >= f.min && v <= f.max ? v : f.value;
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
      big: s.cap ? s.cap + " min" : "Sans limite",
      duration: s.cap ? s.cap * 60 : Infinity,
      countUp: true,
    });
  if (timer.mode === "amrap") plan.push({kind: "work", label: "AMRAP", duration: s.minutes * 60});
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

// Sons : bips courts (3-2-1), long (« Go », changement de phase, fin) et double bip aigu (mi-temps).
// Le contexte audio est créé au premier toucher. Sur iPhone, la session audio « playback » fait sonner les bips
// même quand le bouton silencieux est activé (iOS 17 et plus).
function timerTone(freq, at, length) {
  const ctx = timer.audio,
    osc = ctx.createOscillator(),
    gain = ctx.createGain(),
    t0 = ctx.currentTime + at;
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(0.6, t0 + 0.01);
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
    if (kind === "mid") {
      timerTone(1175, 0, 0.15);
      timerTone(1175, 0.22, 0.15);
    } else timerTone(kind === "long" ? 880 : 660, 0, kind === "long" ? 0.6 : 0.18);
    if (navigator.vibrate) navigator.vibrate(kind === "long" ? 300 : kind === "mid" ? [80, 60, 80] : 80);
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
  if (document.visibilityState === "visible" && timer.state === "running") timerKeepAwake(true);
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
    sub.textContent = Number.isFinite(total) ? "Durée totale : " + timerFormat(total) : "Sans temps limite";
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
  $("#timerhint").textContent = def.hint;
  $("#timerfields").innerHTML = def.fields
    .map(
      f => `<div class="timer-field"><span class="timer-field-label">${esc(f.label)}</span><div class="timer-stepper">
      <button type="button" class="smallbtn" data-step="${f.key}" data-dir="-1" aria-label="Moins">−</button>
      <output>${values[f.key] === 0 && f.zero ? esc(f.zero) : values[f.key] + (f.unit ? " " + f.unit : "")}</output>
      <button type="button" class="smallbtn" data-step="${f.key}" data-dir="1" aria-label="Plus">＋</button></div></div>`
    )
    .join("");
  $("#timerfields")
    .querySelectorAll("[data-step]")
    .forEach(
      b =>
        (b.onclick = () => {
          const f = def.fields.find(x => x.key === b.dataset.step);
          values[f.key] = Math.min(f.max, Math.max(f.min, values[f.key] + Number(b.dataset.dir) * f.step));
          timerSaveSettings();
          timerRenderSettings();
        })
    );
  timerRender();
}

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
