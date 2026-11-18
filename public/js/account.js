// FitFactory — mon compte : profil et thème clair/sombre.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

$("#profileform").onsubmit = async e => {
  e.preventDefault();
  const f = new FormData(e.target);
  $("#profileerror").textContent = "";
  try {
    const d = await api("/profile", {
      method: "PUT",
      body: JSON.stringify({first_name: f.get("first_name"), last_name: f.get("last_name")}),
    });
    user = d.user;
    renderUserbar();
    toast("Profil mis à jour.");
  } catch (x) {
    $("#profileerror").textContent = x.message;
  }
};

// Thème effectif gardé sur l’appareil (copie du thème du compte) ; « auto » suit le réglage du téléphone.
function themePreference() {
  try {
    const old = localStorage.getItem("cfplanner-theme");
    if (old !== null) {
      if (localStorage.getItem("fitfactory-theme") === null) localStorage.setItem("fitfactory-theme", old);
      localStorage.removeItem("cfplanner-theme");
    }
    return localStorage.getItem("fitfactory-theme") || "auto";
  } catch {
    return "auto";
  }
}
// Thèmes : « auto » suit le téléphone (clair/sombre) ; les autres sont appliqués tels quels (data-theme sur <html>).
const THEME_BAR_COLORS = {light: "#f5f5f0", dark: "#121212", massilia: "#f4f4f4", massilia2: "#0d0d0d"};
function applyTheme() {
  const pref = themePreference(),
    theme =
      THEME_BAR_COLORS[pref] && pref !== "auto"
        ? pref
        : matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "light";
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_BAR_COLORS[theme]);
}
// Thème du compte (et non de l’appareil) : enregistré sur le serveur ; « Par défaut » suit le thème choisi par
// l’administrateur. Le thème effectif est recopié sur l’appareil pour s’afficher dès l’ouverture (avant connexion).
const THEME_NAMES = {
  auto: "Automatique (selon le téléphone)",
  light: "Clair",
  dark: "Sombre",
  massilia: "Massilia CrossFit",
  massilia2: "Massilia CrossFit 2",
};
let preferences = null;
function cacheTheme(theme) {
  try {
    localStorage.setItem("fitfactory-theme", theme);
  } catch {}
  applyTheme();
}
function setPreferences(d) {
  preferences = d;
  const select = $("#themeselect");
  select.innerHTML =
    `<option value="default">Par défaut (${esc(THEME_NAMES[d.default_theme] || d.default_theme)})</option>` +
    d.choices.themes.map(t => `<option value="${t}">${esc(THEME_NAMES[t] || t)}</option>`).join("");
  select.value = d.theme || "default";
  cacheTheme(d.theme || d.default_theme);
  renderReminders();
}
$("#themeselect").onchange = async e => {
  const theme = e.target.value === "default" ? null : e.target.value;
  cacheTheme(theme || preferences?.default_theme || "auto");
  try {
    await api("/preferences", {method: "PUT", body: JSON.stringify({theme})});
    if (preferences) preferences.theme = theme;
    toast("Thème enregistré pour ton compte.");
  } catch (x) {
    toast(x.message);
  }
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
applyTheme();
