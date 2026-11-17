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
function applyTheme() {
  const pref = themePreference(),
    dark = pref === "dark" || (pref === "auto" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", dark ? "#121212" : "#f5f5f0");
}
document.querySelectorAll("#themechoice input").forEach(input => {
  input.checked = input.value === themePreference();
  input.onchange = () => {
    try {
      localStorage.setItem("fitfactory-theme", input.value);
    } catch {}
    applyTheme();
  };
});
matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);
applyTheme();
