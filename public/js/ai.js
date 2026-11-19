// FitFactory — génération de WOD par IA dans ses propres programmes : un WOD pour une semaine, ou tout le programme.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.
// La génération demande le réseau : elle n’entre jamais dans la file d’attente hors ligne.

const AI_MAX_MOVEMENTS = 5,
  AI_TIMEOUT = 100000;
let aiRunning = false,
  aiCancelled = false;

function aiBlocks(f) {
  const blocks = {};
  for (const k of ["echauffement", "technique", "force", "metcon", "retour_au_calme"]) blocks[k] = f[k].checked;
  return blocks;
}
// Liste repliable des mouvements imposés d’un bloc (technique ou force), 5 au plus.
function renderAiMovements(kind) {
  const box = $(`[data-ai-movements="${kind}"]`);
  box.innerHTML = `<details><summary>Mouvements imposés (facultatif, ${AI_MAX_MOVEMENTS} max) : <span data-ai-count>aucun, au choix de l’IA</span></summary><div class="ai-movement-list">${
    movementCatalog
      .map(
        m =>
          `<label class="movement-check"><input type="checkbox" name="${kind}_movements" value="${esc(m.id)}"><span>${esc(m.name)}</span></label>`
      )
      .join("") || `<p class="muted">Le catalogue de mouvements est vide.</p>`
  }</div></details>`;
  const sync = () => {
    const checked = [...box.querySelectorAll("input:checked")];
    box.querySelectorAll("input").forEach(i => (i.disabled = !i.checked && checked.length >= AI_MAX_MOVEMENTS));
    box.querySelector("[data-ai-count]").textContent = checked.length
      ? checked.map(i => i.nextElementSibling.textContent).join(", ")
      : "aucun, au choix de l’IA";
  };
  box.onchange = sync;
}
function syncAiForm() {
  const f = $("#aiform").elements,
    mode = $("#aiform").dataset.mode;
  for (const kind of ["technique", "force"])
    $(`[data-ai-movements="${kind}"]`).hidden = mode !== "wod" || !f[kind].checked;
}
async function openAiDialog(mode, pid, wodId = null) {
  const form = $("#aiform"),
    f = form.elements,
    p = programs.find(x => x.id === pid);
  if (!p) return;
  form.reset();
  form.dataset.mode = mode;
  f.program_id.value = pid;
  f.wod_id.value = wodId || "";
  form.querySelectorAll("[data-ai-mode]").forEach(el => (el.hidden = el.dataset.aiMode !== mode));
  f.per_week.disabled = mode !== "program";
  $("#aierror").textContent = "";
  $("#aiprogress").hidden = true;
  $("#aisubmit").disabled = false;
  const weeks = programWeeks(p);
  if (mode === "wod") {
    const w = visibleWods(pid).find(x => x.id === wodId),
      current = mondayOf(today()),
      fallback = weeks.find(x => !weeklyWodContent(wodId, x).trim()) || weeks[0];
    $("#aititle").textContent = "Générer « " + (w?.name || "WOD") + " »";
    $("#aiintro").textContent =
      "L’IA écrit le contenu de ce WOD pour la semaine choisie (un contenu déjà écrit est remplacé).";
    f.week_start.innerHTML = weeks
      .map(
        (x, i) =>
          `<option value="${x}">S${i + 1} — ${fmt(x)}${weeklyWodContent(wodId, x).trim() ? " · déjà écrit" : ""}</option>`
      )
      .join("");
    f.week_start.value = weeks.includes(current) ? current : fallback;
    renderAiMovements("technique");
    renderAiMovements("force");
  } else {
    $("#aititle").textContent = "Générer le programme";
    $("#aiintro").textContent =
      "L’IA écrit le contenu de chaque WOD, semaine par semaine (" +
      weeks.length +
      " semaine" +
      (weeks.length > 1 ? "s" : "") +
      "). Les WOD manquants sont créés (« WOD 1 », « WOD 2 »…).";
    f.per_week.value = Math.min(7, Math.max(1, visibleWods(pid).length || 3));
  }
  ["echauffement", "technique", "force", "metcon", "retour_au_calme"].forEach(k => (f[k].onchange = syncAiForm));
  syncAiForm();
  $("#aidialog").showModal();
  try {
    const d = await sendApi("/ai-profile", "GET");
    for (const k of ["level", "goals", "equipment", "constraints"]) f[k].value = d.profile[k] || "";
    form.dataset.remaining = d.remaining;
    if (!d.enabled) {
      $("#aierror").textContent =
        "La génération par IA n’est pas encore activée : l’administrateur doit configurer la clé OpenAI.";
      $("#aisubmit").disabled = true;
    }
  } catch (e) {
    $("#aierror").textContent = e.offline ? OFFLINE_MESSAGE : e.message;
    $("#aisubmit").disabled = true;
  }
}
function aiRequest(f) {
  const picked = kind =>
    [...$("#aiform").querySelectorAll(`input[name="${kind}_movements"]:checked`)].map(i => i.value);
  return {
    duration_minutes: Number(f.duration_minutes.value),
    blocks: aiBlocks(f),
    technique_movements: $("#aiform").dataset.mode === "wod" && f.technique.checked ? picked("technique") : [],
    force_movements: $("#aiform").dataset.mode === "wod" && f.force.checked ? picked("force") : [],
    instructions: f.instructions.value.trim(),
  };
}
const aiGenerate = (wodId, week, request) =>
  sendApi("/wods/" + wodId + "/generate", "POST", {...request, week_start: week}, AI_TIMEOUT);
