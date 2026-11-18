// FitFactory — fonctions communes : état global, dates, appels API, messages, connexion.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

(() => {
  const u = new URL(location.href);
  if (u.searchParams.has("password")) {
    u.searchParams.delete("password");
    u.searchParams.delete("email");
    history.replaceState(null, "", u.pathname + u.search + u.hash);
  }
})();
const $ = s => document.querySelector(s);
let tab = "login",
  user = null,
  selectedWeekStart = null,
  programs = [],
  wodsByProgram = {},
  movementsByProgram = {},
  movementChecks = [],
  catalogChecks = [],
  sessions = [],
  prRecords = [],
  activities = [],
  movementCatalog = [],
  isAdmin = false,
  weekCompetition = false,
  weeklyPlans = [],
  weeklyWodPrograms = [],
  boxWods = [];
const today = () => {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const fmt = s =>
  new Intl.DateTimeFormat("fr-FR", {day: "2-digit", month: "2-digit", year: "numeric"}).format(
    new Date(s + "T12:00:00")
  );
const addDays = (s, n) => {
  const d = new Date(s + "T12:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
};
const mondayOf = s => {
  const d = new Date(s + "T12:00:00");
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};
const OFFLINE_MESSAGE = "Pas de connexion internet : réessaie quand le réseau revient.";
// Envoi réseau : une coupure ou un délai dépassé donne une erreur marquée « offline » (gérée par offline.js).
async function sendApi(path, method, body) {
  const ctrl = new AbortController(),
    timer = setTimeout(() => ctrl.abort(), method === "GET" ? 8000 : 15000);
  let r;
  try {
    r = await fetch("/api" + path, {
      method,
      body: body == null ? undefined : JSON.stringify(body),
      headers: {"content-type": "application/json"},
      signal: ctrl.signal,
    });
  } catch {
    const e = Error(OFFLINE_MESSAGE);
    e.offline = true;
    throw e;
  } finally {
    clearTimeout(timer);
  }
  let d;
  try {
    d = await r.json();
  } catch {
    d = {};
  }
  if (!r.ok) {
    const e = Error(d.error || "Erreur");
    e.status = r.status;
    throw e;
  }
  return d;
}
async function api(path, opts = {}) {
  const method = (opts.method || "GET").toUpperCase(),
    body = opts.body ? JSON.parse(opts.body) : null;
  if (method === "GET") return FFOffline.read(path, () => sendApi(path, "GET"));
  return FFOffline.write(path, method, body, b => sendApi(path, method, b));
}
function renderSyncStatus(st) {
  const el = $("#syncstatus");
  if (!el) return;
  el.hidden = !st.offline && !st.pending;
  el.classList.toggle("offline", st.offline);
  const waiting = st.pending + (st.pending > 1 ? " modifications en attente" : " modification en attente");
  el.textContent = st.offline
    ? "Hors ligne" + (st.pending ? " · " + waiting : " · données enregistrées sur le téléphone")
    : "Synchronisation… " + waiting;
  el.title = st.pending
    ? "Modifications enregistrées sur le téléphone, envoyées dès le retour du réseau."
    : "Données affichées : dernière copie enregistrée sur le téléphone.";
}
function toast(t) {
  $("#toast").textContent = t;
  $("#toast").classList.add("show");
  setTimeout(() => $("#toast").classList.remove("show"), 2200);
}
function esc(s) {
  return String(s ?? "").replace(
    /[&<>"']/g,
    c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"})[c]
  );
}
function showAuth() {
  $("#auth").hidden = false;
  $("#dashboard").hidden = true;
  $("#userbar").innerHTML = "";
}
function renderUserbar() {
  $("#userbar").innerHTML =
    `<span class="user-name">${esc([user?.first_name, user?.last_name].filter(Boolean).join(" ") || user?.email || "")}</span><button class="account-icon" id="accountshortcut" aria-label="Mon compte" title="Mon compte">♙</button>${isAdmin ? `<button class="settings-icon" id="adminshortcut" aria-label="Administration" title="Administration"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Z"/><path d="m19.4 15 .1.1a1.7 1.7 0 0 1-2.4 2.4l-.1-.1a1.7 1.7 0 0 0-2.9 1.2v.2a1.7 1.7 0 0 1-3.4 0v-.2a1.7 1.7 0 0 0-2.9-1.2l-.1.1a1.7 1.7 0 1 1-2.4-2.4l.1-.1a1.7 1.7 0 0 0-1.2-2.9H4a1.7 1.7 0 0 1 0-3.4h.2a1.7 1.7 0 0 0 1.2-2.9l-.1-.1a1.7 1.7 0 1 1 2.4-2.4l.1.1a1.7 1.7 0 0 0 2.9-1.2V2a1.7 1.7 0 0 1 3.4 0v.2a1.7 1.7 0 0 0 2.9 1.2l.1-.1a1.7 1.7 0 1 1 2.4 2.4l-.1.1a1.7 1.7 0 0 0 1.2 2.9h.2a1.7 1.7 0 0 1 0 3.4h-.2a1.7 1.7 0 0 0-1.2 2.9Z"/></svg></button>` : ""}<button class="logout-icon" id="logout" aria-label="Déconnexion" title="Déconnexion"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M10 17l5-5-5-5M15 12H3M12 3h6a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-6"/></svg></button>`;
  $("#accountshortcut").onclick = () => switchView("account");
  const adminShortcut = $("#adminshortcut");
  if (adminShortcut) adminShortcut.onclick = () => switchView("admin");
  $("#logout").onclick = async () => {
    const pending = FFOffline.state().pending;
    if (
      pending &&
      !confirm(pending + " modification(s) pas encore synchronisée(s) seront perdues. Se déconnecter quand même ?")
    )
      return;
    try {
      await api("/logout", {method: "POST"});
    } catch (e) {
      toast(e.message);
      return;
    }
    FFOffline.clear();
    user = null;
    showAuth();
  };
}
function showApp() {
  $("#auth").hidden = true;
  $("#dashboard").hidden = false;
  renderUserbar();
  load();
  loadReminders().catch(() => {});
}
document.querySelectorAll(".tab").forEach(
  b =>
    (b.onclick = () => {
      tab = b.dataset.tab;
      document.querySelectorAll(".tab").forEach(x => x.classList.toggle("active", x === b));
      $("#authsubmit").textContent = tab === "login" ? "Se connecter" : "Créer mon compte";
      $("#forgotlink").hidden = tab !== "login";
      $("#authhint").textContent =
        tab === "login" ? "Connecte-toi pour retrouver tes programmes." : "Mot de passe de 12 caractères minimum.";
    })
);
// Écran de connexion : panneau « connexion / création », « mot de passe oublié » ou « nouveau mot de passe ».
function showAuthPanel(panel) {
  $("#auth .tabs").hidden = panel !== "login";
  $("#authform").hidden = panel !== "login";
  $("#forgotform").hidden = panel !== "forgot";
  $("#resetform").hidden = panel !== "reset";
  $("#forgotlink").hidden = tab !== "login";
}
$("#forgotlink").onclick = () => {
  $("#forgotform").elements.email.value = $("#authform").elements.email.value;
  $("#forgotmessage").textContent = "";
  showAuthPanel("forgot");
};
document.querySelectorAll("[data-auth-back]").forEach(b => (b.onclick = () => showAuthPanel("login")));
$("#forgotform").onsubmit = async e => {
  e.preventDefault();
  const button = e.target.querySelector("button.primary");
  button.disabled = true;
  try {
    await sendApi("/password/forgot", "POST", {email: e.target.elements.email.value});
    $("#forgotmessage").textContent =
      "Si un compte existe pour cette adresse, un lien de réinitialisation (valable 30 minutes) vient d’être envoyé.";
  } catch (x) {
    $("#forgotmessage").textContent = x.message;
  } finally {
    button.disabled = false;
  }
};
let resetToken = "";
$("#resetform").onsubmit = async e => {
  e.preventDefault();
  const f = e.target.elements;
  $("#reseterror").textContent = "";
  if (f.password.value !== f.confirm.value) {
    $("#reseterror").textContent = "Les deux mots de passe ne sont pas identiques.";
    return;
  }
  try {
    const d = await sendApi("/password/reset", "POST", {token: resetToken, password: f.password.value});
    user = d.user;
    isAdmin = !!d.is_admin;
    FFOffline.setOwner(user.id);
    showAuthPanel("login");
    showApp();
    toast("Mot de passe modifié.");
  } catch (x) {
    $("#reseterror").textContent = x.message;
  }
};
$("#authform").onsubmit = async e => {
  e.preventDefault();
  $("#autherror").textContent = "";
  const f = new FormData(e.target);
  try {
    const d = await api(tab === "login" ? "/login" : "/register", {
      method: "POST",
      body: JSON.stringify({email: f.get("email"), password: f.get("password")}),
    });
    user = d.user;
    isAdmin = !!d.is_admin;
    FFOffline.setOwner(user.id);
    showApp();
  } catch (x) {
    $("#autherror").textContent = x.message;
  }
};
