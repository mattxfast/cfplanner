// FitFactory — démarrage : mode hors ligne, session en cours, synchronisation.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

FFOffline.init({
  send: sendApi,
  describeSession: b => {
    const p = programs.find(x => x.id === b.program_id),
      w =
        b.wod_id === "other"
          ? {name: "Autres"}
          : programs.flatMap(x => wodsByProgram[x.id] || []).find(x => x.id === b.wod_id),
      a = activities.find(x => x.id === b.activity_id);
    return {
      ...(p ? {program_name: p.name} : b.program_id === "none" ? {program_name: "Hors programme"} : {}),
      ...(w ? {wod_name: w.name === "__AUTRES__" ? "Autres" : w.name, planned_comment: w.planned_comment || ""} : {}),
      ...(a ? {activity_name: a.name} : {}),
    };
  },
  describePr: b => {
    const m = movementCatalog.find(x => x.id === b.movement_id);
    return m ? {movement_name: m.name, measurement_method: m.measurement_method} : {};
  },
  // WOD de box créé ou modifié hors ligne : nom par défaut et nom de la box.
  describeBoxWod: b => ({name: b.name || defaultWodName(b.wod_date), box_name: boxName(b.box_id)}),
  onChange: renderSyncStatus,
  onSynced: async () => {
    if (user) {
      await load();
      toast("Modifications hors ligne synchronisées.");
    }
  },
  onDropped: (op, e) => toast("Une modification hors ligne a été refusée : " + e.message),
});
$("#syncstatus").onclick = () => FFOffline.flush();
(async () => {
  // Lien « mot de passe oublié » : ?reset=<jeton> ouvre directement le formulaire de nouveau mot de passe.
  const params = new URLSearchParams(location.search);
  if (params.has("reset")) {
    resetToken = params.get("reset");
    history.replaceState(null, "", location.pathname);
    showAuth();
    showAuthPanel("reset");
    return;
  }
  try {
    const d = await api("/me");
    if (d.user) {
      user = d.user;
      isAdmin = !!d.is_admin;
      FFOffline.setOwner(user.id);
      showApp();
      FFOffline.flush();
    } else {
      FFOffline.clear();
      showAuth();
    }
  } catch (e) {
    showAuth();
    if (e.message === OFFLINE_MESSAGE)
      $("#autherror").textContent =
        "Pas de connexion internet et aucune donnée enregistrée sur ce téléphone : connecte-toi une première fois avec du réseau.";
  }
})();
