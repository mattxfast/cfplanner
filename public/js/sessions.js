// FitFactory — chargement des données, semaine en cours, historique des séances.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

async function load() {
  try {
    const from = selectedWeekStart || mondayOf(today()),
      to = addDays(from, 6);
    const [a, mc, p, w, pr] = await Promise.all([
      api("/activities"),
      api("/movement-catalog"),
      api("/program-data"),
      api("/week-data?from=" + from + "&to=" + to),
      api("/prs"),
    ]);
    activities = a.activities;
    movementCatalog = mc.movements;
    programs = p.programs;
    wodsByProgram = p.wods;
    movementsByProgram = p.movements;
    weeklyWodPrograms = p.weeklyWodPrograms || [];
    sessions = w.sessions;
    movementChecks = w.checks;
    catalogChecks = w.catalogChecks || [];
    weeklyPlans = w.plans;
    weekCompetition = !!w.flags.find(x => x.week_start === from)?.competition;
    prRecords = pr.records;
    renderUserbar();
    $("#profileform").elements.first_name.value = user.first_name || "";
    $("#profileform").elements.last_name.value = user.last_name || "";
    $("#profileemail").value = user.email || "";
    renderSessions();
    renderPrs();
    renderPrograms();
    renderWeek();
    if (isAdmin) loadAdmin();
  } catch (e) {
    toast(e.message);
  }
}
async function loadSessions() {
  const from = selectedWeekStart || mondayOf(today()),
    to = addDays(from, 6),
    w = await api("/week-data?from=" + from + "&to=" + to);
  sessions = w.sessions;
  movementChecks = w.checks;
  catalogChecks = w.catalogChecks || [];
  weeklyPlans = w.plans;
  weekCompetition = !!w.flags.find(x => x.week_start === from)?.competition;
  renderSessions();
  renderWeek();
}
async function loadPrs() {
  prRecords = (await api("/prs")).records;
  renderPrs();
}
function switchView(v) {
  document.querySelectorAll(".navtab").forEach(b => b.classList.toggle("active", b.dataset.view === v));
  ["sessions", "programs", "prs", "timer", "account", "admin"].forEach(x => ($("#view-" + x).hidden = x !== v));
}
document.querySelectorAll(".navtab").forEach(b => (b.onclick = () => switchView(b.dataset.view)));
function renderSessions() {
  $("#sessionlist").classList.toggle("session-list-collapsed", !!window.cfSessionHistoryCollapsed);
  const historyToggle = $("#toggle-session-history");
  if (historyToggle) {
    historyToggle.textContent = window.cfSessionHistoryCollapsed ? "＋" : "−";
    historyToggle.setAttribute("aria-expanded", String(!window.cfSessionHistoryCollapsed));
    historyToggle.onclick = () => {
      window.cfSessionHistoryCollapsed = !window.cfSessionHistoryCollapsed;
      renderSessions();
    };
  }
  $("#sessionlist").innerHTML = sessions.length
    ? sessions
        .map(
          s =>
            `<article class="entry session-entry"><div class="session-history-content"><div class="session-history-heading"><div class="session-title-line"><span class="sessiondate">${fmt(s.session_date)}</span><h3>${esc(s.wod_name)}</h3></div><div class="entryactions"><button class="smallbtn" data-edit-session="${s.id}" aria-label="Modifier" title="Modifier"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg></button><button class="smallbtn delete" data-del-session="${s.id}" aria-label="Supprimer" title="Supprimer"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></div></div>${(() => {
              const weeklyContent =
                weeklyWodPrograms.find(x => x.wod_id === s.wod_id && x.week_start === mondayOf(s.session_date))
                  ?.content || "";
              const plannedContent = weeklyContent || s.planned_comment;
              return plannedContent
                ? `<p><b>${weeklyContent ? "Prévu cette semaine :" : "Prévu :"}</b> ${esc(plannedContent)}</p>`
                : "";
            })()}${s.actual_comment ? `<p><b>Réalisé :</b> ${esc(s.actual_comment)}</p>` : ""}</div></article>`
        )
        .join("")
    : `<div class="card empty">Aucune séance enregistrée cette semaine. Touche ＋ pour en ajouter une.</div>`;
  $("#sessionlist")
    .querySelectorAll("[data-edit-session]")
    .forEach(b => (b.onclick = () => openSession(sessions.find(s => s.id === b.dataset.editSession))));
  $("#sessionlist")
    .querySelectorAll("[data-del-session]")
    .forEach(
      b =>
        (b.onclick = async () => {
          if (confirm("Supprimer cette séance ?")) {
            await api("/sessions/" + b.dataset.delSession, {method: "DELETE"});
            await load(); // recharge aussi les programmes (un programme sans séance redevient supprimable)
          }
        })
    );
}
// Programme technique « Hors programme » (programme par défaut sans WOD visible ni mouvement) : jamais affiché comme un programme.
function isFallbackProgram(p) {
  return !!p?.is_default && !visibleWods(p.id).length && !(movementsByProgram[p.id] || []).length;
}
function programForDate(date) {
  return (
    programs.find(
      x =>
        !x.is_default &&
        !(x.start_monday === "1970-01-01" && x.end_monday === "2100-12-31") &&
        x.start_monday <= date &&
        x.end_monday >= date
    ) ||
    programs.find(x => !!x.is_default) ||
    null
  );
}
// Rubrique « Focus mouvement » de la semaine : mouvements du programme, ou à défaut (programme sans mouvement,
// séances hors programme) les mouvements du catalogue cochés dans les séances de la semaine.
function weekMovementsSection(week, programMovements, folded) {
  // Avec un programme : ses mouvements (y compris à 0×), plus tout autre mouvement coché dans les séances de la semaine.
  // Sans programme (ou programme sans mouvement) : uniquement les mouvements cochés dans les séances de la semaine.
  // Les mouvements sont regroupés par nom ; chaque séance compte une fois par mouvement.
  const key = name =>
      String(name || "")
        .trim()
        .toLowerCase(),
    allProgramMovements = Object.values(movementsByProgram).flat(),
    items = new Map();
  for (const m of programMovements)
    if (!items.has(key(m.name))) items.set(key(m.name), {movement: {name: m.name}, count: 0, base: true});
  for (const s of week) {
    const names = new Set(
      [
        ...movementChecks
          .filter(c => c.session_id === s.id)
          .map(c => allProgramMovements.find(m => m.id === c.movement_id)?.name),
        ...catalogChecks
          .filter(c => c.session_id === s.id)
          .map(c => movementCatalog.find(m => m.id === c.catalog_movement_id)?.name),
      ]
        .filter(Boolean)
        .map(key)
    );
    for (const k of names) {
      if (!items.has(k)) {
        const name =
          allProgramMovements.find(m => key(m.name) === k)?.name || movementCatalog.find(m => key(m.name) === k)?.name;
        items.set(k, {movement: {name}, count: 0, base: false});
      }
      items.get(k).count++;
    }
  }
  const movementCounts = [...items.values()],
    baseItems = movementCounts.filter(x => x.base);
  return `<section class="weekother session-fold ${folded.has("movements") ? "collapsed" : ""}" data-session-fold="movements"><div class="weekheading"><button class="smallbtn section-collapse" aria-label="Replier les mouvements" aria-expanded="${!folded.has("movements")}">${folded.has("movements") ? "＋" : "−"}</button><h2>Focus mouvement</h2><span>${programMovements.length ? baseItems.filter(x => x.count > 0).length + "/" + baseItems.length : movementCounts.length}</span></div><div class="session-fold-body"><div class="weekwodlist">${movementCounts.length ? movementCounts.map(x => `<article class="weekwod card ${x.count ? "done" : ""}"><b>${esc(x.movement.name)}</b><div class="weekcount"><strong>${x.count}×</strong></div></article>`).join("") : `<p class="muted">${programMovements.length ? "Aucun mouvement défini dans ce programme." : "Aucun mouvement travaillé cette semaine."}</p>`}</div></div></section>`;
}
function renderWeek() {
  const now = today();
  if (!selectedWeekStart) selectedWeekStart = mondayOf(now);
  const from = selectedWeekStart,
    to = addDays(from, 6),
    future = from > mondayOf(now),
    dateInput = addDays(from, 0);
  const p = programForDate(from);
  const week = sessions.filter(x => x.session_date >= from && x.session_date <= to);
  const folded = window.cfSessionFolded || (window.cfSessionFolded = new Set());
  const nav = `<div class="weeknav"><button class="smallbtn" id="prevweek" aria-label="Semaine précédente" title="Semaine précédente">‹</button><label class="weekdate-label">Semaine du <input id="weekdate" type="date" value="${dateInput}" max="${now}"></label><button class="smallbtn" id="nextweek" aria-label="Semaine suivante" title="Semaine suivante">›</button></div>`;
  if (future && (!p || isFallbackProgram(p))) {
    $("#weekboard").innerHTML =
      `<div class="weekbar card">${nav}</div><div class="card empty">Cette semaine est dans le futur. La saisie d’entraînements n’est pas autorisée.</div>`;
  } else if (!p || isFallbackProgram(p)) {
    // Semaine sans programme : les séances sont enregistrées « hors programme ».
    $("#weekboard").innerHTML =
      `<div class="weekbar card">${nav}</div><div class="weekstats card"><div class="weekstat weekstat-sessions"><strong>${week.length}</strong><span>Nombre de séances</span></div><button id="addsession" class="primary addsession-compact" aria-label="Ajouter une séance" title="Ajouter une séance">＋</button><label class="competition-toggle"><span>Comp</span><input type="checkbox" id="weekcompetition" ${weekCompetition ? "checked" : ""}></label></div>${weekMovementsSection(week, [], folded)}`;
  } else {
    const ws = visibleWods(p.id),
      countFor = w => week.filter(x => x.wod_id === w.id).length,
      done = ws.filter(w => countFor(w) > 0);
    const programMovements = movementsByProgram[p.id] || [];
    $("#weekboard").innerHTML =
      `<div class="weekbar card">${nav}</div><div class="weekstats card"><div class="weekstat weekstat-sessions"><strong>${week.length}</strong><span>Nombre de séances</span></div><div class="weekstat weekstat-program"><strong>${done.length}/${ws.length}</strong><span>Nombre de séances de la programmation</span></div><button id="addsession" class="primary addsession-compact" aria-label="Ajouter une séance" title="Ajouter une séance" ${future ? "disabled" : ""}>＋</button><label class="competition-toggle"><span>Comp</span><input type="checkbox" id="weekcompetition" ${weekCompetition ? "checked" : ""}></label></div><section class="session-fold ${folded.has("wods") ? "collapsed" : ""}" data-session-fold="wods"><div class="weekheading"><button class="smallbtn section-collapse" aria-label="Replier les WOD" aria-expanded="${!folded.has("wods")}">${folded.has("wods") ? "＋" : "−"}</button><h2>WOD de la programmation</h2><span>${done.length}/${ws.length}</span></div><div class="session-fold-body"><div class="weekwodlist">${
        ws.length
          ? ws
              .map(w => {
                const n = countFor(w);
                const planned = weeklyPlans.some(x => x.wod_id === w.id);
                return `<article class="weekwod card ${n ? "done" : planned ? "planned" : ""}"><div><b>${esc(w.name)}</b>${(() => {
                  const content = weeklyWodContent(w.id, from);
                  const display = content || w.planned_comment;
                  return display ? `<p>${esc(display)}</p>` : "";
                })()}</div><div class="weekcount"><strong>${n}×</strong><button class="smallbtn" data-log-wod="${w.id}" aria-label="Ajouter une séance" title="Ajouter une séance"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg></button>${planned && !n ? `<button class="smallbtn delete" data-unplan-wod="${w.id}" aria-label="Supprimer la planification" title="Supprimer la planification"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button>` : ""}</div></article>`;
              })
              .join("")
          : `<div class="card empty">Aucun WOD dans ce programme.</div>`
      }</div></div></section>${weekMovementsSection(week, programMovements, folded)}`;
  }
  $("#weekboard")
    .querySelectorAll("[data-session-fold]")
    .forEach(section => {
      const button = section.querySelector(".section-collapse");
      button.onclick = () => {
        const key = section.dataset.sessionFold;
        if (folded.has(key)) folded.delete(key);
        else folded.add(key);
        section.classList.toggle("collapsed", folded.has(key));
        button.textContent = folded.has(key) ? "＋" : "−";
        button.setAttribute("aria-expanded", String(!folded.has(key)));
      };
    });
  $("#prevweek").onclick = () => changeWeek(addDays(from, -7));
  $("#nextweek").onclick = () => changeWeek(addDays(from, 7));
  $("#weekdate").onchange = e => changeWeek(mondayOf(e.target.value));
  $("#weekboard")
    .querySelectorAll("[data-log-wod]")
    .forEach(b => (b.onclick = () => openWodChoice(b.dataset.logWod)));
  $("#weekboard")
    .querySelectorAll("[data-unplan-wod]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const id = b.dataset.unplanWod;
          try {
            await api("/weekly-plans", {method: "DELETE", body: JSON.stringify({week_start: from, wod_id: id})});
            await changeWeek(from);
            toast("Planification supprimée.");
          } catch (e) {
            toast(e.message);
          }
        })
    );
  const addButton = $("#addsession");
  if (addButton) addButton.onclick = addSessionFromWeek;
  const competition = $("#weekcompetition");
  if (competition)
    competition.onchange = async e => {
      try {
        await api("/weekly-flags", {
          method: "PUT",
          body: JSON.stringify({week_start: from, competition: e.target.checked}),
        });
        weekCompetition = e.target.checked;
      } catch (err) {
        e.target.checked = !e.target.checked;
        toast(err.message);
      }
    };
}
async function changeWeek(start) {
  selectedWeekStart = start;
  await loadSessions();
}
