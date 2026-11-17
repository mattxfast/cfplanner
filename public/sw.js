// FitFactory — service worker : rend l'application installable et utilisable hors connexion.
// Stratégie « réseau d'abord » : la dernière version publiée est toujours servie quand le réseau répond ;
// le cache ne sert que de secours hors connexion. Les appels /api/ ne sont jamais mis en cache.
const CACHE="fitfactory-v2";
const SHELL=["/","/index.html","/app.js","/style.css","/manifest.webmanifest","/icons/icon.svg","/icons/icon-192.png","/icons/icon-512.png","/icons/apple-touch-icon.png"];
self.addEventListener("install",event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting()))});
self.addEventListener("activate",event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim()))});
self.addEventListener("fetch",event=>{
 const request=event.request,url=new URL(request.url);
 if(request.method!=="GET"||url.origin!==self.location.origin||url.pathname.startsWith("/api/"))return;
 event.respondWith(fetch(request).then(response=>{if(response.ok){const copy=response.clone();caches.open(CACHE).then(cache=>cache.put(request,copy))}return response}).catch(()=>caches.match(request).then(hit=>hit||(request.mode==="navigate"?caches.match("/index.html"):Response.error()))));
});
