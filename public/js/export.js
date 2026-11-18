// FitFactory — export Excel du bilan hebdomadaire.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

function isoWeekParts(dateString) {
  const date = new Date(dateString + "T00:00:00Z"),
    day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const year = date.getUTCFullYear(),
    yearStart = new Date(Date.UTC(year, 0, 1));
  return {year, week: Math.ceil(((date - yearStart) / 86400000 + 1) / 7)};
}
function loadXlsxLibrary() {
  if (window.XLSX) return Promise.resolve(window.XLSX);
  if (window.cfXlsxLoading) return window.cfXlsxLoading;
  window.cfXlsxLoading = new Promise((resolve, reject) => {
    const script = document.createElement("script");
    script.src = "/vendor/xlsx.full.min.js";
    script.onload = () =>
      window.XLSX ? resolve(window.XLSX) : reject(new Error("La bibliothèque Excel n'a pas pu être chargée."));
    script.onerror = () => {
      window.cfXlsxLoading = null;
      reject(new Error("Impossible de charger le module Excel. Réessaie après avoir rouvert l’application."));
    };
    document.head.appendChild(script);
  });
  return window.cfXlsxLoading;
}
async function exportWeeklyExcel() {
  const button = $("#exportexcel"),
    status = $("#exportexcelstatus");
  button.disabled = true;
  button.textContent = "Génération…";
  status.textContent = "";
  try {
    const [data, XLSX] = await Promise.all([api("/export-data"), loadXlsxLibrary()]);
    const programs = data.programs || [],
      wods = data.wods || [],
      movements = data.movements || [],
      sessions = data.sessions || [],
      checks = data.checks || [];
    // Mouvements du catalogue cochés dans les séances d’un programme sans mouvement à travailler.
    for (const check of data.catalogChecks || []) {
      const programId = sessions.find(s => s.id === check.session_id)?.program_id,
        id = "catalog:" + check.catalog_movement_id;
      if (!programId) continue;
      if (!movements.some(m => m.id === id && m.program_id === programId))
        movements.push({id, program_id: programId, name: check.movement_name});
      checks.push({session_id: check.session_id, movement_id: id});
    }
    const checksBySession = new Map();
    for (const check of checks) {
      if (!checksBySession.has(check.session_id)) checksBySession.set(check.session_id, new Set());
      checksBySession.get(check.session_id).add(check.movement_id);
    }
    // Un seul tableau « Bilan » : une ligne par semaine ISO et par programme, dans l’ordre chronologique.
    // Toujours 7 colonnes WOD, par position (WOD 1 = 1er WOD de son programme…) ; à chaque changement de programme,
    // une ligne rappelle le nom du programme et de ses 7 WOD. Colonnes mouvements fixes, regroupées par nom.
    const keyOf = name =>
        String(name || "")
          .trim()
          .toLowerCase(),
      programOrder = new Map(programs.map((p, i) => [p.id, i]));
    const byProgram = (a, b) => (programOrder.get(a.program_id) ?? 1e9) - (programOrder.get(b.program_id) ?? 1e9);
    const wodIndexById = new Map();
    const programById = new Map(programs.map(p => [p.id, p])),
      wodNamesByProgram = new Map();
    for (const program of programs) {
      const list = wods.filter(w => w.program_id === program.id).slice(0, 7);
      list.forEach((w, i) => wodIndexById.set(w.id, i));
      wodNamesByProgram.set(
        program.id,
        Array.from({length: 7}, (_, i) => list[i]?.name || "—")
      );
    }
    const movementKeyById = new Map(movements.map(m => [m.id, keyOf(m.name)]));
    const doneMovementKeys = new Set(checks.map(c => movementKeyById.get(c.movement_id)).filter(Boolean));
    const columnsFrom = (items, done) => {
      const seen = new Map();
      for (const item of [...items].sort(byProgram)) {
        const key = keyOf(item.name);
        if (done.has(key) && !seen.has(key)) seen.set(key, String(item.name).trim());
      }
      return [...seen].map(([key, name]) => ({key, name}));
    };
    const wodColumns = Array.from({length: 7}, (_, i) => "WOD " + (i + 1)),
      movementColumns = columnsFrom(movements, doneMovementKeys);
    const grouped = new Map();
    for (const session of sessions) {
      const {year, week} = isoWeekParts(session.session_date),
        key = year + "-" + String(week).padStart(2, "0") + "|" + session.program_id;
      if (!grouped.has(key))
        grouped.set(key, {year, week, programId: session.program_id, total: 0, wods: new Map(), movements: new Map()});
      const row = grouped.get(key);
      row.total++;
      const wodIndex = wodIndexById.get(session.wod_id);
      if (wodIndex !== undefined) row.wods.set(wodIndex, (row.wods.get(wodIndex) || 0) + 1);
      const sessionMovements = new Set(
        [...(checksBySession.get(session.id) || [])].map(id => movementKeyById.get(id)).filter(Boolean)
      );
      for (const movementKey of sessionMovements)
        row.movements.set(movementKey, (row.movements.get(movementKey) || 0) + 1);
    }
    const firstWod = 2,
      firstMovement = firstWod + wodColumns.length,
      lastColumn = firstMovement + movementColumns.length - 1;
    const topRow = ["Semaine ISO", "Nb de séances", "WOD réalisés", ...Array(wodColumns.length - 1).fill("")];
    if (movementColumns.length) topRow.push("Focus mouvement", ...Array(movementColumns.length - 1).fill(""));
    const rows = [topRow, ["Année-Semaine", "Total", ...wodColumns, ...movementColumns.map(c => c.name)]];
    const weeks = [...grouped.values()].sort(
      (a, b) =>
        a.year - b.year ||
        a.week - b.week ||
        (programOrder.get(a.programId) ?? 1e9) - (programOrder.get(b.programId) ?? 1e9)
    );
    let currentProgram = null;
    for (const week of weeks) {
      if (week.programId !== currentProgram) {
        currentProgram = week.programId;
        rows.push([
          programById.get(week.programId)?.name || "Programme",
          "",
          ...(wodNamesByProgram.get(week.programId) || Array(7).fill("—")),
        ]);
      }
      rows.push([
        week.year + "-S" + String(week.week).padStart(2, "0"),
        week.total,
        ...wodColumns.map((_, i) => week.wods.get(i) || 0),
        ...movementColumns.map(c => week.movements.get(c.key) || 0),
      ]);
    }
    if (!weeks.length) rows.push(["Aucune séance enregistrée"]);
    const workbook = XLSX.utils.book_new(),
      sheet = XLSX.utils.aoa_to_sheet(rows);
    sheet["!merges"] = [
      {s: {r: 0, c: 0}, e: {r: 1, c: 0}},
      {s: {r: 0, c: 1}, e: {r: 1, c: 1}},
      {s: {r: 0, c: firstWod}, e: {r: 0, c: firstMovement - 1}},
    ];
    if (movementColumns.length > 1) sheet["!merges"].push({s: {r: 0, c: firstMovement}, e: {r: 0, c: lastColumn}});
    sheet["!cols"] = [
      {wch: 15},
      {wch: 13},
      ...wodColumns.map((_, i) => ({
        wch: Math.max(9, Math.min(24, ...[...wodNamesByProgram.values()].map(names => names[i].length + 2))),
      })),
      ...movementColumns.map(c => ({wch: Math.max(10, Math.min(22, c.name.length + 2))})),
    ];
    sheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({s: {r: 1, c: 0}, e: {r: Math.max(1, rows.length - 1), c: lastColumn}}),
    };
    XLSX.utils.book_append_sheet(workbook, sheet, "Bilan");
    const stamp = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(workbook, "myFitFactory_bilan_programmes_" + stamp + ".xlsx");
    status.textContent =
      "Export Excel généré : " + new Set(weeks.map(w => w.year + "-" + w.week)).size + " semaine(s).";
  } catch (error) {
    status.textContent = error.message || "Erreur lors de la génération de l'export.";
  } finally {
    button.disabled = false;
    button.textContent = "Exporter les données";
  }
}
$("#exportexcel").onclick = exportWeeklyExcel;