function aiProgress(t) {
  $("#aiprogress").hidden = false;
  $("#aiprogress").textContent = t;
}
// Programme complet : crée les WOD manquants, puis génère chaque WOD de chaque semaine, l’un après l’autre (le
// contenu déjà écrit sert de contexte au suivant, pour la progression et la variété).
async function generateProgram(f, request) {
  const pid = f.program_id.value,
    p = programs.find(x => x.id === pid),
    perWeek = Number(f.per_week.value),
    weeks = programWeeks(p);
  if (!Number.isInteger(perWeek) || perWeek < 1 || perWeek > 7) throw Error("Entre 1 et 7 WOD par semaine.");
  const targets = visibleWods(pid).slice(0, perWeek),
    names = new Set(visibleWods(pid).map(w => w.name.toLowerCase()));
  const slots = [];
  for (const week of weeks)
    for (let i = 0; i < perWeek; i++) {
      const w = targets[i];
      if (!w || f.replace.checked || !weeklyWodContent(w.id, week).trim()) slots.push({week, index: i});
    }
  if (!slots.length) throw Error("Tous les WOD ont déjà un contenu. Coche « Remplacer le contenu déjà écrit ».");
  const remaining = Number($("#aiform").dataset.remaining);
  if (slots.length > remaining)
    throw Error(
      slots.length + " générations nécessaires, il en reste " + remaining + " pour 24 h. Réduis le nombre de WOD."
    );
  if (
    !confirm("Générer " + slots.length + " WOD (" + weeks.length + " semaines) ? Cela peut prendre quelques minutes.")
  )
    return false;
  for (let i = targets.length; i < perWeek; i++) {
    let n = i + 1;
    while (names.has(("WOD " + n).toLowerCase())) n++;
    const name = "WOD " + n;
    aiProgress("Création de « " + name + " »…");
    const created = await sendApi("/programs/" + pid + "/wods", "POST", {
      name,
      planned_comment: "",
      activity_id: defaultActivity()?.id,
      duration_minutes: request.duration_minutes,
      is_tracked: true,
    });
    names.add(name.toLowerCase());
    targets.push({id: created.id, name});
  }
  let done = 0;
  for (const s of slots) {
    if (aiCancelled) break;
    const w = targets[s.index];
    aiProgress(
      "Génération " +
        (done + 1) +
        "/" +
        slots.length +
        " : " +
        w.name +
        ", semaine du " +
        fmt(s.week) +
        "… (ne ferme pas l’application)"
    );
    await aiGenerate(w.id, s.week, request);
    done++;
  }
  (window.cfExpandedWodProgramming || (window.cfExpandedWodProgramming = new Set())).add(targets[0].id);
  return aiCancelled ? "Génération interrompue : " + done + " WOD écrits." : done + " WOD générés.";
}
$("#aiform").onsubmit = async e => {
  e.preventDefault();
  if (aiRunning) return;
  const form = e.target,
    f = form.elements,
    request = aiRequest(f);
  $("#aierror").textContent = "";
  if (!navigator.onLine) {
    $("#aierror").textContent = OFFLINE_MESSAGE;
    return;
  }
  aiRunning = true;
  aiCancelled = false;
  $("#aisubmit").disabled = true;
  let message = null;
  try {
    await sendApi("/ai-profile", "PUT", {
      level: f.level.value,
      goals: f.goals.value,
      equipment: f.equipment.value,
      constraints: f.constraints.value,
    });
    if (form.dataset.mode === "wod") {
      aiProgress("Génération en cours… (jusqu’à une minute)");
      await aiGenerate(f.wod_id.value, f.week_start.value, request);
      (window.cfExpandedWodProgramming || (window.cfExpandedWodProgramming = new Set())).add(f.wod_id.value);
      message = "WOD généré : relis-le et ajuste-le si besoin.";
    } else message = await generateProgram(f, request);
  } catch (x) {
    $("#aierror").textContent = x.offline ? OFFLINE_MESSAGE : x.message;
  } finally {
    aiRunning = false;
    $("#aisubmit").disabled = false;
    $("#aiprogress").hidden = true;
  }
  if (message) {
    $("#aidialog").close();
    toast(message);
  }
  // Recharge aussi après une erreur : des WOD ont pu être créés ou générés avant elle.
  if (message !== false) {
    await load();
    switchView("programs");
  }
};
$("#closeai").onclick = () => {
  if (aiRunning && !confirm("Arrêter la génération ? Les WOD déjà écrits sont conservés.")) return;
  aiCancelled = true;
  $("#aidialog").close();
};
// Touche Échap pendant une génération : même confirmation que la croix.
$("#aidialog").oncancel = e => {
  if (aiRunning && !confirm("Arrêter la génération ? Les WOD déjà écrits sont conservés.")) e.preventDefault();
  else aiCancelled = true;
};
