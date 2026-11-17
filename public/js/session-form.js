// FitFactory — saisie et modification d’une séance, planification d’un WOD.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

function defaultActivity() {
  return activities.find(a => a.is_default) || activities[0];
}
function fillActivitySelect(select, selected = "") {
  select.innerHTML = activities
    .filter(a => a.is_active)
    .map(a => `<option value="${a.id}">${esc(a.name)}</option>`)
    .join("");
  if (selected) select.value = selected;
  else if (defaultActivity()) select.value = defaultActivity().id;
}
function fillWodOptions(pid, selected = "") {
  const f = $("#sessionform").elements.wod_id,
    ws = wodsByProgram[pid] || [];
  f.innerHTML =
    ws
      .filter(w => w.name !== "__AUTRES__")
      .map(w => `<option value="${w.id}">${esc(w.name)}</option>`)
      .join("") + `<option value="other">Autres</option>`;
  if (selected) f.value = selected === "other" ? "other" : selected;
  renderSessionMovementChecks(pid);
}
$("#sessionform").elements.program_id.onchange = e => {
  fillWodOptions(e.target.value);
  const w = (wodsByProgram[e.target.value] || [])[0];
  fillActivitySelect($("#sessionform").elements.activity_id, w?.activity_id || defaultActivity()?.id);
  $("#sessionform").elements.duration_minutes.value = w?.duration_minutes || defaultActivity()?.duration_minutes || 60;
  applyPlannedSessionNote();
};
function applyPlannedSessionNote() {
  const f = $("#sessionform"),
    field = f.elements.actual_comment,
    previous = field.dataset.plannedDefault || "";
  if (field.value === previous || !field.value.trim()) {
    const wod = (wodsByProgram[f.elements.program_id.value] || []).find(x => x.id === f.elements.wod_id.value);
    const week = mondayOf(f.elements.session_date.value || today());
    const planned = wod ? weeklyWodContent(wod.id, week) || wod.planned_comment || "" : "";
    field.value = planned;
    field.dataset.plannedDefault = planned;
  }
}
$("#sessionform").elements.wod_id.onchange = e => {
  const w = (wodsByProgram[$("#sessionform").elements.program_id.value] || []).find(x => x.id === e.target.value);
  if (w) {
    fillActivitySelect($("#sessionform").elements.activity_id, w.activity_id || defaultActivity()?.id);
    $("#sessionform").elements.duration_minutes.value = w.duration_minutes || defaultActivity()?.duration_minutes || 60;
  }
  applyPlannedSessionNote();
};
$("#sessionform").elements.session_date.onchange = applyPlannedSessionNote;
function renderSessionMovementChecks(pid, sessionId = "") {
  const box = $("#sessionmovementchecks"),
    programItems = movementsByProgram[pid] || [],
    fromCatalog = !programItems.length,
    items = fromCatalog ? movementCatalog : programItems,
    field = fromCatalog ? "catalog_movement_ids" : "movement_ids",
    isChecked = m =>
      fromCatalog
        ? catalogChecks.some(c => c.session_id === sessionId && c.catalog_movement_id === m.id)
        : movementChecks.some(c => c.session_id === sessionId && c.movement_id === m.id);
  $("#sessionmovementsection").hidden = !items.length;
  box.innerHTML = items
    .map(
      m =>
        `<label class="movement-check"><input type="checkbox" name="${field}" value="${esc(m.id)}" ${isChecked(m) ? "checked" : ""}><span>${esc(m.name)}</span></label>`
    )
    .join("");
}
function openSession(s = null, presetWodId = "") {
  const f = $("#sessionform");
  f.reset();
  f.elements.session_date.max = today();
  f.elements.session_id.value = s?.id || "";
  f.elements.actual_comment.value = s?.actual_comment || "";
  f.elements.actual_comment.dataset.plannedDefault = "";
  const weekEnd = addDays(selectedWeekStart, 6),
    defaultDate = selectedWeekStart > today() ? today() : weekEnd < today() ? weekEnd : today(),
    sessionDate = s?.session_date || defaultDate;
  f.elements.session_date.value = sessionDate;
  f.elements.program_id.innerHTML = programs
    .map(p => `<option value="${p.id}">${esc(p.name)}${p.is_default ? " (par défaut)" : ""}</option>`)
    .join("");
  let selectedProgram = s ? programs.find(p => p.id === s.program_id) : null;
  if (!selectedProgram && presetWodId)
    selectedProgram = programs.find(p => (wodsByProgram[p.id] || []).some(x => x.id === presetWodId));
  if (!selectedProgram) selectedProgram = programForDate(sessionDate);
  if (selectedProgram) f.elements.program_id.value = selectedProgram.id;
  const pid = f.elements.program_id.value;
  fillWodOptions(pid, s?.wod_name === "Autres" ? "other" : s?.wod_id || presetWodId);
  const selectedWod = (wodsByProgram[pid] || []).find(w => w.id === (s?.wod_id || presetWodId));
  fillActivitySelect(f.elements.activity_id, s?.activity_id || selectedWod?.activity_id || defaultActivity()?.id);
  f.elements.duration_minutes.value =
    s?.duration_minutes || selectedWod?.duration_minutes || defaultActivity()?.duration_minutes || 60;
  const defaultStart = new Date(Date.now() - Number(f.elements.duration_minutes.value) * 60000);
  f.elements.start_time.value = s?.started_at
    ? new Date(s.started_at).toLocaleTimeString("fr-FR", {hour: "2-digit", minute: "2-digit", hour12: false})
    : defaultStart.toLocaleTimeString("fr-FR", {hour: "2-digit", minute: "2-digit", hour12: false});
  f.elements.start_time.dataset.manual = "";
  f.elements.start_time.onchange = () => {
    f.elements.start_time.dataset.manual = "1";
  };
  f.elements.duration_minutes.oninput = () => {
    if (!f.elements.start_time.dataset.manual) {
      const d = new Date(Date.now() - Number(f.elements.duration_minutes.value || 0) * 60000);
      f.elements.start_time.value = d.toLocaleTimeString("fr-FR", {hour: "2-digit", minute: "2-digit", hour12: false});
    }
  };
  renderSessionMovementChecks(pid, s?.id || "");
  if (!s) applyPlannedSessionNote();
  $("#sessiontitle").textContent = s ? "Modifier la séance" : "Enregistrer une séance";
  $("#sessiondialog").showModal();
}
let choiceWodId = "";
function openWodChoice(wodId) {
  const planned = weeklyPlans.some(x => x.wod_id === wodId);
  if (selectedWeekStart < mondayOf(today())) {
    openSession(null, wodId);
    return;
  }
  if (planned) {
    if (selectedWeekStart > mondayOf(today())) {
      toast("Cette séance est planifiée pour une semaine future.");
      return;
    }
    openSession(null, wodId);
    return;
  }
  choiceWodId = wodId;
  const w = programs.flatMap(p => wodsByProgram[p.id] || []).find(x => x.id === wodId);
  $("#wodchoicetitle").textContent = w?.name || "Que souhaites-tu faire ?";
  $("#choice-record").disabled = selectedWeekStart > mondayOf(today());
  $("#choice-plan").textContent = "Planifier";
  $("#wodchoice").showModal();
}
$("#closewodchoice").onclick = () => $("#wodchoice").close();
$("#choice-record").onclick = () => {
  const id = choiceWodId;
  $("#wodchoice").close();
  openSession(null, id);
};
$("#choice-plan").onclick = async () => {
  const id = choiceWodId;
  try {
    await api("/weekly-plans", {method: "POST", body: JSON.stringify({week_start: selectedWeekStart, wod_id: id})});
    $("#wodchoice").close();
    await changeWeek(selectedWeekStart);
    toast("WOD planifié.");
  } catch (e) {
    toast(e.message);
  }
};
function addSessionFromWeek() {
  if (selectedWeekStart > mondayOf(today())) {
    toast("Impossible de saisir une séance sur une semaine future.");
    return;
  }
  if (!programs.length) {
    toast("Crée un programme.");
    switchView("programs");
    return;
  }
  if (!programs.some(p => (wodsByProgram[p.id] || []).length)) {
    toast("Ajoute un WOD au programme.");
    switchView("programs");
    return;
  }
  openSession();
}
$("#closesession").onclick = () => $("#sessiondialog").close();
async function saveSession(event) {
  if (event) event.preventDefault();
  const form = $("#sessionform");
  if (!form.reportValidity()) return;
  const f = new FormData(form),
    id = f.get("session_id");
  if (f.get("session_date") > today()) {
    $("#sessionerror").textContent = "Impossible d’enregistrer une séance à une date future.";
    return;
  }
  const button = $("#savesession");
  button.disabled = true;
  $("#sessionerror").textContent = "";
  const body = {
    program_id: f.get("program_id"),
    wod_id: f.get("wod_id"),
    session_date: f.get("session_date"),
    activity_id: f.get("activity_id"),
    duration_minutes: Number(f.get("duration_minutes")),
    started_at: new Date(f.get("session_date") + "T" + f.get("start_time")).toISOString(),
    actual_comment: f.get("actual_comment"),
    movement_ids: [...form.querySelectorAll('input[name="movement_ids"]:checked')].map(x => x.value),
    catalog_movement_ids: [...form.querySelectorAll('input[name="catalog_movement_ids"]:checked')].map(x => x.value),
  };
  try {
    await api(id ? "/sessions/" + id : "/sessions", {method: id ? "PUT" : "POST", body: JSON.stringify(body)});
    await api("/weekly-plans", {
      method: "DELETE",
      body: JSON.stringify({week_start: mondayOf(body.session_date), wod_id: body.wod_id}),
    });
    $("#sessiondialog").close();
    selectedWeekStart = mondayOf(body.session_date);
    await loadSessions();
    renderWeek();
    toast(id ? "Séance modifiée." : "Séance enregistrée.");
  } catch (x) {
    $("#sessionerror").textContent = x.message;
  } finally {
    button.disabled = false;
  }
}
$("#sessionform").onsubmit = saveSession;
$("#savesession").onclick = () => saveSession();
