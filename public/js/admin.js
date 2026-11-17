// FitFactory — administration : utilisateurs, catalogue de mouvements, activités.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

async function loadAdmin() {
  if (!isAdmin) return;
  const [a, u, m] = await Promise.all([api("/admin/activities"), api("/admin/users"), api("/admin/movements")]);
  activities = a.activities;
  renderAdmin(u.users, m.movements);
}
document.querySelectorAll("[data-admin-add]").forEach(
  b =>
    (b.onclick = () => {
      const form = $("#" + b.dataset.adminAdd),
        dialog = $(b.dataset.adminAdd === "movementcatalogform" ? "#movementcatalogdialog" : "#activitydialog");
      form.reset();
      delete form.dataset.editId;
      if (form.elements.id) form.elements.id.value = "";
      if (b.dataset.adminAdd === "movementcatalogform")
        $("#movementcatalogdialogtitle").textContent = "Ajouter un mouvement";
      if (b.dataset.adminAdd === "activityform") $("#activitydialogtitle").textContent = "Ajouter une activité";
      if (b.dataset.adminAdd === "movementcatalogform") $("#movementcatalogerror").textContent = "";
      dialog.showModal();
      dialog.querySelector("input:not([type=hidden])")?.focus();
    })
);
document
  .querySelectorAll("[data-close-dialog]")
  .forEach(b => (b.onclick = () => $("#" + b.dataset.closeDialog).close()));
