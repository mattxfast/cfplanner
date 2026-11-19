// FitFactory — records personnels : cartes, graphiques, historique, saisie.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

function isLoadBased(method) {
  return method === "load" || method === "force";
}
function prKey(record) {
  return (
    record.movement_id + ":" + (isLoadBased(record.measurement_method) ? record.rep_count : record.measurement_method)
  );
}
function prValue(record) {
  return isLoadBased(record.measurement_method)
    ? Number(record.value).toLocaleString("fr-FR") + " kg"
    : record.measurement_method === "distance"
      ? Number(record.value).toLocaleString("fr-FR") + " m"
      : Number(record.value).toLocaleString("fr-FR") + " reps";
}
function renderPrChart(records) {
  const sorted = [...records].sort(
    (a, b) => a.record_date.localeCompare(b.record_date) || a.created_at.localeCompare(b.created_at)
  );
  const width = 340,
    height = 150,
    left = 46,
    right = 8,
    top = 8,
    bottom = 22,
    values = sorted.map(x => Number(x.value)),
    max = Math.max(...values);
  const rawStep = (max || 1) / 4,
    magnitude = Math.pow(10, Math.floor(Math.log10(rawStep))),
    normalized = rawStep / magnitude;
  const step =
    (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10) * magnitude;
  const axisMax = step * 4,
    plotHeight = height - top - bottom,
    plotWidth = width - left - right;
  const method = sorted[0].measurement_method,
    unit = method === "load" || method === "force" ? "kg" : method === "distance" ? "m" : "reps";
  const formatTick = n => Number(n.toFixed(6)).toLocaleString("fr-FR", {maximumFractionDigits: 2}) + " " + unit;
  const yFor = value => height - bottom - (Number(value) / axisMax) * plotHeight;
  const grid = Array.from({length: 5}, (_, i) => {
    const value = step * i,
      y = yFor(value);
    return (
      '<line x1="' +
      left +
      '" y1="' +
      y +
      '" x2="' +
      (width - right) +
      '" y2="' +
      y +
      '" class="pr-gridline"/><text x="' +
      (left - 7) +
      '" y="' +
      (y + 3) +
      '" text-anchor="end" class="pr-y-label">' +
      esc(formatTick(value)) +
      "</text>"
    );
  }).join("");
  const points = sorted.map((x, i) => ({
    x: left + (sorted.length === 1 ? plotWidth / 2 : (i * plotWidth) / (sorted.length - 1)),
    y: yFor(x.value),
    date: x.record_date,
    value: x.value,
  }));
  const poly = points.map(p => p.x + "," + p.y).join(" ");
  return (
    '<svg class="pr-sparkline" viewBox="0 0 ' +
    width +
    " " +
    height +
    '" role="img" aria-label="Évolution du record en ' +
    unit +
    ", axe vertical de 0 à " +
    esc(formatTick(axisMax)) +
    '">' +
    grid +
    '<line x1="' +
    left +
    '" y1="' +
    top +
    '" x2="' +
    left +
    '" y2="' +
    (height - bottom) +
    '" class="pr-y-axis"/>' +
    (points.length > 1 ? '<polyline points="' + poly + '" class="pr-line"/>' : "") +
    points
      .map(
        p =>
          '<circle cx="' +
          p.x +
          '" cy="' +
          p.y +
          '" r="4" class="pr-point"><title>' +
          esc(p.date) +
          " : " +
          esc(p.value) +
          " " +
          unit +
          "</title></circle>"
      )
      .join("") +
    '</svg><div class="pr-chart-dates"><span>' +
    fmt(sorted[0].record_date) +
    "</span><span>" +
    fmt(sorted[sorted.length - 1].record_date) +
    "</span></div>"
  );
}
window.cfPrCategorySections = window.cfPrCategorySections || {};
const prCategoryOrder = ["load", "force", "reps", "distance"];
const prCategoryLabel = method =>
  method === "load" ? "LIFT" : method === "force" ? "FORCE" : method === "reps" ? "GYM" : "ENGINE";
