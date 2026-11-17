// FitFactory — rappels par notification (abonnement et réglages).
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

// Rappels (notifications push) : abonnement par téléphone, réglages (jours sans séance, heure) communs au compte.
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIos = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const urlKey = k => {
  const s = k.replace(/-/g, "+").replace(/_/g, "/"),
    b = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(b, c => c.charCodeAt(0));
};
let reminderConfig = null;
function reminderChips(id, values, current, label) {
  $(id).innerHTML = values
    .map(
      v =>
        `<label><input type="radio" name="${id.slice(1)}" value="${v}" ${v === current ? "checked" : ""}><span>${label(v)}</span></label>`
    )
    .join("");
  $(id)
    .querySelectorAll("input")
    .forEach(i => (i.onchange = saveReminderSettings));
}
async function loadReminders() {
  const hint = $("#reminderhint"),
    toggle = $("#reminderenabled"),
    status = $("#reminderstatus");
  status.textContent = "";
  if (!pushSupported()) {
    hint.hidden = false;
    hint.textContent = isIos()
      ? "Sur iPhone, ajoute d’abord FitFactory à l’écran d’accueil (iOS 16.4 minimum), puis ouvre l’app depuis son icône pour activer les rappels."
      : "Ce navigateur ne permet pas les notifications.";
    toggle.disabled = true;
    $("#reminderoptions").hidden = true;
    return;
  }
  try {
    reminderConfig = await sendApi("/push/config", "GET");
  } catch (e) {
    hint.hidden = false;
    hint.textContent = e.offline ? "Réglages des rappels disponibles avec du réseau." : e.message;
    toggle.disabled = true;
    return;
  }
  hint.hidden = Notification.permission !== "denied";
  hint.textContent =
    "Les notifications sont bloquées pour FitFactory : autorise-les dans les réglages du téléphone (Notifications → FitFactory).";
  const sub = await (await navigator.serviceWorker.ready).pushManager.getSubscription();
  toggle.disabled = false;
  toggle.checked = !!sub && Notification.permission === "granted";
  $("#reminderoptions").hidden = !toggle.checked;
  reminderChips("#reminderdays", reminderConfig.choices.days, reminderConfig.days, v => v + " jours");
  reminderChips("#reminderhours", reminderConfig.choices.hours, reminderConfig.hour, v => v + " h");
}
const reminderChoice = id => Number($(id).querySelector("input:checked")?.value);
async function saveReminderSettings() {
  try {
    await sendApi("/push/settings", "PUT", {
      days: reminderChoice("#reminderdays"),
      hour: reminderChoice("#reminderhours"),
    });
    $("#reminderstatus").textContent = "";
    toast("Rappel enregistré.");
  } catch (e) {
    $("#reminderstatus").textContent = e.message;
  }
}
$("#reminderenabled").onchange = async e => {
  const toggle = e.target,
    status = $("#reminderstatus");
  status.textContent = "";
  toggle.disabled = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (toggle.checked) {
      if ((await Notification.requestPermission()) !== "granted") {
        toggle.checked = false;
        status.textContent = "Notifications refusées : autorise-les dans les réglages du téléphone.";
        return;
      }
      if (!sub)
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlKey(reminderConfig.publicKey),
        });
      await sendApi("/push/subscribe", "POST", sub.toJSON());
      await sendApi("/push/settings", "PUT", {
        days: reminderChoice("#reminderdays"),
        hour: reminderChoice("#reminderhours"),
      });
      toast("Rappels activés sur ce téléphone.");
    } else if (sub) {
      await sendApi("/push/unsubscribe", "POST", {endpoint: sub.endpoint});
      await sub.unsubscribe();
      toast("Rappels désactivés sur ce téléphone.");
    }
  } catch (err) {
    toggle.checked = !toggle.checked;
    status.textContent = err.offline
      ? "Il faut du réseau pour modifier les rappels."
      : "Impossible de modifier les rappels : " + err.message;
  } finally {
    toggle.disabled = false;
    $("#reminderoptions").hidden = !toggle.checked;
  }
};
$("#remindertest").onclick = async () => {
  try {
    const r = await sendApi("/push/test", "POST", {});
    $("#reminderstatus").textContent = r.sent
      ? "Notification envoyée."
      : "Aucun téléphone n’a pu être joint : désactive puis réactive les rappels.";
  } catch (e) {
    $("#reminderstatus").textContent = e.message;
  }
};