document.querySelectorAll("#view-admin .admin-group-title").forEach(h => {
  const toggle = () => {
    const group = h.closest(".admin-group");
    group.classList.toggle("collapsed");
    h.setAttribute("aria-expanded", String(!group.classList.contains("collapsed")));
    const mark = h.querySelector(".admin-collapse-indicator");
    if (mark) mark.textContent = group.classList.contains("collapsed") ? "＋" : "−";
  };
  h.addEventListener("click", e => {
    if (e.target.closest(".admin-add,.reorder-toggle")) return;
    toggle();
  });
  h.addEventListener("keydown", e => {
    if (e.target !== h) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      toggle();
    }
  });
});
function renderAdmin(users, movements = []) {
  renderAdmin.last = [users, movements];
  const reorderCatalog = !!window.cfCatalogReorder,
    catalogToggle = $("#toggle-catalog-reorder");
  catalogToggle.hidden = movements.length < 2;
  catalogToggle.classList.toggle("active", reorderCatalog);
  catalogToggle.setAttribute("aria-pressed", String(reorderCatalog));
  $("#movementcataloglist").innerHTML =
    movements
      .map(
        (m, i) =>
          `<div class="admin-row"><span>${esc(m.name)} <small class="muted">· ${m.measurement_method === "force" ? "Force" : m.measurement_method === "reps" ? "Gym" : m.measurement_method === "distance" ? "Engine" : "Lift"}</small></span><span class="admin-row-actions">${reorderCatalog ? `<button class="smallbtn admin-reorder" data-move-admin="movement" data-id="${m.id}" data-direction="-1" aria-label="Monter" title="Monter" ${i === 0 ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg></button><button class="smallbtn admin-reorder" data-move-admin="movement" data-id="${m.id}" data-direction="1" aria-label="Descendre" title="Descendre" ${i === movements.length - 1 ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg></button>` : ""}<button class="smallbtn" data-edit-catalog-movement="${m.id}" aria-label="Modifier" title="Modifier"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg></button><button class="smallbtn delete" data-del-catalog-movement="${m.id}" aria-label="Supprimer" title="Supprimer"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></span></div>`
      )
      .join("") || `<p class="muted">Aucun mouvement dans le catalogue.</p>`;
  $("#view-admin")
    .querySelectorAll("[data-move-admin]")
    .forEach(
      b =>
        (b.onclick = async () => {
          try {
            await api("/admin/" + (b.dataset.moveAdmin === "movement" ? "movements" : "activities") + "/order", {
              method: "PUT",
              body: JSON.stringify({id: b.dataset.id, direction: Number(b.dataset.direction)}),
            });
            await loadAdmin();
          } catch (e) {
            toast(e.message);
          }
        })
    );
  $("#movementcataloglist")
    .querySelectorAll("[data-edit-catalog-movement]")
    .forEach(
      b =>
        (b.onclick = () => {
          const m = movements.find(x => x.id === b.dataset.editCatalogMovement),
            f = $("#movementcatalogform");
          f.elements.name.value = m.name;
          f.elements.measurement_method.value = m.measurement_method || "load";
          f.dataset.editId = m.id;
          $("#movementcatalogdialogtitle").textContent = "Modifier un mouvement";
          $("#movementcatalogdialog").showModal();
        })
    );
  $("#movementcataloglist")
    .querySelectorAll("[data-del-catalog-movement]")
    .forEach(
      b =>
        (b.onclick = async () => {
          if (confirm("Supprimer ce mouvement du catalogue ? Les programmes qui l’utilisent le conserveront.")) {
            await api("/admin/movements/" + b.dataset.delCatalogMovement, {method: "DELETE"});
            const d = await api("/movement-catalog");
            movementCatalog = d.movements;
            await loadAdmin();
          }
        })
    );
  $("#activitylist").innerHTML =
    activities
      .map(
        (a, i) =>
          `<div class="admin-row"><span>${esc(a.name)} · ${a.duration_minutes} min ${a.is_default ? "(par défaut)" : ""} ${a.is_active ? "" : "· inactive"}</span><span class="admin-row-actions"><button class="smallbtn admin-reorder" data-move-admin="activity" data-id="${a.id}" data-direction="-1" aria-label="Monter" title="Monter" ${i === 0 ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 19V5"/><path d="m6 11 6-6 6 6"/></svg></button><button class="smallbtn admin-reorder" data-move-admin="activity" data-id="${a.id}" data-direction="1" aria-label="Descendre" title="Descendre" ${i === activities.length - 1 ? "disabled" : ""}><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="m6 13 6 6 6-6"/></svg></button><button class="smallbtn" data-edit-activity="${a.id}" aria-label="Modifier" title="Modifier"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg></button><button class="smallbtn delete" data-del-activity="${a.id}" aria-label="Désactiver ou supprimer" title="Désactiver si utilisée, supprimer sinon"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button><button class="smallbtn" data-default-activity="${a.id}" aria-label="Définir par défaut" title="Définir par défaut" ${a.is_default ? "disabled" : ""}>★</button></span></div>`
      )
      .join("") || `<p class="muted">Aucune activité.</p>`;
  $("#userlist").innerHTML =
    users
      .map(
        u =>
          `<div class="admin-row"><span>${esc(u.email)} · ${u.is_active ? "actif" : "inactif"}</span><span class="admin-row-actions"><button class="smallbtn" data-reset-user="${u.id}" aria-label="Lien de réinitialisation du mot de passe" title="Lien de réinitialisation du mot de passe" ${u.is_active ? "" : "disabled"}>🔑</button><button class="smallbtn delete" data-toggle-user="${u.id}" aria-label="${u.is_active ? "Désactiver" : "Réactiver"}" title="${u.is_active ? "Désactiver" : "Réactiver"}" ${u.email === user.email ? "disabled" : ""}>${u.is_active ? "×" : "↻"}</button></span></div>`
      )
      .join("") || `<p class="muted">Aucun utilisateur.</p>`;
  $("#activitylist")
    .querySelectorAll("[data-del-activity]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const activity = activities.find(a => a.id === b.dataset.delActivity);
          if (
            confirm(
              "Si cette activité est utilisée dans un programme ou une séance, elle sera désactivée et conservée. Sinon, elle sera définitivement supprimée. Continuer ?"
            )
          ) {
            try {
              const result = await api("/admin/activities/" + b.dataset.delActivity, {method: "DELETE"});
              await loadAdmin();
              toast(result.action === "deactivated" ? "Activité désactivée." : "Activité supprimée.");
            } catch (e) {
              toast(e.message);
            }
          }
        })
    );
  $("#activitylist")
    .querySelectorAll("[data-edit-activity]")
    .forEach(
      b =>
        (b.onclick = () => {
          const a = activities.find(x => x.id === b.dataset.editActivity),
            f = $("#activityform");
          f.elements.id.value = a.id;
          f.elements.name.value = a.name;
          f.elements.duration_minutes.value = a.duration_minutes;
          f.elements.is_default.checked = !!a.is_default;
          $("#activitydialogtitle").textContent = "Modifier une activité";
          $("#activitydialog").showModal();
        })
    );
  $("#activitylist")
    .querySelectorAll("[data-default-activity]")
    .forEach(
      b =>
        (b.onclick = async () => {
          await api("/admin/activities/" + b.dataset.defaultActivity, {
            method: "PUT",
            body: JSON.stringify({is_default: true}),
          });
          await loadAdmin();
        })
    );

  // Lien de réinitialisation à transmettre à l’utilisateur (copié dans le presse-papiers si possible).
  $("#userlist")
    .querySelectorAll("[data-reset-user]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const u = users.find(x => x.id === b.dataset.resetUser);
          if (!confirm("Créer un lien de réinitialisation du mot de passe pour " + u.email + " ?")) return;
          try {
            const r = await sendApi("/admin/users/" + u.id + "/reset-link", "POST", {});
            try {
              await navigator.clipboard.writeText(r.link);
              toast("Lien copié : à transmettre à " + u.email + " (valable " + r.minutes + " min).");
            } catch {
              prompt("Lien à transmettre (valable " + r.minutes + " min) :", r.link);
            }
          } catch (e) {
            toast(e.message);
          }
        })
    );
  $("#userlist")
    .querySelectorAll("[data-toggle-user]")
    .forEach(
      b =>
        (b.onclick = async () => {
          const u = users.find(x => x.id === b.dataset.toggleUser);
          if (confirm(u.is_active ? "Désactiver cet utilisateur ?" : "Réactiver cet utilisateur ?")) {
            await api("/admin/users/" + u.id, {method: "PUT", body: JSON.stringify({is_active: !u.is_active})});
            await loadAdmin();
          }
        })
    );
}
$("#movementcatalogform").onsubmit = async e => {
  e.preventDefault();
  const name = e.target.elements.name.value.trim(),
    method = e.target.elements.measurement_method.value,
    editing = e.target.dataset.editId;
  try {
    await api(editing ? "/admin/movements/" + editing : "/admin/movements", {
      method: editing ? "PUT" : "POST",
      body: JSON.stringify({name, measurement_method: method}),
    });
    e.target.reset();
    delete e.target.dataset.editId;
    $("#movementcatalogdialog").close();
    const d = await api("/movement-catalog");
    movementCatalog = d.movements;
    await loadAdmin();
    toast(editing ? "Mouvement modifié." : "Mouvement ajouté au catalogue.");
  } catch (x) {
    $("#movementcatalogerror").textContent = x.message;
  }
};
$("#activityform").onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target),
    id = f.get("id");
  try {
    await api(id ? "/admin/activities/" + id : "/admin/activities", {
      method: id ? "PUT" : "POST",
      body: JSON.stringify({
        name: f.get("name"),
        duration_minutes: Number(f.get("duration_minutes")),
        is_default: f.get("is_default") === "on",
      }),
    });
    e.target.reset();
    $("#activitydialog").close();
    await loadAdmin();
    toast("Activité enregistrée.");
  } catch (x) {
    toast(x.message);
  }
};
