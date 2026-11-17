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

// Thème clair / sombre : préférence mémorisée sur l’appareil, « auto » suit le réglage du téléphone.
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
$("#themeselect").value = THEME_BAR_COLORS[themePreference()] ? themePreference() : "auto";
$("#themeselect").onchange = e => {
  try {
    localStorage.setItem("fitfactory-theme", e.target.value);
  } catch {}
  applyTheme();
};
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
applyTheme();