function renderPrCategory(method, items) {
  const key = "records:" + method,
    collapsed = !!window.cfPrCategorySections[key];
  const content = items
    .map(
      x =>
        '<button type="button" class="pr-card card" data-pr-key="' +
        esc(x.key) +
        '"><h3>' +
        esc(x.movement_name) +
        '</h3><div class="pr-value-line"><strong class="pr-best">' +
        prValue(x.best) +
        "</strong>" +
        (isLoadBased(x.measurement_method) ? '<span class="pr-rm">' + x.rep_count + " RM</span>" : "") +
        "</div></button>"
    )
    .join("");
  // Rubrique au style des bandeaux de titre (administration, Mon compte), repliable.
  return (
    '<section class="admin-group pr-category-group ' +
    (collapsed ? "collapsed" : "") +
    '" data-pr-category="' +
    key +
    '"><div class="admin-group-title" role="button" tabindex="0" data-toggle-pr-category="' +
    key +
    '" aria-expanded="' +
    !collapsed +
    '"><span class="admin-collapse-indicator">' +
    (collapsed ? "＋" : "−") +
    "</span><span>" +
    prCategoryLabel(method) +
    '</span><button type="button" class="admin-add" data-add-pr="' +
    method +
    '" aria-label="Ajouter un PR ' +
    prCategoryLabel(method) +
    '" title="Ajouter un PR">＋</button></div><div class="admin-group-body"><div class="pr-category-body">' +
    (content || '<div class="admin-row section-empty"><span>Pas de PR enregistré</span></div>') +
    "</div></div></section>"
  );
}
function renderPrs() {
  const groups = new Map();
  for (const r of prRecords) {
    const key = prKey(r);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const catalogOrder = new Map(movementCatalog.map((m, i) => [m.id, i]));
  const items = [...groups.entries()]
    .map(([key, records]) => {
      records.sort((a, b) => a.record_date.localeCompare(b.record_date) || a.created_at.localeCompare(b.created_at));
      const best = records.reduce((a, b) => (Number(b.value) > Number(a.value) ? b : a));
      return {
        key,
        records,
        best,
        movement_name: best.movement_name,
        movement_id: best.movement_id,
        measurement_method: best.measurement_method,
        rep_count: best.rep_count,
      };
    })
    .sort(
      (a, b) =>
        (catalogOrder.get(a.movement_id) ?? Number.MAX_SAFE_INTEGER) -
          (catalogOrder.get(b.movement_id) ?? Number.MAX_SAFE_INTEGER) ||
        (isLoadBased(a.measurement_method) ? Number(a.rep_count) : 0) -
          (isLoadBased(b.measurement_method) ? Number(b.rep_count) : 0)
    );
  // Une rubrique par famille ayant des mouvements au catalogue (même sans PR), avec son bouton ＋.
  const families = prCategoryOrder.filter(
    method =>
      movementCatalog.some(m => m.measurement_method === method) || items.some(x => x.measurement_method === method)
  );
  $("#prcards").innerHTML = families.length
    ? families
        .map(method =>
          renderPrCategory(
            method,
            items.filter(x => x.measurement_method === method)
          )
        )
        .join("")
    : '<div class="card empty">Aucun mouvement dans le catalogue : l’administrateur doit d’abord en ajouter.</div>';
  const body = $("#prcards");
  body.hidden = false;
  body.querySelectorAll("[data-toggle-pr-category]").forEach(button => {
    const toggle = () => {
      const key = button.dataset.togglePrCategory,
        isCollapsed = !window.cfPrCategorySections[key];
      window.cfPrCategorySections[key] = isCollapsed;
      button.closest(".pr-category-group").classList.toggle("collapsed", isCollapsed);
      button.setAttribute("aria-expanded", String(!isCollapsed));
      button.querySelector(".admin-collapse-indicator").textContent = isCollapsed ? "＋" : "−";
    };
    button.onclick = e => {
      if (!e.target.closest(".admin-add")) toggle();
    };
    button.onkeydown = e => {
      if (e.target === button && (e.key === "Enter" || e.key === " ")) {
        e.preventDefault();
        toggle();
      }
    };
  });
  body.querySelectorAll("[data-add-pr]").forEach(b => (b.onclick = () => openPrForm(null, b.dataset.addPr)));
  body
    .querySelectorAll("[data-pr-key]")
    .forEach(button => (button.onclick = () => openPrHistory(button.dataset.prKey)));
}
function openPrHistory(key) {
  const records = prRecords
    .filter(r => prKey(r) === key)
    .sort((a, b) => b.record_date.localeCompare(a.record_date) || b.created_at.localeCompare(a.created_at));
  if (!records.length) return;
  const first = records[0],
    label = isLoadBased(first.measurement_method)
      ? first.rep_count + " RM"
      : first.measurement_method === "distance"
        ? "Distance"
        : "Répétitions";
  $("#prhistorytitle").textContent = first.movement_name + " · " + label;
  $("#prhistorychart").innerHTML = renderPrChart(records);
  $("#prhistorylist").innerHTML =
    '<div class="pr-history-section-title">Liste des valeurs</div>' +
    records
      .map(
        r =>
          '<div class="pr-history-row"><span class="pr-history-date">' +
          fmt(r.record_date) +
          "</span><strong>" +
          prValue(r) +
          '</strong><div class="entryactions"><button type="button" class="smallbtn" data-edit-pr="' +
          r.id +
          '" aria-label="Modifier ce PR" title="Modifier"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16z"/><path d="m13.5 6.5 4 4"/></svg></button><button type="button" class="smallbtn delete" data-delete-pr="' +
          r.id +
          '" aria-label="Supprimer ce PR" title="Supprimer"><svg class="btn-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6 6 18"/></svg></button></div></div>'
      )
      .join("");
  $("#prhistorylist")
    .querySelectorAll("[data-edit-pr]")
    .forEach(
      b =>
        (b.onclick = () => {
          const record = prRecords.find(x => x.id === b.dataset.editPr);
          if (record) {
            $("#prhistorydialog").close();
            openPrForm(record);
          }
        })
    );
  $("#prhistorylist")
    .querySelectorAll("[data-delete-pr]")
    .forEach(
      b =>
        (b.onclick = async () => {
          if (!confirm("Supprimer définitivement ce PR ?")) return;
          try {
            await api("/prs/" + b.dataset.deletePr, {method: "DELETE"});
            await loadPrs();
            const remaining = prRecords.filter(r => prKey(r) === key);
            if (remaining.length) openPrHistory(key);
            else $("#prhistorydialog").close();
            toast("PR supprimé.");
          } catch (e) {
            toast(e.message);
          }
        })
    );
  $("#prhistorydialog").showModal();
}
function syncPrForm() {
  const f = $("#prform"),
    movement = movementCatalog.find(m => m.id === f.elements.movement_id.value),
    method = movement?.measurement_method,
    load = isLoadBased(method),
    distance = method === "distance";
  $("#prvaluelabel").textContent = load ? "Charge (kg)" : distance ? "Distance (m)" : "Nombre de répétitions";
  $("#prvalue").step = load ? "0.5" : distance ? "0.1" : "1";
  $("#prvalue").min = load ? "0.5" : distance ? "0.1" : "1";
  $("#prvalue").placeholder = load ? "Ex. 80" : distance ? "Ex. 500" : "Ex. 15";
  $("#prrmfield").hidden = !load;
  f.elements.rep_count.required = load;
  f.elements.rep_count.disabled = !load;
}
// Ouvre le formulaire de PR : vide pour une création, pré-rempli pour la modification d'un PR existant.
// method : famille choisie avec le ＋ d’une rubrique (seuls ses mouvements sont proposés).
function openPrForm(record = null, method = "") {
  const f = $("#prform");
  f.reset();
  f.elements.record_date.value = today();
  f.elements.movement_id.innerHTML = movementCatalog
    .filter(m => !method || m.measurement_method === method)
    .map(m => '<option value="' + m.id + '">' + esc(m.name) + "</option>")
    .join("");
  f.elements.pr_id.value = record?.id || "";
  if (record) {
    f.elements.movement_id.value = record.movement_id;
    f.elements.record_date.value = record.record_date;
    f.elements.value.value = record.value;
    if (record.rep_count) f.elements.rep_count.value = String(record.rep_count);
  }
  $("#prformtitle").textContent = record ? "Modifier le PR" : "Nouveau PR";
  $("#prformsubmit").textContent = record ? "Enregistrer les modifications" : "Enregistrer le PR";
  $("#prformerror").textContent = "";
  syncPrForm();
  if (!movementCatalog.length) {
    toast("Aucun mouvement disponible dans le catalogue.");
    return;
  }
  $("#prdialog").showModal();
}
$("#closepr").onclick = () => $("#prdialog").close();
$("#prform").elements.movement_id.onchange = syncPrForm;
$("#prform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target,
    movement = movementCatalog.find(m => m.id === f.elements.movement_id.value);
  if (!movement) {
    $("#prformerror").textContent = "Sélectionne un mouvement.";
    return;
  }
  const body = {
    movement_id: movement.id,
    record_date: f.elements.record_date.value,
    value: Number(f.elements.value.value),
    rep_count: isLoadBased(movement.measurement_method) ? Number(f.elements.rep_count.value) : null,
  };
  try {
    await api(f.elements.pr_id.value ? "/prs/" + f.elements.pr_id.value : "/prs", {
      method: f.elements.pr_id.value ? "PUT" : "POST",
      body: JSON.stringify(body),
    });
    $("#prdialog").close();
    await loadPrs();
    toast(f.elements.pr_id.value ? "PR modifié." : "PR enregistré.");
  } catch (err) {
    $("#prformerror").textContent = err.message;
  }
};

$("#toggle-catalog-reorder").onclick = () => {
  window.cfCatalogReorder = !window.cfCatalogReorder;
  if (renderAdmin.last) renderAdmin(...renderAdmin.last);
};
$("#closeprhistory").onclick = () => $("#prhistorydialog").close();
