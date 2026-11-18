// Outils de test : démarre le Worker en local (wrangler dev) sur une base D1 vide et temporaire.
import {spawn, execFileSync} from "node:child_process";
import {mkdtempSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join, dirname} from "node:path";
import {fileURLToPath} from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ADMIN_EMAIL = "admin@test.local";

export async function startWorker(port = 8790 + Math.floor(Math.random() * 100)) {
  const dir = mkdtempSync(join(tmpdir(), "fitfactory-test-"));
  const wrangler = ["-y", "wrangler@4"];
  execFileSync("npx", [...wrangler, "d1", "migrations", "apply", "myfitfactory", "--local", "--persist-to", dir], {
    cwd: ROOT,
    stdio: "ignore",
    env: {...process.env, CI: "1"},
  });
  const child = spawn(
    "npx",
    [
      ...wrangler,
      "dev",
      "--local",
      "--persist-to",
      dir,
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--inspector-port",
      String(port + 1000),
      "--var",
      `ADMIN_EMAIL:${ADMIN_EMAIL}`,
    ],
    {cwd: ROOT, stdio: "ignore", env: {...process.env, CI: "1"}}
  );
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 90; i++) {
    try {
      await fetch(base + "/api/me");
      break;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  return {
    base,
    stop() {
      child.kill();
      rmSync(dir, {recursive: true, force: true});
    },
  };
}

// Client HTTP minimal avec cookie de session et IP simulée (en-tête CF-Connecting-IP).
export function client(base, ip = "203.0.113." + Math.floor(Math.random() * 250 + 1)) {
  let cookie = "";
  const call = async (method, path, body, extraHeaders = {}) => {
    const res = await fetch(base + "/api" + path, {
      method,
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": ip,
        ...(cookie ? {cookie} : {}),
        ...extraHeaders,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    for (const c of res.headers.getSetCookie?.() || []) {
      const [pair] = c.split(";");
      const [name, value] = pair.split("=");
      if (name === "fitfactory_session") cookie = value ? `${name}=${value}` : "";
    }
    let data = null;
    try {
      data = await res.json();
    } catch {}
    return {status: res.status, data, headers: res.headers};
  };
  return {
    get: p => call("GET", p),
    post: (p, b) => call("POST", p, b ?? {}),
    put: (p, b) => call("PUT", p, b ?? {}),
    del: (p, b) => call("DELETE", p, b),
    call,
    setCookie: c => {
      cookie = c;
    },
    get cookie() {
      return cookie;
    },
  };
}

export const today = () =>
  new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
export const mondayOf = d => {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7));
  return x.toISOString().slice(0, 10);
};
export const addDays = (d, n) => {
  const x = new Date(d + "T12:00:00Z");
  x.setUTCDate(x.getUTCDate() + n);
  return x.toISOString().slice(0, 10);
};
