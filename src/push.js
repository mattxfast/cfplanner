// FitFactory — notifications push (Web Push) sans dépendance : WebCrypto uniquement.
// - Clés VAPID (ECDSA P-256) générées une seule fois par le Worker et gardées dans la table app_settings.
// - Chiffrement du contenu selon la RFC 8291 (aes128gcm), signature VAPID selon la RFC 8292.
const te = new TextEncoder();
export const b64url = bytes => {
  let s = "";
  for (const x of new Uint8Array(bytes)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
export const unb64url = str => {
  const s = String(str).replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(s + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

// Services de notification acceptés : évite que le Worker envoie des requêtes vers une adresse arbitraire.
const PUSH_HOSTS = [
  /^web\.push\.apple\.com$/,
  /(^|\.)push\.apple\.com$/,
  /^fcm\.googleapis\.com$/,
  /^updates\.push\.services\.mozilla\.com$/,
  /(^|\.)notify\.windows\.com$/,
];
export function isAllowedEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some(re => re.test(u.hostname)) && endpoint.length <= 1000;
  } catch {
    return false;
  }
}

export async function vapidKeys(db) {
  const row = await db.prepare("SELECT value FROM app_settings WHERE key='vapid'").first();
  if (row) return JSON.parse(row.value);
  const pair = await crypto.subtle.generateKey({name: "ECDSA", namedCurve: "P-256"}, true, ["sign", "verify"]);
  const keys = {
    publicKey: b64url(await crypto.subtle.exportKey("raw", pair.publicKey)),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
  await db.prepare("INSERT OR IGNORE INTO app_settings(key,value) VALUES('vapid',?)").bind(JSON.stringify(keys)).run();
  return JSON.parse((await db.prepare("SELECT value FROM app_settings WHERE key='vapid'").first()).value);
}

export async function vapidJwt(audience, subject, privateJwk, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(te.encode(JSON.stringify({typ: "JWT", alg: "ES256"})));
  const claims = b64url(te.encode(JSON.stringify({aud: audience, exp: now + 12 * 3600, sub: subject})));
  const key = await crypto.subtle.importKey("jwk", privateJwk, {name: "ECDSA", namedCurve: "P-256"}, false, ["sign"]);
  const signature = await crypto.subtle.sign({name: "ECDSA", hash: "SHA-256"}, key, te.encode(header + "." + claims));
  return header + "." + claims + "." + b64url(signature);
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({name: "HKDF", hash: "SHA-256", salt, info}, key, length * 8));
}

// Chiffre le contenu pour un abonnement (clés p256dh et auth fournies par le navigateur).
// localKeys (facultatif) : paire ECDH réutilisée pour plusieurs messages d'un même envoi groupé (le sel aléatoire reste
// propre à chaque message, donc la clé de chiffrement aussi) ; économise le calcul d'une paire par message.
export async function localEcdhKeys() {
  const pair = await crypto.subtle.generateKey({name: "ECDH", namedCurve: "P-256"}, true, ["deriveBits"]);
  return {privateKey: pair.privateKey, publicRaw: new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))};
}
export async function encryptPayload(p256dh, auth, plaintext, localKeys = null) {
  const uaPublic = unb64url(p256dh),
    authSecret = unb64url(auth);
  const own = localKeys || (await localEcdhKeys()),
    local = {privateKey: own.privateKey};
  const asPublic = own.publicRaw;
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, {name: "ECDH", namedCurve: "P-256"}, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({name: "ECDH", public: uaKey}, local.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(te.encode("WebPush: info\0"), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, te.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, te.encode("Content-Encoding: nonce\0"), 12);
  const aes = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const cipher = new Uint8Array(
    await crypto.subtle.encrypt({name: "AES-GCM", iv: nonce}, aes, concat(plaintext, new Uint8Array([2])))
  );
  const header = new Uint8Array(21);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPublic.length;
  return concat(header, asPublic, cipher);
}

// Envoie une notification ; renvoie le statut HTTP du service de notification (404/410 : abonnement expiré).
// batch (facultatif) : { localKeys, jwts: Map } partagés par un envoi groupé — une paire ECDH et une signature VAPID
// par service de notification pour tout le paquet, au lieu d'une par message.
export async function sendPush(subscription, keys, subject, message, fetcher = fetch, batch = null) {
  const body = await encryptPayload(
      subscription.p256dh,
      subscription.auth,
      te.encode(JSON.stringify(message)),
      batch?.localKeys
    ),
    audience = new URL(subscription.endpoint).origin;
  let jwt = batch?.jwts?.get(audience);
  if (!jwt) {
    jwt = await vapidJwt(audience, subject, keys.privateJwk);
    batch?.jwts?.set(audience, jwt);
  }
  const res = await fetcher(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
      TTL: "86400",
      Urgency: "normal",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
    },
    body,
  });
  return res.status;
}
