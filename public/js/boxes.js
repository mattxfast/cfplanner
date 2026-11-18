// FitFactory — box : adhésions (Mon compte) et espace gestionnaire (icône maison en haut, pages WOD, membres et infos).
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

let boxes = [],
  boxMemberships = [],
  boxCategories = [],
  managedBoxId = "",
  managedBox = null,
  managedWodWeek = "",
  boxCategoryReorder = false;
const SCORE_LABELS = {time: "Temps (For Time)", reps: "Répétitions (AMRAP)", load: "Charge (kg)", none: "Sans score"};
const defaultWodName = date => "WOD du " + fmt(date);
// WOD de box déjà chargés (semaine affichée, formulaire de séance, séances) : nom et type de score hors ligne.
const boxWodsById = new Map();
function rememberBoxWods(list) {
  for (const w of list || []) boxWodsById.set(w.id, {...boxWodsById.get(w.id), ...w});
  return list || [];
}
const memberBoxIds = () => boxIds("member");
// Score affiché : temps en min:s (h:min:s au-delà d’une heure), répétitions ou charge en kg.
function formatScore(type, value) {
  if (value === null || value === undefined || value === "") return "";
  const v = Number(value);
  if (type === "time") {
    const h = Math.floor(v / 3600),
      mn = Math.floor((v % 3600) / 60),
      sec = String(v % 60).padStart(2, "0");
    return h ? h + ":" + String(mn).padStart(2, "0") + ":" + sec : mn + ":" + sec;
  }
  if (type === "reps") return v + " rép.";
  if (type === "load") return v.toLocaleString("fr-FR") + " kg";
  return String(v);
}
const TROPHY_ICON =
  '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M8 4h8v5a4 4 0 0 1-8 0z"/><path d="M8 6H5a3 3 0 0 0 3 4M16 6h3a3 3 0 0 1-3 4M12 13v4M9 20.5h6"/></svg>';
const wodDay = date =>
  new Intl.DateTimeFormat("fr-FR", {weekday: "short", day: "2-digit", month: "2-digit"}).format(
    new Date(date + "T12:00:00")
  );
const boxFolded = new Set();
const BOX_ICONS = {
  edit: '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg>',
  del: '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg>',
  ok: '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
  up: '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg>',
  down: '<svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg>',
};
const personName = x => [x.first_name, x.last_name].filter(Boolean).join(" ") || x.email || "";
const boxName = id => boxes.find(b => b.id === id)?.name || "";
const boxIds = (role, status = "approved") =>
  boxMemberships.filter(m => m.role === role && m.status === status).map(m => m.box_id);

function setBoxes(d) {
  boxes = d.boxes || [];
  boxMemberships = d.memberships || [];
  boxCategories = d.categories || [];
  renderMyBoxes();
  renderBoxNav();
}
async function loadBoxes() {
  setBoxes(await api("/boxes"));
}

// ----- Mon compte : mes box et demandes -----
function renderMyBoxes() {
  const label = m =>
    m.role === "manager"
      ? m.status === "pending"
        ? "gestionnaire · en attente de validation par un administrateur"
        : "gestionnaire"
      : m.status === "pending"
        ? "membre · en attente de validation par la box"
        : "membre";
  const rows = [...boxMemberships].sort(
    (a, b) => boxName(a.box_id).localeCompare(boxName(b.box_id), "fr") || a.role.localeCompare(b.role)
  );
  $("#myboxlist").innerHTML = rows.length
    ? rows
        .map(
          m =>
            `<div class="admin-row"><span>${esc(boxName(m.box_id))} <small class="muted">· ${label(m)}</small></span><button type="button" class="smallbtn delete" data-leave-box="${m.box_id}" data-role="${m.role}" aria-label="${m.status === "pending" ? "Annuler la demande" : "Quitter"}" title="${m.status === "pending" ? "Annuler la demande" : m.role === "manager" ? "Ne plus gérer cette box" : "Quitter la box"}">${BOX_ICONS.del}</button></div>`
        )
        .join("")
    : `<p class="muted">Tu n’as rejoint aucune box.</p>`;
  const select = $("#boxjoinselect"),
    previous = select.value;
  select.innerHTML = boxes.length
    ? boxes.map(b => `<option value="${b.id}">${esc(b.name)}${b.city ? " · " + esc(b.city) : ""}</option>`).join("")
    : `<option value="">Aucune box disponible</option>`;
  if (boxes.some(b => b.id === previous)) select.value = previous;
  select.disabled = $("#boxjoin").disabled = $("#boxmanagerrequest").disabled = !boxes.length;
  $("#myboxlist")
    .querySelectorAll("[data-leave-box]")
    .forEach(
      b =>
        (b.onclick = () => {
          const m = boxMemberships.find(x => x.box_id === b.dataset.leaveBox && x.role === b.dataset.role);
          const question =
            m.status === "pending"
              ? "Annuler cette demande ?"
              : m.role === "manager"
                ? "Ne plus gérer « " + boxName(m.box_id) + " » ?"
                : "Quitter « " + boxName(m.box_id) + " » ? Il faudra refaire une demande pour la rejoindre.";
          if (confirm(question)) boxRequest(m.box_id, m.role, "DELETE");
        })
    );
}
async function boxRequest(boxId, role, method) {
  $("#boxjoinerror").textContent = "";
  try {
    await api("/boxes/" + boxId + "/requests", {method, body: JSON.stringify({role})});
    await loadBoxes();
    toast(method === "DELETE" ? "C’est fait." : "Demande envoyée : elle doit maintenant être validée.");
  } catch (e) {
    $("#boxjoinerror").textContent = e.message;
  }
}
function requestBox(role) {
  const id = $("#boxjoinselect").value;
  if (!id) return;
  if (boxMemberships.some(m => m.box_id === id && m.role === role)) {
    $("#boxjoinerror").textContent =
      role === "manager" ? "Tu as déjà demandé à gérer cette box." : "Tu as déjà demandé à rejoindre cette box.";
    return;
  }
  boxRequest(id, role, "POST");
}
$("#boxjoin").onclick = () => requestBox("member");
$("#boxmanagerrequest").onclick = () => requestBox("manager");

