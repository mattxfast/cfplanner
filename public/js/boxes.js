// FitFactory — box : adhésions (Mon compte) et espace gestionnaire (onglet « Ma box »).
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

let boxes = [],
  boxMemberships = [],
  managedBoxId = "",
  managedBox = null,
  boxCategoryReorder = false;
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

// ----- Onglet « Ma box » : réservé aux gestionnaires validés -----
function renderBoxNav() {
  const ids = boxIds("manager");
  document.querySelector('.navtab[data-view="box"]').hidden = !ids.length;
  if (!ids.length && !$("#view-box").hidden) switchView("sessions");
  if (!ids.includes(managedBoxId)) {
    managedBoxId = ids[0] || "";
    managedBox = null;
  }
  $("#managedboxpicker").hidden = ids.length < 2;
  $("#managedboxselect").innerHTML = ids.map(id => `<option value="${id}">${esc(boxName(id))}</option>`).join("");
  $("#managedboxselect").value = managedBoxId;
  if (!$("#view-box").hidden) loadManagedBox();
}
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
  try {
    managedBox = await api("/manage/boxes/" + managedBoxId);
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
// Rubriques supplémentaires (WOD de la box) ajoutées par d’autres scripts.
const boxManagerSections = [];
function renderManagedBox() {
  const d = managedBox;
  if (!d) return;
  $("#boxviewtitle").textContent = d.box.name;
  const pending = d.members.filter(x => x.status === "pending"),
    members = d.members.filter(x => x.status === "approved"),
    cats = d.categories;
  const person = x => `${esc(personName(x))} <small class="muted">${esc(x.email)}</small>`;
  $("#boxmanager").innerHTML =
    boxManagerSections.map(section => section(d)).join("") +
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
