// FitFactory — interface : blocage du défilement derrière les fenêtres, service worker.
// Scripts classiques chargés dans l’ordre par index.html (portée globale partagée) ; boot.js démarre l’application en dernier.

// Bloque le défilement de la page derrière une fenêtre ouverte (y compris sur iOS Safari).
let lockedScrollY = 0;
function syncScrollLock() {
  const open = !!document.querySelector("dialog[open]"),
    body = document.body;
  if (open && !body.classList.contains("modal-open")) {
    lockedScrollY = window.scrollY;
    body.style.top = -lockedScrollY + "px";
    body.classList.add("modal-open");
  } else if (!open && body.classList.contains("modal-open")) {
    body.classList.remove("modal-open");
    body.style.top = "";
    window.scrollTo(0, lockedScrollY);
  }
}
new MutationObserver(syncScrollLock).observe(document.body, {
  subtree: true,
  attributes: true,
  attributeFilter: ["open"],
});

// Application installable (PWA) : enregistre le service worker.
if ("serviceWorker" in navigator)
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(() => {}));