// ----- Espace gestionnaire (icône en haut) : pages WOD, membres et infos de la box, avec leur menu du bas -----
let boxPage = "wods";
function renderBoxNav() {
  const ids = boxIds("manager");
  if (!ids.length && inManagerSpace()) switchView("sessions");
  if (!ids.includes(managedBoxId)) {
    managedBoxId = ids[0] || "";
    managedBox = null;
  }
  $("#managedboxpicker").hidden = ids.length < 2;
  $("#managedboxselect").innerHTML = ids.map(id => `<option value="${id}">${esc(boxName(id))}</option>`).join("");
  $("#managedboxselect").value = managedBoxId;
  if (inManagerSpace()) loadManagedBox();
  if (user) renderUserbar();
}
document.querySelectorAll("[data-box-page]").forEach(
  b =>
    (b.onclick = () => {
      boxPage = b.dataset.boxPage;
      renderManagedBox();
      scrollTo(0, 0);
    })
);
$("#managedboxselect").onchange = e => {
  managedBoxId = e.target.value;
  managedBox = null;
  loadManagedBox();
};
async function loadManagedBox() {
  if (!managedBoxId) {
    $("#boxmanager").innerHTML = "";
    return;
  }
  if (!managedWodWeek) managedWodWeek = mondayOf(today());
  const id = managedBoxId,
    week = managedWodWeek;
  try {
    const [d, w] = await Promise.all([
      api("/manage/boxes/" + id),
      api("/manage/boxes/" + id + "/wods?from=" + week + "&to=" + addDays(week, 6)),
    ]);
    if (id !== managedBoxId || week !== managedWodWeek) return;
    managedBox = {...d, wods: w.wods};
    renderManagedBox();
  } catch (e) {
    toast(e.message);
  }
}
// Rubrique repliable au style des rubriques d’administration.
function boxGroup(key, title, actions, body) {
  const folded = boxFolded.has(key);
  return `<section class="admin-group ${folded ? "collapsed" : ""}" data-box-group="${key}"><div class="admin-group-title" role="button" tabindex="0" aria-expanded="${!folded}"><span class="admin-collapse-indicator">${folded ? "＋" : "−"}</span><span>${title}</span>${actions}</div><div class="admin-group-body"><div class="admin-data-list">${body}</div></div></section>`;
}
// WOD de la box : navigation par semaine (WOD passés et à venir), ajout, modification, suppression.
function boxWodsGroup(d) {
  // Comme la page Séances : la semaine en bandeau principal, les WOD dessous, « Nouveau WOD » en bas.
  const week = managedWodWeek,
    nav = `<div class="weekbar card"><div class="weeknav"><button type="button" class="smallbtn" id="boxwodprev" aria-label="Semaine précédente" title="Semaine précédente">‹</button><label class="weekdate-label">Semaine du <input id="boxwodweek" type="date" value="${week}"></label><button type="button" class="smallbtn" id="boxwodnext" aria-label="Semaine suivante" title="Semaine suivante">›</button></div></div>`;
  return `<div id="boxwodboard">${nav}<div class="admin-data-list">${
    d.wods
      .map(
        w =>
          `<div class="admin-row box-wod-row"><span><b>${esc(wodDay(w.wod_date))} · ${esc(w.name)}</b> <span class="tracked-tag">${esc(SCORE_LABELS[w.score_type] || "")}</span>${w.content ? `<small class="box-wod-content">${esc(w.content)}</small>` : ""}</span><span class="admin-row-actions"><button class="smallbtn" data-edit-boxwod="${w.id}" aria-label="Modifier" title="Modifier">${BOX_ICONS.edit}</button><button class="smallbtn delete" data-del-boxwod="${w.id}" aria-label="Supprimer" title="Supprimer">${BOX_ICONS.del}</button></span></div>`
      )
      .join("") || `<div class="card empty">Aucun WOD cette semaine.</div>`
  }</div><div class="bottom-action"><button type="button" class="primary" id="addboxwod">＋ Nouveau WOD</button></div></div>`;
}
function openBoxWod(w = null) {
  const f = $("#boxwodform"),
    now = today(),
    weekEnd = addDays(managedWodWeek, 6);
  f.reset();
  f.elements.id.value = w?.id || "";
  f.elements.wod_date.value = w?.wod_date || (now >= managedWodWeek && now <= weekEnd ? now : managedWodWeek);
  f.elements.name.value = w?.name && w.name !== defaultWodName(w.wod_date) ? w.name : "";
  f.elements.name.placeholder = defaultWodName(f.elements.wod_date.value);
  f.elements.score_type.value = w?.score_type || "time";
  f.elements.content.value = w?.content || "";
  $("#boxwoddialogtitle").textContent = w ? "Modifier le WOD" : "Ajouter un WOD";
  $("#boxwoderror").textContent = "";
  $("#boxwoddialog").showModal();
}
$("#boxwodform").elements.wod_date.onchange = e =>
  ($("#boxwodform").elements.name.placeholder = defaultWodName(e.target.value || today()));
$("#boxwodform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target.elements,
    id = f.id.value,
    body = {
      wod_date: f.wod_date.value,
      name: f.name.value.trim(),
      score_type: f.score_type.value,
      content: f.content.value,
    };
  if (!id) body.client_id = crypto.randomUUID?.();
  try {
    await api(id ? "/manage/wods/" + id : "/manage/boxes/" + managedBoxId + "/wods", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    $("#boxwoddialog").close();
    managedWodWeek = mondayOf(body.wod_date);
    await loadManagedBox();
    toast(id ? "WOD modifié." : "WOD ajouté.");
  } catch (x) {
    $("#boxwoderror").textContent = x.message;
  }
};
function changeManagedWodWeek(week) {
  managedWodWeek = week;
  loadManagedBox();
}
function renderManagedBox() {
  document
    .querySelectorAll("[data-box-page]")
    .forEach(b => b.classList.toggle("active", b.dataset.boxPage === boxPage));
  const d = managedBox;
  if (!d) return;
  const pending = d.members.filter(x => x.status === "pending"),
    members = d.members.filter(x => x.status === "approved"),
    cats = d.categories;
  const person = x => `${esc(personName(x))} <small class="muted">${esc(x.email)}</small>`;
  const membersPage = () =>
    boxGroup(
      "requests",
      `Demandes d’adhésion (${pending.length})`,
      "",
      pending
        .map(
          x =>
            `<div class="admin-row"><span>${person(x)}</span><span class="admin-row-actions"><button class="smallbtn" data-member-decision="1" data-user="${x.user_id}" aria-label="Valider" title="Valider l’adhésion">${BOX_ICONS.ok}</button><button class="smallbtn delete" data-member-decision="0" data-user="${x.user_id}" aria-label="Refuser" title="Refuser la demande">${BOX_ICONS.del}</button></span></div>`
        )
        .join("") || `<p class="muted">Aucune demande en attente.</p>`
    ) +
    boxGroup(
      "members",
      `Membres (${members.length})`,
      "",
      members
        .map(
          x =>
            `<div class="admin-row"><span>${person(x)}${x.is_manager ? ` <span class="tracked-tag">Gestionnaire</span>` : ""}</span><span class="admin-row-actions"><button class="smallbtn delete" data-remove-member="${x.user_id}" aria-label="Retirer de la box" title="${x.is_manager ? "Un gestionnaire ne peut pas être retiré" : "Retirer de la box"}" ${x.is_manager ? "disabled" : ""}>${BOX_ICONS.del}</button></span></div>`
        )
        .join("") || `<p class="muted">Aucun membre.</p>`
    );
  const infoPage = () =>
    boxGroup(
      "info",
      "Box",
      "",
      `<form id="boxinfoform" class="box-info-form"><label>Nom de la box<input name="name" maxlength="80" required value="${esc(d.box.name)}"></label><label>Ville<input name="city" maxlength="80" value="${esc(d.box.city || "")}"></label><button class="primary">Enregistrer</button></form>`
    ) +
    boxGroup(
      "categories",
      "Catégories",
      `${cats.length > 1 ? `<button type="button" class="smallbtn reorder-toggle ${boxCategoryReorder ? "active" : ""}" id="toggle-category-reorder" aria-pressed="${boxCategoryReorder}" aria-label="Réorganiser les catégories" title="Réorganiser les catégories">⇅</button>` : ""}<button type="button" class="admin-add" id="addcategory" aria-label="Ajouter une catégorie">＋</button>`,
      cats
        .map(
          (c, i) =>
            `<div class="admin-row"><span>${esc(c.name)}</span><span class="admin-row-actions">${boxCategoryReorder ? `<button class="smallbtn admin-reorder" data-move-category="${c.id}" data-direction="-1" aria-label="Monter" title="Monter" ${i === 0 ? "disabled" : ""}>${BOX_ICONS.up}</button><button class="smallbtn admin-reorder" data-move-category="${c.id}" data-direction="1" aria-label="Descendre" title="Descendre" ${i === cats.length - 1 ? "disabled" : ""}>${BOX_ICONS.down}</button>` : ""}<button class="smallbtn" data-edit-category="${c.id}" aria-label="Renommer" title="Renommer">${BOX_ICONS.edit}</button><button class="smallbtn delete" data-del-category="${c.id}" aria-label="Supprimer" title="Supprimer">${BOX_ICONS.del}</button></span></div>`
        )
        .join("") || `<p class="muted">Aucune catégorie.</p>`
    );
  $("#boxmanager").innerHTML =
    boxPage === "members" ? membersPage() : boxPage === "info" ? infoPage() : boxWodsGroup(d);
  bindManagedBox();
}
async function boxAction(path, method, body, message) {
  try {
    await api(path, {method, body: body ? JSON.stringify(body) : undefined});
    await loadManagedBox();
    if (message) toast(message);
  } catch (e) {
    toast(e.message);
  }
}
function bindManagedBox() {
  const root = $("#boxmanager"),
    d = managedBox;
  root.querySelectorAll("[data-box-group] > .admin-group-title").forEach(h => {
    const toggle = () => {
      const key = h.parentElement.dataset.boxGroup;
      if (boxFolded.has(key)) boxFolded.delete(key);
      else boxFolded.add(key);
      renderManagedBox();
    };
    h.onclick = e => {
      if (!e.target.closest("button")) toggle();
    };
    h.onkeydown = e => {
      if (e.target === h && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        toggle();
      }
    };
  });
  root.querySelectorAll("[data-member-decision]").forEach(
    b =>
      (b.onclick = () => {
        const approve = b.dataset.memberDecision === "1";
        if (!approve && !confirm("Refuser cette demande d’adhésion ?")) return;
        boxAction(
          "/manage/boxes/" + d.box.id + "/members/" + b.dataset.user,
          "PUT",
          {approve},
          approve ? "Adhésion validée." : "Demande refusée."
        );
      })
  );
  root.querySelectorAll("[data-remove-member]").forEach(
    b =>
      (b.onclick = () => {
        const x = d.members.find(m => m.user_id === b.dataset.removeMember);
        if (confirm("Retirer " + personName(x) + " de la box ?"))
          boxAction("/manage/boxes/" + d.box.id + "/members/" + x.user_id, "DELETE", null, "Membre retiré.");
      })
  );
  if (boxPage === "wods") {
    $("#addboxwod").onclick = () => openBoxWod();
    $("#boxwodprev").onclick = () => changeManagedWodWeek(addDays(managedWodWeek, -7));
    $("#boxwodnext").onclick = () => changeManagedWodWeek(addDays(managedWodWeek, 7));
    $("#boxwodweek").onchange = e => e.target.value && changeManagedWodWeek(mondayOf(e.target.value));
  }
  const info = $("#boxinfoform");
  if (info)
    info.onsubmit = async e => {
      e.preventDefault();
      const f = e.target.elements;
      await boxAction(
        "/manage/boxes/" + d.box.id,
        "PUT",
        {name: f.name.value, city: f.city.value},
        "Infos de la box enregistrées."
      );
      loadBoxes().catch(() => {});
    };
  root
    .querySelectorAll("[data-edit-boxwod]")
    .forEach(b => (b.onclick = () => openBoxWod(d.wods.find(w => w.id === b.dataset.editBoxwod))));
  root.querySelectorAll("[data-del-boxwod]").forEach(
    b =>
      (b.onclick = () => {
        const w = d.wods.find(x => x.id === b.dataset.delBoxwod);
        if (confirm("Supprimer « " + w.name + " » ?"))
          boxAction("/manage/wods/" + w.id, "DELETE", null, "WOD supprimé.");
      })
  );
  const add = $("#addcategory");
  if (add)
    add.onclick = () => {
      const name = prompt("Nom de la nouvelle catégorie :", "");
      if (name && name.trim())
        boxAction(
          "/manage/boxes/" + d.box.id + "/categories",
          "POST",
          {name: name.trim(), client_id: crypto.randomUUID?.()},
          "Catégorie ajoutée."
        );
    };
  const reorder = $("#toggle-category-reorder");
  if (reorder)
    reorder.onclick = () => {
      boxCategoryReorder = !boxCategoryReorder;
      renderManagedBox();
    };
  root.querySelectorAll("[data-move-category]").forEach(
    b =>
      (b.onclick = () => {
        const ids = d.categories.map(c => c.id),
          i = ids.indexOf(b.dataset.moveCategory),
          j = i + Number(b.dataset.direction);
        if (j < 0 || j >= ids.length) return;
        [ids[i], ids[j]] = [ids[j], ids[i]];
        boxAction("/manage/boxes/" + d.box.id + "/categories/order", "PUT", {ids});
      })
  );
  root.querySelectorAll("[data-edit-category]").forEach(
    b =>
      (b.onclick = () => {
        const c = d.categories.find(x => x.id === b.dataset.editCategory),
          name = prompt("Renommer la catégorie :", c.name);
        if (name && name.trim() && name.trim() !== c.name)
          boxAction("/manage/categories/" + c.id, "PUT", {name: name.trim()}, "Catégorie renommée.");
      })
  );
  root.querySelectorAll("[data-del-category]").forEach(
    b =>
      (b.onclick = () => {
        const c = d.categories.find(x => x.id === b.dataset.delCategory);
        if (confirm("Supprimer la catégorie « " + c.name + " » ?"))
          boxAction("/manage/categories/" + c.id, "DELETE", null, "Catégorie supprimée.");
      })
  );
}

// ----- Classement d’un WOD de box (membres de la box uniquement) -----
async function openLeaderboard(wodId) {
  const known = boxWodsById.get(wodId);
  $("#leaderboardtitle").textContent = known?.name || "Classement";
  $("#leaderboardmeta").textContent = "";
  $("#leaderboardbody").innerHTML = `<p class="muted">Chargement…</p>`;
  $("#leaderboarddialog").showModal();
  try {
    const d = await api("/box-wods/" + wodId + "/leaderboard"),
      w = rememberBoxWods([d.wod])[0];
    $("#leaderboardtitle").textContent = w.name;
    $("#leaderboardmeta").textContent = [w.box_name, fmt(w.wod_date), SCORE_LABELS[w.score_type]].join(" · ");
    $("#leaderboardbody").innerHTML =
      (w.content ? `<p class="leaderboard-content">${esc(w.content)}</p>` : "") +
      (w.score_type === "none"
        ? `<p class="muted">Ce WOD n’a pas de score.</p>`
        : d.categories
            .map(
              c =>
                `<section class="leaderboard-category"><h3>${esc(c.name)}</h3>${
                  c.rows.length
                    ? `<ol class="leaderboard-list">${c.rows
                        .map(
                          (x, i) =>
                            `<li class="${x.is_me ? "me" : ""}"><span class="leaderboard-rank">${i + 1}</span><span class="leaderboard-name">${esc(personName(x))}${x.pending ? ` <small class="muted">(en attente)</small>` : ""}</span><b>${esc(formatScore(w.score_type, x.score))}</b></li>`
                        )
                        .join("")}</ol>`
                    : `<p class="muted">Aucun score.</p>`
                }</section>`
            )
            .join(""));
  } catch (e) {
    $("#leaderboardbody").innerHTML = `<p class="error">${esc(e.message)}</p>`;
  }
}
$("#closeleaderboard").onclick = () => $("#leaderboarddialog").close();
