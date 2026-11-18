import {vapidKeys, sendPush, isAllowedEndpoint} from "./push.js";
const SESSION_DAYS = 30,
  enc = new TextEncoder();
const json = (d, s = 200, h = {}) =>
  new Response(JSON.stringify(d), {
    status: s,
    headers: {"content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...h},
  });
const uid = () => crypto.randomUUID();
const b64 = b => {
  let s = "";
  for (const x of new Uint8Array(b)) s += String.fromCharCode(x);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
};
const unb64 = s => {
  s = s.replace(/-/g, "+").replace(/_/g, "/");
  while (s.length % 4) s += "=";
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
};
const sha = async s => b64(await crypto.subtle.digest("SHA-256", enc.encode(s)));
async function hashPass(p, salt = crypto.getRandomValues(new Uint8Array(16))) {
  const k = await crypto.subtle.importKey("raw", enc.encode(p), "PBKDF2", false, ["deriveBits"]);
  const b = await crypto.subtle.deriveBits({name: "PBKDF2", hash: "SHA-256", salt, iterations: 100000}, k, 256);
  return `pbkdf2$100000$${b64(salt)}$${b64(b)}`;
}
async function verify(p, stored) {
  try {
    const [kind, n, s, e] = stored.split("$");
    if (kind !== "pbkdf2" || n !== "100000" || !s || !e) return false;
    const actual = unb64((await hashPass(p, unb64(s))).split("$")[3]),
      expected = unb64(e);
    if (actual.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < actual.length; i++) diff |= actual[i] ^ expected[i];
    return diff === 0;
  } catch {
    return false;
  }
}
const cookie = (r, n) => {
  const v = (r.headers.get("Cookie") || "")
    .split(";")
    .map(x => x.trim())
    .find(x => x.startsWith(n + "="));
  return v ? decodeURIComponent(v.slice(n.length + 1)) : null;
};
// Cookie de session : « fitfactory_session » ; l’ancien nom « cfplanner_session » reste accepté et est remplacé à la requête suivante.
const SESSION_COOKIE = "fitfactory_session",
  LEGACY_SESSION_COOKIE = "cfplanner_session";
const setCookie = (v, age, name = SESSION_COOKIE) =>
  `${name}=${encodeURIComponent(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${age}`;
const sessionToken = r => cookie(r, SESSION_COOKIE) || cookie(r, LEGACY_SESSION_COOKIE);
async function me(r, e) {
  const t = sessionToken(r);
  if (!t) return null;
  return await e.DB.prepare(
    "SELECT u.id,u.email,u.first_name,u.last_name,u.is_admin FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.id_hash=? AND s.expires_at>? AND u.is_active=1"
  )
    .bind(await sha(t), Math.floor(Date.now() / 1000))
    .first();
}
async function session(id, email, e) {
  const t = b64(crypto.getRandomValues(new Uint8Array(32))),
    exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  await e.DB.prepare("INSERT INTO sessions(id_hash,user_id,expires_at) VALUES(?,?,?)")
    .bind(await sha(t), id, exp)
    .run();
  const profile = await e.DB.prepare("SELECT first_name,last_name,is_admin FROM users WHERE id=?").bind(id).first();
  return json(
    {
      ok: true,
      user: {id, email, first_name: profile?.first_name || "", last_name: profile?.last_name || ""},
      is_admin: isAdminUser(e, {email, is_admin: profile?.is_admin}),
    },
    200,
    {"set-cookie": setCookie(t, SESSION_DAYS * 86400)}
  );
}
// Administrateurs : le compte ADMIN_EMAIL (administrateur principal, non modifiable) et les comptes nommés par un admin.
const ownerEmail = e =>
  String(e.ADMIN_EMAIL || "")
    .trim()
    .toLowerCase();
const isAdminUser = (e, u) => !!u && (u.email === ownerEmail(e) || !!u.is_admin);
const validDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));
const addDays = (s, n) => {
  const d = new Date(s + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
function validatePr(movement, value, repCountInput) {
  if (!Number.isFinite(value) || value <= 0) return {error: "Valeur de record invalide."};
  if (movement.measurement_method === "load" || movement.measurement_method === "force") {
    if (value > 10000) return {error: "Valeur de record invalide."};
    const repCount = Number(repCountInput);
    if (!Number.isInteger(repCount) || repCount < 1 || repCount > 20)
      return {error: "Le nombre de RM doit être compris entre 1 et 20."};
    return {repCount};
  }
  if (movement.measurement_method === "reps") {
    if (!Number.isInteger(value) || value > 1000)
      return {error: "Le nombre de répétitions doit être un entier positif."};
    return {repCount: null};
  }
  if (movement.measurement_method === "distance") {
    if (value > 100000) return {error: "La distance doit être inférieure ou égale à 100 000 mètres."};
    return {repCount: null};
  }
  return {error: "Méthode de mesure du mouvement invalide."};
}
const localToday = () => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Paris",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const v = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${v.year}-${v.month}-${v.day}`;
};
// Versioned, additive D1 migrations. Existing V2 databases already carry
// the v2 marker; new databases apply it once, then apply later migrations.
let schemaReady;
async function ensureV2Schema(env) {
  if (schemaReady) return schemaReady;
  schemaReady = (async () => {
    await env.DB.prepare(
      "CREATE TABLE IF NOT EXISTS app_migrations (version TEXT PRIMARY KEY, status TEXT NOT NULL CHECK(status IN ('pending','running','done')), applied_at TEXT)"
    ).run();

    const runMigration = async (version, apply) => {
      const applied = await env.DB.prepare("SELECT version FROM app_migrations WHERE version=? AND status='done'")
        .bind(version)
        .first();
      if (applied) return;
      await env.DB.prepare(
        "INSERT INTO app_migrations(version,status,applied_at) VALUES(?,'running',NULL) ON CONFLICT(version) DO UPDATE SET status='running'"
      )
        .bind(version)
        .run();
      await apply();
      await env.DB.prepare("UPDATE app_migrations SET status='done', applied_at=CURRENT_TIMESTAMP WHERE version=?")
        .bind(version)
        .run();
    };

    await runMigration("v2-schema-20261113", async () => {
      const schemaStatements = [
        "CREATE TABLE IF NOT EXISTS program_wods (id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, planned_comment TEXT NOT NULL DEFAULT '', sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(program_id, name))",
        "CREATE INDEX IF NOT EXISTS program_wods_user_program ON program_wods(user_id, program_id, sort_order)",
        "CREATE TABLE IF NOT EXISTS activities (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, duration_minutes INTEGER NOT NULL DEFAULT 60, is_default INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(user_id,name))",
        "CREATE TABLE IF NOT EXISTS weekly_flags (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, week_start TEXT NOT NULL, competition INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,week_start))",
        "CREATE TABLE IF NOT EXISTS weekly_plans (user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, week_start TEXT NOT NULL, wod_id TEXT NOT NULL REFERENCES program_wods(id) ON DELETE CASCADE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(user_id,week_start,wod_id))",
        "CREATE TABLE IF NOT EXISTS training_sessions (id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, wod_id TEXT NOT NULL REFERENCES program_wods(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, session_date TEXT NOT NULL, actual_comment TEXT NOT NULL DEFAULT '', session_count INTEGER NOT NULL DEFAULT 1 CHECK(session_count >= 1), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        "CREATE INDEX IF NOT EXISTS training_sessions_user_date ON training_sessions(user_id, session_date DESC)",
        "CREATE INDEX IF NOT EXISTS training_sessions_wod_date ON training_sessions(wod_id, session_date DESC)",
        "CREATE TABLE IF NOT EXISTS movement_catalog (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        "CREATE TABLE IF NOT EXISTS personal_records (id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, movement_id TEXT NOT NULL REFERENCES movement_catalog(id) ON DELETE RESTRICT, record_date TEXT NOT NULL, value REAL NOT NULL CHECK(value>0), rep_count INTEGER, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, CHECK(rep_count IS NULL OR rep_count BETWEEN 1 AND 20))",
        "CREATE INDEX IF NOT EXISTS personal_records_user_movement_date ON personal_records(user_id,movement_id,rep_count,record_date)",
        "CREATE TABLE IF NOT EXISTS program_movements (id TEXT PRIMARY KEY, program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(program_id,name))",
        "CREATE INDEX IF NOT EXISTS program_movements_program ON program_movements(program_id,sort_order)",
        "CREATE TABLE IF NOT EXISTS session_movement_checks (session_id TEXT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE, movement_id TEXT NOT NULL REFERENCES program_movements(id) ON DELETE CASCADE, PRIMARY KEY(session_id,movement_id))",
      ];
      for (const statement of schemaStatements) await env.DB.prepare(statement).run();

      const addMissingColumns = async (table, columns) => {
        const info = await env.DB.prepare("PRAGMA table_info(" + table + ")").all();
        const existing = new Set(info.results.map(column => column.name));
        for (const [name, definition] of columns) {
          if (!existing.has(name))
            await env.DB.prepare("ALTER TABLE " + table + " ADD COLUMN " + name + " " + definition).run();
        }
      };
      await addMissingColumns("users", [
        ["first_name", "TEXT NOT NULL DEFAULT ''"],
        ["last_name", "TEXT NOT NULL DEFAULT ''"],
        ["is_active", "INTEGER NOT NULL DEFAULT 1"],
      ]);
      await addMissingColumns("program_wods", [
        ["activity_id", "TEXT"],
        ["duration_minutes", "INTEGER NOT NULL DEFAULT 60"],
      ]);
      await addMissingColumns("program_movements", [["catalog_movement_id", "TEXT"]]);
      await addMissingColumns("movement_catalog", [
        ["measurement_method", "TEXT NOT NULL DEFAULT 'load'"],
        ["sort_order", "INTEGER NOT NULL DEFAULT 0"],
      ]);
      await addMissingColumns("activities", [["sort_order", "INTEGER NOT NULL DEFAULT 0"]]);
      await addMissingColumns("training_sessions", [
        ["activity_id", "TEXT"],
        ["duration_minutes", "INTEGER NOT NULL DEFAULT 60"],
        ["started_at", "TEXT"],
        ["logged_at", "TEXT"],
      ]);
    });

    // Kept separate so databases that already applied V2 receive this index.
    await runMigration("v3-session-movement-index", async () => {
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS session_movement_checks_movement ON session_movement_checks(movement_id)"
      ).run();
    });
    await runMigration("v4-weekly-wod-themes", async () => {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS weekly_wod_themes (program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, week_start TEXT NOT NULL, wod1_theme TEXT NOT NULL DEFAULT '', wod2_theme TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(program_id,week_start))"
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS weekly_wod_themes_user_week ON weekly_wod_themes(user_id,week_start)"
      ).run();
    });
    await runMigration("v5-tracked-wod-programming", async () => {
      const columns = await env.DB.prepare("PRAGMA table_info(program_wods)").all();
      if (!columns.results.some(column => column.name === "is_tracked"))
        await env.DB.prepare("ALTER TABLE program_wods ADD COLUMN is_tracked INTEGER NOT NULL DEFAULT 0").run();
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS weekly_wod_programming (wod_id TEXT NOT NULL REFERENCES program_wods(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, week_start TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY(wod_id,week_start))"
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS weekly_wod_programming_user_week ON weekly_wod_programming(user_id,week_start)"
      ).run();
    });
    await runMigration("v6-default-program", async () => {
      const columns = await env.DB.prepare("PRAGMA table_info(programs)").all();
      if (!columns.results.some(column => column.name === "is_default"))
        await env.DB.prepare("ALTER TABLE programs ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0").run();
      await env.DB.prepare(
        "CREATE UNIQUE INDEX IF NOT EXISTS programs_one_default_per_user ON programs(user_id) WHERE is_default=1"
      ).run();
    });
    await runMigration("v7-session-catalog-movements", async () => {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS session_catalog_movement_checks (session_id TEXT NOT NULL REFERENCES training_sessions(id) ON DELETE CASCADE, catalog_movement_id TEXT NOT NULL REFERENCES movement_catalog(id) ON DELETE CASCADE, PRIMARY KEY(session_id,catalog_movement_id))"
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS session_catalog_movement_checks_movement ON session_catalog_movement_checks(catalog_movement_id)"
      ).run();
    });
    await runMigration("v8-login-attempts", async () => {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS login_attempts (attempt_key TEXT NOT NULL, attempted_at INTEGER NOT NULL)"
      ).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS login_attempts_key_time ON login_attempts(attempt_key, attempted_at)"
      ).run();
    });
    await runMigration("v9-push-reminders", async () => {
      await env.DB.prepare("CREATE TABLE IF NOT EXISTS app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)").run();
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
      ).run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions(user_id)").run();
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS reminder_settings (user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, days INTEGER NOT NULL DEFAULT 3, hour INTEGER NOT NULL DEFAULT 18, last_sent_on TEXT)"
      ).run();
    });
    await runMigration("v10-password-resets", async () => {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS password_resets (token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL, used_at INTEGER)"
      ).run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id)").run();
    });
    await runMigration("v11-hors-programme", async () => {
      // Le programme par défaut sans WOD visible ni mouvement devient le programme technique « Hors programme ».
      await env.DB.prepare(
        "UPDATE programs SET name='Hors programme' WHERE is_default=1 AND NOT EXISTS(SELECT 1 FROM program_wods w WHERE w.program_id=programs.id AND w.name<>'__AUTRES__') AND NOT EXISTS(SELECT 1 FROM program_movements m WHERE m.program_id=programs.id)"
      ).run();
    });
    await runMigration("v12-restore-hors-programme", async () => {
      // Répare le programme technique « Hors programme » dont le marqueur avait été retiré par la modification
      // d'un autre programme (bug corrigé) : il redevient caché, s'il n'y a pas déjà un programme par défaut.
      await env.DB.prepare(
        "UPDATE programs SET is_default=1 WHERE name='Hors programme' AND is_default=0 AND start_monday='1970-01-01' AND end_monday='2100-12-31' AND NOT EXISTS(SELECT 1 FROM program_wods w WHERE w.program_id=programs.id AND w.name<>'__AUTRES__') AND NOT EXISTS(SELECT 1 FROM program_movements mv WHERE mv.program_id=programs.id) AND NOT EXISTS(SELECT 1 FROM programs d WHERE d.user_id=programs.user_id AND d.is_default=1)"
      ).run();
    });
    await runMigration("v13-admins", async () => {
      const columns = await env.DB.prepare("PRAGMA table_info(users)").all();
      if (!columns.results.some(column => column.name === "is_admin"))
        await env.DB.prepare("ALTER TABLE users ADD COLUMN is_admin INTEGER NOT NULL DEFAULT 0").run();
    });
    await runMigration("v14-boxes", async () => {
      for (const statement of [
        "CREATE TABLE IF NOT EXISTS boxes (id TEXT PRIMARY KEY, name TEXT NOT NULL, city TEXT NOT NULL DEFAULT '', created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)",
        "CREATE UNIQUE INDEX IF NOT EXISTS boxes_name ON boxes(name COLLATE NOCASE)",
        "CREATE TABLE IF NOT EXISTS box_members (box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK(role IN ('member','manager')), status TEXT NOT NULL CHECK(status IN ('pending','approved')), created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, decided_at TEXT, PRIMARY KEY(box_id,user_id,role))",
        "CREATE INDEX IF NOT EXISTS box_members_user ON box_members(user_id,role,status)",
        "CREATE INDEX IF NOT EXISTS box_members_box ON box_members(box_id,role,status)",
        "CREATE TABLE IF NOT EXISTS box_categories (id TEXT PRIMARY KEY, box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE, name TEXT NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, UNIQUE(box_id,name))",
      ])
        await env.DB.prepare(statement).run();
    });
    await runMigration("v15-box-wods", async () => {
      await env.DB.prepare(
        "CREATE TABLE IF NOT EXISTS box_wods (id TEXT PRIMARY KEY, box_id TEXT NOT NULL REFERENCES boxes(id) ON DELETE CASCADE, wod_date TEXT NOT NULL, name TEXT NOT NULL, content TEXT NOT NULL DEFAULT '', score_type TEXT NOT NULL DEFAULT 'time' CHECK(score_type IN ('time','reps','load','none')), created_by TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
      ).run();
      await env.DB.prepare("CREATE INDEX IF NOT EXISTS box_wods_box_date ON box_wods(box_id,wod_date)").run();
    });
    await runMigration("v16-session-scores", async () => {
      const columns = new Set(
        (await env.DB.prepare("PRAGMA table_info(training_sessions)").all()).results.map(c => c.name)
      );
      for (const [name, definition] of [
        ["box_wod_id", "TEXT"],
        ["score_value", "REAL"],
        ["score_category_id", "TEXT"],
      ])
        if (!columns.has(name))
          await env.DB.prepare("ALTER TABLE training_sessions ADD COLUMN " + name + " " + definition).run();
      await env.DB.prepare(
        "CREATE INDEX IF NOT EXISTS training_sessions_box_wod ON training_sessions(box_wod_id,score_category_id)"
      ).run();
    });
  })().catch(err => {
    schemaReady = null;
    throw err;
  });
  return schemaReady;
}
// Rappels : notification si aucune séance depuis N jours, envoyée à l'heure choisie (heure de Paris).
const REMINDER_DAYS = [2, 3, 4, 5, 7],
  REMINDER_HOURS = [7, 12, 18, 20];
const parisHour = () =>
  Number(
    new Intl.DateTimeFormat("en-GB", {timeZone: "Europe/Paris", hour: "2-digit", hourCycle: "h23"})
      .formatToParts(new Date())
      .find(x => x.type === "hour").value
  );
const daysBetween = (from, to) => Math.round((new Date(to + "T12:00:00Z") - new Date(from + "T12:00:00Z")) / 86400000);
async function pushToUser(e, userId, message) {
  const subs = (
      await e.DB.prepare("SELECT endpoint,p256dh,auth FROM push_subscriptions WHERE user_id=?").bind(userId).all()
    ).results,
    keys = await vapidKeys(e.DB),
    subject = "mailto:" + (String(e.ADMIN_EMAIL || "").trim() || "admin@fitfactory.invalid");
  let sent = 0;
  for (const sub of subs) {
    try {
      const status = await sendPush(sub, keys, subject, message);
      if (status === 404 || status === 410)
        await e.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=?").bind(sub.endpoint).run();
      else if (status >= 200 && status < 300) sent++;
      else console.error("FitFactory push", {status});
    } catch (err) {
      console.error("FitFactory push", {message: err?.message});
    }
  }
  return {sent, devices: subs.length};
}
async function sendReminders(e) {
  const today = localToday(),
    hour = parisHour();
  const rows = (
    await e.DB.prepare(
      "SELECT rs.user_id,rs.days,(SELECT MAX(session_date) FROM training_sessions s WHERE s.user_id=rs.user_id) AS last_date FROM reminder_settings rs WHERE rs.hour=? AND (rs.last_sent_on IS NULL OR rs.last_sent_on<>?) AND EXISTS(SELECT 1 FROM push_subscriptions p WHERE p.user_id=rs.user_id)"
    )
      .bind(hour, today)
      .all()
  ).results;
  for (const row of rows) {
    const since = row.last_date ? daysBetween(row.last_date, today) : null;
    if (since !== null && since < row.days) continue;
    const body =
      since === null
        ? "Aucune séance enregistrée pour l’instant : on commence aujourd’hui ?"
        : `Aucune séance depuis ${since} jours. On s’y remet aujourd’hui ?`;
    await pushToUser(e, row.user_id, {title: "FitFactory", body, tag: "reminder", url: "/"});
    await e.DB.prepare("UPDATE reminder_settings SET last_sent_on=? WHERE user_id=?").bind(today, row.user_id).run();
  }
}
// Séances « hors programme » : rattachées à un programme technique caché (is_default=1, 1970 → 2100), créé à la demande.
// Le front envoie program_id = "none" ; aucun programme par défaut n'est à créer par l'utilisateur.
async function fallbackProgramId(e, userId) {
  const find = () => e.DB.prepare("SELECT id FROM programs WHERE user_id=? AND is_default=1").bind(userId).first();
  let program = await find();
  if (!program) {
    await e.DB.prepare(
      "INSERT OR IGNORE INTO programs(id,user_id,name,start_monday,end_monday,is_default) VALUES(?,?,'Hors programme','1970-01-01','2100-12-31',1)"
    )
      .bind(uid(), userId)
      .run();
    program = await find();
  }
  return program.id;
}
// Mot de passe oublié : lien à usage unique valable 30 minutes (seule l'empreinte du jeton est gardée en base).
// Envoi par e-mail via Resend si RESEND_API_KEY et MAIL_FROM sont configurés ; sinon le lien est écrit dans les logs
// du Worker (visibles du seul propriétaire du compte Cloudflare) et l'administrateur peut aussi le générer.
const RESET_MINUTES = 30;
async function createResetLink(e, userId, origin) {
  const token = b64(crypto.getRandomValues(new Uint8Array(32)));
  await e.DB.prepare("INSERT INTO password_resets(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .bind(await sha(token), userId, Math.floor(Date.now() / 1000) + RESET_MINUTES * 60)
    .run();
  return origin + "/?reset=" + encodeURIComponent(token);
}
async function sendResetEmail(e, to, link) {
  if (!e.RESEND_API_KEY || !e.MAIL_FROM) {
    console.log("FitFactory réinitialisation (aucun service d’e-mail configuré)", {email: to, lien: link});
    return false;
  }
  const text = `Bonjour,\n\nPour choisir un nouveau mot de passe FitFactory, ouvre ce lien (valable ${RESET_MINUTES} minutes, utilisable une seule fois) :\n${link}\n\nSi tu n’es pas à l’origine de cette demande, ignore simplement ce message.`;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {Authorization: "Bearer " + e.RESEND_API_KEY, "content-type": "application/json"},
    body: JSON.stringify({from: e.MAIL_FROM, to, subject: "Réinitialiser ton mot de passe FitFactory", text}),
  });
  if (!res.ok) console.error("FitFactory e-mail", {status: res.status});
  return res.ok;
}
// Identifiant généré par le téléphone (mode hors ligne) : rend la création rejouable sans doublon.
const clientId = v =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(v || ""))
    ? String(v).toLowerCase()
    : null;
// Box : un utilisateur est membre et/ou gestionnaire d'une box (demande « pending » puis validation « approved »).
// Les adhésions sont validées par un gestionnaire de la box, les gestionnaires par un administrateur.
const DEFAULT_BOX_CATEGORIES = ["RX", "Inter", "Scaled"];
const boxRole = (e, userId, boxId, role) =>
  e.DB.prepare("SELECT 1 FROM box_members WHERE box_id=? AND user_id=? AND role=? AND status='approved'")
    .bind(boxId, userId, role)
    .first();
// Séances : WOD du programme, « Autres » ou WOD d'une box (avec score et catégorie).
const SESSION_SELECT =
  "SELECT s.*,a.name AS activity_name,COALESCE(bw.name,CASE WHEN w.name='__AUTRES__' THEN 'Autres' ELSE w.name END) AS wod_name,COALESCE(bw.content,w.planned_comment) AS planned_comment,p.name AS program_name,bw.box_id,bw.wod_date AS box_wod_date,bw.score_type,bx.name AS box_name,bc.name AS score_category_name FROM training_sessions s JOIN program_wods w ON w.id=s.wod_id JOIN programs p ON p.id=s.program_id LEFT JOIN activities a ON a.id=s.activity_id LEFT JOIN box_wods bw ON bw.id=s.box_wod_id LEFT JOIN boxes bx ON bx.id=bw.box_id LEFT JOIN box_categories bc ON bc.id=s.score_category_id WHERE s.user_id=?";
// Séance sur un WOD de box : l'utilisateur doit être membre validé de la box (sauf s'il modifie une séance
// déjà enregistrée sur ce WOD). Le score dépend du type choisi par le gestionnaire.
async function sessionBoxWod(e, userId, b, sessionId = null) {
  if (!b.box_wod_id) return {wod: null};
  const id = String(b.box_wod_id),
    kept =
      sessionId &&
      (await e.DB.prepare("SELECT 1 FROM training_sessions WHERE id=? AND user_id=? AND box_wod_id=?")
        .bind(sessionId, userId, id)
        .first()),
    wod = await e.DB.prepare(
      "SELECT w.id,w.box_id,w.score_type FROM box_wods w WHERE w.id=? AND (? OR EXISTS(SELECT 1 FROM box_members m WHERE m.box_id=w.box_id AND m.user_id=? AND m.role='member' AND m.status='approved'))"
    )
      .bind(id, kept ? 1 : 0, userId)
      .first();
  if (!wod) return {error: "WOD de box introuvable.", status: 404};
  const raw = b.score_value;
  if (wod.score_type === "none" || raw === null || raw === undefined || raw === "")
    return {wod, value: null, category: null};
  const v = Number(raw);
  if (wod.score_type === "time" && (!Number.isInteger(v) || v < 1 || v > 86400))
    return {error: "Temps invalide.", status: 400};
  if (wod.score_type === "reps" && (!Number.isInteger(v) || v < 1 || v > 100000))
    return {error: "Le nombre de répétitions doit être un entier positif.", status: 400};
  if (wod.score_type === "load" && (!Number.isFinite(v) || v <= 0 || v > 1000))
    return {error: "Charge invalide.", status: 400};
  const category = await e.DB.prepare("SELECT id FROM box_categories WHERE id=? AND box_id=?")
    .bind(String(b.score_category_id || ""), wod.box_id)
    .first();
  if (!category) return {error: "Choisis une catégorie (RX, Scaled…).", status: 400};
  return {wod, value: v, category: category.id};
}
// WOD de box : nom facultatif (« WOD du JJ/MM/AAAA » par défaut), date, contenu et type de score.
const SCORE_TYPES = ["time", "reps", "load", "none"];
const frenchDate = d => d.slice(8, 10) + "/" + d.slice(5, 7) + "/" + d.slice(0, 4);
function boxWodInput(b) {
  const date = String(b.wod_date || ""),
    type = String(b.score_type || "");
  if (!validDate(date)) return {error: "Date du WOD invalide."};
  if (!SCORE_TYPES.includes(type)) return {error: "Type de score invalide."};
  return {
    date,
    type,
    name: boxText(b.name, 100) || "WOD du " + frenchDate(date),
    content: String(b.content || "").slice(0, 3000),
  };
}
// WOD des box dont l'utilisateur est membre validé, entre deux dates.
async function memberBoxWods(e, userId, from, to) {
  return (
    await e.DB.prepare(
      "SELECT w.id,w.box_id,b.name AS box_name,w.wod_date,w.name,w.content,w.score_type FROM box_wods w JOIN boxes b ON b.id=w.box_id JOIN box_members m ON m.box_id=w.box_id AND m.user_id=? AND m.role='member' AND m.status='approved' WHERE w.wod_date>=? AND w.wod_date<=? ORDER BY w.wod_date,w.created_at"
    )
      .bind(userId, from, to)
      .all()
  ).results;
}
// Période de lecture des WOD de box (au plus 93 jours).
function wodRange(r) {
  const q = new URL(r.url).searchParams,
    from = q.get("from"),
    to = q.get("to");
  if (!validDate(from) || !validDate(to) || from > to || daysBetween(from, to) > 92) return null;
  return {from, to};
}
const boxText = (v, max) =>
  String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, max);
// Limitation des tentatives de connexion : 5 échecs par e-mail ou 20 par adresse IP sur 15 minutes.
const LOGIN_WINDOW = 15 * 60,
  LOGIN_LIMITS = {email: 5, ip: 20};
const loginKeys = (r, email) => ({
  email: "email:" + email,
  ip: "ip:" + (r.headers.get("CF-Connecting-IP") || "inconnue"),
});
async function loginWaitMinutes(e, keys) {
  const since = Math.floor(Date.now() / 1000) - LOGIN_WINDOW;
  let wait = 0;
  for (const [kind, key] of Object.entries(keys)) {
    const x = await e.DB.prepare(
      "SELECT COUNT(*) AS n,MIN(attempted_at) AS first FROM login_attempts WHERE attempt_key=? AND attempted_at>?"
    )
      .bind(key, since)
      .first();
    if (x.n >= LOGIN_LIMITS[kind])
      wait = Math.max(wait, Math.ceil((x.first + LOGIN_WINDOW - Math.floor(Date.now() / 1000)) / 60));
  }
  return wait;
}
async function movementCheckStatements(env, userId, sessionId, programId, ids = [], catalogIds = []) {
  const uniqueIds = [...new Set(ids.map(String).filter(Boolean))];
  const validIds = [];
  for (let offset = 0; offset < uniqueIds.length; offset += 100) {
    const chunk = uniqueIds.slice(offset, offset + 100);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = await env.DB.prepare(
      "SELECT id FROM program_movements WHERE program_id=? AND user_id=? AND id IN (" + placeholders + ")"
    )
      .bind(programId, userId, ...chunk)
      .all();
    validIds.push(...rows.results.map(row => row.id));
  }
  // Sans mouvement à travailler dans le programme, la séance peut cocher n'importe quel mouvement du catalogue.
  const validCatalogIds = [];
  const hasProgramMovements = await env.DB.prepare(
    "SELECT 1 FROM program_movements WHERE program_id=? AND user_id=? LIMIT 1"
  )
    .bind(programId, userId)
    .first();
  if (!hasProgramMovements) {
    const uniqueCatalogIds = [...new Set(catalogIds.map(String).filter(Boolean))].slice(0, 200);
    for (let offset = 0; offset < uniqueCatalogIds.length; offset += 100) {
      const chunk = uniqueCatalogIds.slice(offset, offset + 100);
      const rows = await env.DB.prepare(
        "SELECT id FROM movement_catalog WHERE id IN (" + chunk.map(() => "?").join(",") + ")"
      )
        .bind(...chunk)
        .all();
      validCatalogIds.push(...rows.results.map(row => row.id));
    }
  }
  const owned = "EXISTS(SELECT 1 FROM training_sessions WHERE id=? AND user_id=?)";
  return [
    env.DB.prepare("DELETE FROM session_movement_checks WHERE session_id=? AND " + owned).bind(
      sessionId,
      sessionId,
      userId
    ),
    env.DB.prepare("DELETE FROM session_catalog_movement_checks WHERE session_id=? AND " + owned).bind(
      sessionId,
      sessionId,
      userId
    ),
    ...validIds.map(id =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO session_movement_checks(session_id,movement_id) SELECT ?,? WHERE " + owned
      ).bind(sessionId, id, sessionId, userId)
    ),
    ...validCatalogIds.map(id =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO session_catalog_movement_checks(session_id,catalog_movement_id) SELECT ?,? WHERE " +
          owned
      ).bind(sessionId, id, sessionId, userId)
    ),
  ];
}
async function api(r, e, p) {
  const adminEmail = ownerEmail(e);
  if (r.method === "POST" && p === "/api/register") {
    const b = await r.json(),
      email = String(b.email || "")
        .trim()
        .toLowerCase(),
      pw = String(b.password || "");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({error: "Adresse e-mail invalide."}, 400);
    if (pw.length < 12) return json({error: "Mot de passe : 12 caractères minimum."}, 400);
    if (await e.DB.prepare("SELECT id FROM users WHERE email=?").bind(email).first())
      return json({error: "Ce compte existe déjà."}, 409);
    const id = uid();
    await e.DB.prepare("INSERT INTO users(id,email,password_hash) VALUES(?,?,?)")
      .bind(id, email, await hashPass(pw))
      .run();
    return session(id, email, e);
  }
  if (r.method === "POST" && p === "/api/password/forgot") {
    // Réponse identique que le compte existe ou non (pas de divulgation des adresses inscrites).
    const b = await r.json(),
      email = String(b.email || "")
        .trim()
        .toLowerCase()
        .slice(0, 200),
      ip = r.headers.get("CF-Connecting-IP") || "inconnue",
      since = Math.floor(Date.now() / 1000) - 3600,
      count = async key =>
        (
          await e.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE attempt_key=? AND attempted_at>?")
            .bind(key, since)
            .first()
        ).n,
      allowed =
        /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) &&
        (await count("reset:" + email)) < 3 &&
        (await count("reset-ip:" + ip)) < 10;
    if (allowed) {
      const now = Math.floor(Date.now() / 1000);
      await e.DB.batch([
        e.DB.prepare("INSERT INTO login_attempts(attempt_key,attempted_at) VALUES(?,?)").bind("reset:" + email, now),
        e.DB.prepare("INSERT INTO login_attempts(attempt_key,attempted_at) VALUES(?,?)").bind("reset-ip:" + ip, now),
      ]);
      const account = await e.DB.prepare("SELECT id FROM users WHERE email=? AND is_active=1").bind(email).first();
      if (account) await sendResetEmail(e, email, await createResetLink(e, account.id, new URL(r.url).origin));
    }
    return json({ok: true});
  }
  if (r.method === "POST" && p === "/api/password/reset") {
    const b = await r.json(),
      pw = String(b.password || ""),
      token = String(b.token || "").slice(0, 200),
      now = Math.floor(Date.now() / 1000);
    if (pw.length < 12) return json({error: "Mot de passe : 12 caractères minimum."}, 400);
    const hash = await sha(token),
      reset = await e.DB.prepare(
        "SELECT pr.user_id,u.email FROM password_resets pr JOIN users u ON u.id=pr.user_id WHERE pr.token_hash=? AND pr.used_at IS NULL AND pr.expires_at>? AND u.is_active=1"
      )
        .bind(hash, now)
        .first();
    if (!reset) return json({error: "Lien invalide ou expiré : demande un nouveau lien."}, 400);
    await e.DB.batch([
      e.DB.prepare("UPDATE users SET password_hash=? WHERE id=?").bind(await hashPass(pw), reset.user_id),
      e.DB.prepare("UPDATE password_resets SET used_at=? WHERE token_hash=?").bind(now, hash),
      e.DB.prepare("DELETE FROM password_resets WHERE user_id=? AND token_hash<>?").bind(reset.user_id, hash),
      e.DB.prepare("DELETE FROM sessions WHERE user_id=?").bind(reset.user_id),
      e.DB.prepare("DELETE FROM login_attempts WHERE attempt_key=?").bind("email:" + reset.email),
    ]);
    return session(reset.user_id, reset.email, e);
  }
  if (r.method === "POST" && p === "/api/login") {
    const b = await r.json(),
      email = String(b.email || "")
        .trim()
        .toLowerCase()
        .slice(0, 200),
      keys = loginKeys(r, email),
      wait = await loginWaitMinutes(e, keys);
    if (wait > 0)
      return json({error: `Trop de tentatives de connexion. Réessaie dans ${wait} minute${wait > 1 ? "s" : ""}.`}, 429);
    const u = await e.DB.prepare("SELECT id,email,password_hash,is_active FROM users WHERE email=?")
      .bind(email)
      .first();
    if (!u || !u.is_active || !(await verify(String(b.password || ""), u.password_hash))) {
      const now = Math.floor(Date.now() / 1000);
      await e.DB.batch([
        e.DB.prepare("INSERT INTO login_attempts(attempt_key,attempted_at) VALUES(?,?)").bind(keys.email, now),
        e.DB.prepare("INSERT INTO login_attempts(attempt_key,attempted_at) VALUES(?,?)").bind(keys.ip, now),
      ]);
      return json({error: "Identifiants incorrects."}, 401);
    }
    await e.DB.prepare("DELETE FROM login_attempts WHERE attempt_key=?").bind(keys.email).run();
    return session(u.id, u.email, e);
  }
  if (r.method === "POST" && p === "/api/logout") {
    const t = sessionToken(r);
    if (t)
      await e.DB.prepare("DELETE FROM sessions WHERE id_hash=?")
        .bind(await sha(t))
        .run();
    return json({ok: true}, 200, {"set-cookie": setCookie("", 0)});
  }
  if (r.method === "GET" && p === "/api/me") {
    const u = await me(r, e);
    return json({
      user: u ? {id: u.id, email: u.email, first_name: u.first_name, last_name: u.last_name} : null,
      is_admin: isAdminUser(e, u),
    });
  }
  const u = await me(r, e);
  if (!u) return json({error: "Connexion requise."}, 401);
  const admin = isAdminUser(e, u);
  let m;
  if (p.startsWith("/api/push/")) {
    if (r.method === "GET" && p === "/api/push/config") {
      const keys = await vapidKeys(e.DB),
        st = await e.DB.prepare("SELECT days,hour FROM reminder_settings WHERE user_id=?").bind(u.id).first(),
        n = await e.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id=?").bind(u.id).first();
      return json({
        publicKey: keys.publicKey,
        days: st?.days ?? 3,
        hour: st?.hour ?? 18,
        devices: n.n,
        choices: {days: REMINDER_DAYS, hours: REMINDER_HOURS},
      });
    }
    if (r.method === "POST" && p === "/api/push/subscribe") {
      const b = await r.json(),
        endpoint = String(b.endpoint || ""),
        p256dh = String(b.keys?.p256dh || ""),
        auth = String(b.keys?.auth || "");
      if (!isAllowedEndpoint(endpoint) || !/^[\w-]{80,100}$/.test(p256dh) || !/^[\w-]{16,32}$/.test(auth))
        return json({error: "Abonnement aux notifications invalide."}, 400);
      await e.DB.batch([
        e.DB.prepare(
          "INSERT INTO push_subscriptions(endpoint,user_id,p256dh,auth) VALUES(?,?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,p256dh=excluded.p256dh,auth=excluded.auth"
        ).bind(endpoint, u.id, p256dh, auth),
        e.DB.prepare("INSERT OR IGNORE INTO reminder_settings(user_id) VALUES(?)").bind(u.id),
      ]);
      return json({ok: true});
    }
    if (r.method === "POST" && p === "/api/push/unsubscribe") {
      const b = await r.json();
      await e.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=?")
        .bind(String(b.endpoint || ""), u.id)
        .run();
      return json({ok: true});
    }
    if (r.method === "PUT" && p === "/api/push/settings") {
      const b = await r.json(),
        days = Number(b.days),
        hour = Number(b.hour);
      if (!REMINDER_DAYS.includes(days) || !REMINDER_HOURS.includes(hour))
        return json({error: "Réglage de rappel invalide."}, 400);
      await e.DB.prepare(
        "INSERT INTO reminder_settings(user_id,days,hour) VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET days=excluded.days,hour=excluded.hour"
      )
        .bind(u.id, days, hour)
        .run();
      return json({ok: true});
    }
    if (r.method === "POST" && p === "/api/push/test") {
      const x = await pushToUser(e, u.id, {
        title: "FitFactory",
        body: "Les rappels fonctionnent sur cet appareil.",
        tag: "test",
        url: "/",
      });
      return json({ok: true, ...x});
    }
    return json({error: "Route inconnue."}, 404);
  }
  if (r.method === "GET" && p === "/api/activities") {
    const owner = await e.DB.prepare("SELECT id FROM users WHERE email=?").bind(adminEmail).first();
    if (owner) {
      let seed = await e.DB.prepare("SELECT id FROM activities WHERE user_id=? LIMIT 1").bind(owner.id).first();
      if (!seed) {
        await e.DB.prepare(
          "INSERT INTO activities(id,user_id,name,duration_minutes,is_default,is_active) VALUES(?,?,?,?,1,1)"
        )
          .bind(uid(), owner.id, "CrossFit", 60)
          .run();
      }
    }
    const x = owner
      ? await e.DB.prepare(
          "SELECT id,name,duration_minutes,is_default,is_active FROM activities WHERE user_id=? AND is_active=1 ORDER BY is_default DESC,name"
        )
          .bind(owner.id)
          .all()
      : {results: []};
    return json({activities: x.results});
  }
  if (r.method === "GET" && p === "/api/movement-catalog") {
    const x = await e.DB.prepare(
      "SELECT id,name,measurement_method FROM movement_catalog ORDER BY sort_order,name COLLATE NOCASE"
    ).all();
    return json({movements: x.results});
  }
  if (p.startsWith("/api/admin/")) {
    if (!admin) return json({error: "Accès administrateur requis."}, 403);
    // Les activités appartiennent au compte administrateur principal (ADMIN_EMAIL), quel que soit l'admin connecté.
    const ownerId = (await e.DB.prepare("SELECT id FROM users WHERE email=?").bind(adminEmail).first())?.id;
    if (p.startsWith("/api/admin/activities") && !ownerId)
      return json({error: "Le compte administrateur principal n’existe pas encore."}, 409);
    if (r.method === "GET" && p === "/api/admin/movements") {
      const x = await e.DB.prepare(
        "SELECT id,name,measurement_method FROM movement_catalog ORDER BY sort_order,name COLLATE NOCASE"
      ).all();
      return json({movements: x.results});
    }
    if (r.method === "POST" && p === "/api/admin/movements") {
      const b = await r.json(),
        name = String(b.name || "")
          .trim()
          .slice(0, 80),
        method = String(b.measurement_method || "load");
      if (!name) return json({error: "Nom du mouvement requis."}, 400);
      if (!["load", "force", "reps", "distance"].includes(method))
        return json({error: "Méthode de calcul invalide."}, 400);
      const id = uid();
      try {
        await e.DB.prepare(
          "INSERT INTO movement_catalog(id,name,measurement_method,sort_order) VALUES(?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM movement_catalog),0))"
        )
          .bind(id, name, method)
          .run();
      } catch {
        return json({error: "Ce mouvement existe déjà dans le catalogue."}, 409);
      }
      return json({ok: true, id});
    }
    if (r.method === "PUT" && p === "/api/admin/movements/order") {
      const b = await r.json(),
        id = String(b.id || ""),
        d = Number(b.direction);
      if (![-1, 1].includes(d)) return json({error: "Déplacement invalide."}, 400);
      const rows = (await e.DB.prepare("SELECT id FROM movement_catalog ORDER BY sort_order,name COLLATE NOCASE").all())
          .results,
        i = rows.findIndex(x => x.id === id),
        j = i + d;
      if (i < 0 || j < 0 || j >= rows.length) return json({error: "Déplacement impossible."}, 400);
      [rows[i], rows[j]] = [rows[j], rows[i]];
      await e.DB.batch(
        rows.map((x, n) => e.DB.prepare("UPDATE movement_catalog SET sort_order=? WHERE id=?").bind(n, x.id))
      );
      return json({ok: true});
    }
    if (r.method === "PUT" && (m = p.match(/^\/api\/admin\/movements\/([\w-]+)$/))) {
      const b = await r.json(),
        name = String(b.name || "")
          .trim()
          .slice(0, 80),
        method = String(b.measurement_method || "load");
      if (!name) return json({error: "Nom du mouvement requis."}, 400);
      if (!["load", "force", "reps", "distance"].includes(method))
        return json({error: "Méthode de calcul invalide."}, 400);
      const current = await e.DB.prepare("SELECT measurement_method FROM movement_catalog WHERE id=?")
        .bind(m[1])
        .first();
      if (!current) return json({error: "Mouvement introuvable."}, 404);
      const existingPr = await e.DB.prepare("SELECT id FROM personal_records WHERE movement_id=? LIMIT 1")
        .bind(m[1])
        .first();
      if (existingPr) {
        const loadFamily = ["load", "force"];
        if (
          current.measurement_method !== method &&
          !(loadFamily.includes(current.measurement_method) && loadFamily.includes(method))
        )
          return json(
            {
              error:
                "Impossible de changer cette catégorie : ce mouvement possède déjà des PR. Seul le passage entre Lift et Force est autorisé.",
            },
            409
          );
      }
      try {
        const result = await e.DB.prepare("UPDATE movement_catalog SET name=?,measurement_method=? WHERE id=?")
          .bind(name, method, m[1])
          .run();
        if (!result.meta?.changes) return json({error: "Mouvement introuvable."}, 404);
      } catch {
        return json({error: "Ce mouvement existe déjà dans le catalogue."}, 409);
      }
      return json({ok: true});
    }
    if (r.method === "DELETE" && (m = p.match(/^\/api\/admin\/movements\/([\w-]+)$/))) {
      const used = await e.DB.prepare(
        "SELECT 1 FROM program_movements WHERE catalog_movement_id=? UNION ALL SELECT 1 FROM session_catalog_movement_checks WHERE catalog_movement_id=? LIMIT 1"
      )
        .bind(m[1], m[1])
        .first();
      if (used)
        return json(
          {error: "Suppression impossible : ce mouvement est utilisé dans au moins un programme ou une séance."},
          409
        );
      const usedInPr = await e.DB.prepare("SELECT id FROM personal_records WHERE movement_id=? LIMIT 1")
        .bind(m[1])
        .first();
      if (usedInPr) return json({error: "Suppression impossible : ce mouvement possède des PR enregistrés."}, 409);
      await e.DB.prepare("DELETE FROM movement_catalog WHERE id=?").bind(m[1]).run();
      return json({ok: true});
    }
    if (r.method === "GET" && p === "/api/admin/users") {
      const x = await e.DB.prepare(
        "SELECT id,email,first_name,last_name,is_active,is_admin,email=? AS is_owner FROM users ORDER BY email"
      )
        .bind(adminEmail)
        .all();
      return json({users: x.results});
    }
    if (r.method === "POST" && (m = p.match(/^\/api\/admin\/users\/([\w-]+)\/reset-link$/))) {
      const target = await e.DB.prepare("SELECT id FROM users WHERE id=? AND is_active=1").bind(m[1]).first();
      if (!target) return json({error: "Utilisateur introuvable ou inactif."}, 404);
      return json({ok: true, link: await createResetLink(e, target.id, new URL(r.url).origin), minutes: RESET_MINUTES});
    }
    if (r.method === "PUT" && (m = p.match(/^\/api\/admin\/users\/([\w-]+)$/))) {
      const b = await r.json(),
        target = await e.DB.prepare("SELECT id,email FROM users WHERE id=?").bind(m[1]).first();
      if (!target) return json({error: "Utilisateur introuvable."}, 404);
      if (b.is_active !== undefined) {
        if (target.id === u.id || target.email === adminEmail)
          return json({error: "Impossible de désactiver ce compte administrateur."}, 400);
        await e.DB.prepare("UPDATE users SET is_active=? WHERE id=?")
          .bind(b.is_active ? 1 : 0, m[1])
          .run();
      }
      if (b.is_admin !== undefined) {
        if (target.email === adminEmail)
          return json({error: "Le compte administrateur principal reste toujours administrateur."}, 400);
        if (target.id === u.id && !b.is_admin)
          return json({error: "Tu ne peux pas retirer tes propres droits d’administration."}, 400);
        await e.DB.prepare("UPDATE users SET is_admin=? WHERE id=?")
          .bind(b.is_admin ? 1 : 0, m[1])
          .run();
      }
      return json({ok: true});
    }
    if (r.method === "PUT" && p === "/api/admin/activities/order") {
      const b = await r.json(),
        id = String(b.id || ""),
        d = Number(b.direction);
      if (![-1, 1].includes(d)) return json({error: "Déplacement invalide."}, 400);
      const rows = (
          await e.DB.prepare("SELECT id FROM activities WHERE user_id=? ORDER BY sort_order,is_default DESC,name")
            .bind(ownerId)
            .all()
        ).results,
        i = rows.findIndex(x => x.id === id),
        j = i + d;
      if (i < 0 || j < 0 || j >= rows.length) return json({error: "Déplacement impossible."}, 400);
      [rows[i], rows[j]] = [rows[j], rows[i]];
      await e.DB.batch(
        rows.map((x, n) =>
          e.DB.prepare("UPDATE activities SET sort_order=? WHERE id=? AND user_id=?").bind(n, x.id, ownerId)
        )
      );
      return json({ok: true});
    }
    if (r.method === "DELETE" && (m = p.match(/^\/api\/admin\/activities\/([\w-]+)$/))) {
      const activity = await e.DB.prepare("SELECT id,is_default FROM activities WHERE id=? AND user_id=?")
        .bind(m[1], ownerId)
        .first();
      if (!activity) return json({error: "Activité introuvable."}, 404);
      const used =
        (await e.DB.prepare("SELECT id FROM program_wods WHERE activity_id=? LIMIT 1").bind(m[1]).first()) ||
        (await e.DB.prepare("SELECT id FROM training_sessions WHERE activity_id=? LIMIT 1").bind(m[1]).first());
      if (used) {
        if (activity.is_default)
          return json(
            {
              error:
                "Cette activité est utilisée. Définis d’abord une autre activité par défaut pour pouvoir la désactiver.",
            },
            400
          );
        await e.DB.prepare("UPDATE activities SET is_active=0 WHERE id=? AND user_id=?").bind(m[1], ownerId).run();
        return json({ok: true, action: "deactivated"});
      }
      const result = await e.DB.prepare("DELETE FROM activities WHERE id=? AND user_id=?").bind(m[1], ownerId).run();
      if (!result.meta?.changes) return json({error: "Activité introuvable."}, 404);
      return json({ok: true, action: "deleted"});
    }
    if (r.method === "GET" && p === "/api/admin/activities") {
      const x = await e.DB.prepare("SELECT * FROM activities WHERE user_id=? ORDER BY sort_order,is_default DESC,name")
        .bind(ownerId)
        .all();
      return json({activities: x.results});
    }
    if (r.method === "POST" && p === "/api/admin/activities") {
      const b = await r.json(),
        name = String(b.name || "")
          .trim()
          .slice(0, 80),
        duration = Number(b.duration_minutes);
      if (!name || !Number.isInteger(duration) || duration < 1 || duration > 600)
        return json({error: "Nom et durée valides requis."}, 400);
      const id = uid();
      if (b.is_default) await e.DB.prepare("UPDATE activities SET is_default=0 WHERE user_id=?").bind(ownerId).run();
      await e.DB.prepare(
        "INSERT INTO activities(id,user_id,name,duration_minutes,is_default,sort_order) VALUES(?,?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM activities WHERE user_id=?),0))"
      )
        .bind(id, ownerId, name, duration, b.is_default ? 1 : 0, ownerId)
        .run();
      return json({ok: true, id});
    }
    if (r.method === "PUT" && (m = p.match(/^\/api\/admin\/activities\/([\w-]+)$/))) {
      const b = await r.json(),
        a = await e.DB.prepare("SELECT id FROM activities WHERE id=? AND user_id=?").bind(m[1], ownerId).first();
      if (!a) return json({error: "Activité introuvable."}, 404);
      if (b.is_active === false && a.is_default)
        return json({error: "Définis une autre activité par défaut avant de désactiver celle-ci."}, 400);
      if (b.is_default) await e.DB.prepare("UPDATE activities SET is_default=0 WHERE user_id=?").bind(ownerId).run();
      const sets = [],
        args = [];
      if (b.name !== undefined) {
        sets.push("name=?");
        args.push(String(b.name).trim().slice(0, 80));
      }
      if (b.duration_minutes !== undefined) {
        const d = Number(b.duration_minutes);
        if (!Number.isInteger(d) || d < 1 || d > 600) return json({error: "Durée invalide."}, 400);
        sets.push("duration_minutes=?");
        args.push(d);
      }
      if (b.is_active !== undefined) {
        sets.push("is_active=?");
        args.push(b.is_active ? 1 : 0);
      }
      if (b.is_default !== undefined) {
        sets.push("is_default=?");
        args.push(b.is_default ? 1 : 0);
      }
      if (sets.length)
        await e.DB.prepare("UPDATE activities SET " + sets.join(",") + " WHERE id=? AND user_id=?")
          .bind(...args, m[1], ownerId)
          .run();
      return json({ok: true});
    }
    if (r.method === "GET" && p === "/api/admin/boxes") {
      const [boxes, people] = await Promise.all([
        e.DB.prepare(
          "SELECT b.id,b.name,b.city,(SELECT COUNT(*) FROM box_members m WHERE m.box_id=b.id AND m.role='member' AND m.status='approved') AS members FROM boxes b ORDER BY b.name COLLATE NOCASE"
        ).all(),
        e.DB.prepare(
          "SELECT m.box_id,m.user_id,m.status,m.created_at,u.email,u.first_name,u.last_name FROM box_members m JOIN users u ON u.id=m.user_id WHERE m.role='manager' ORDER BY m.created_at"
        ).all(),
      ]);
      return json({boxes: boxes.results, managers: people.results});
    }
    if (r.method === "POST" && p === "/api/admin/boxes") {
      const b = await r.json(),
        name = boxText(b.name, 80),
        city = boxText(b.city, 80),
        id = uid();
      if (!name) return json({error: "Nom de la box requis."}, 400);
      try {
        await e.DB.batch([
          e.DB.prepare("INSERT INTO boxes(id,name,city) VALUES(?,?,?)").bind(id, name, city),
          ...DEFAULT_BOX_CATEGORIES.map((c, i) =>
            e.DB.prepare("INSERT INTO box_categories(id,box_id,name,sort_order) VALUES(?,?,?,?)").bind(uid(), id, c, i)
          ),
        ]);
      } catch {
        return json({error: "Une box porte déjà ce nom."}, 409);
      }
      return json({ok: true, id});
    }
    if (r.method === "PUT" && (m = p.match(/^\/api\/admin\/boxes\/([\w-]+)$/))) {
      const b = await r.json(),
        name = boxText(b.name, 80),
        city = boxText(b.city, 80);
      if (!name) return json({error: "Nom de la box requis."}, 400);
      try {
        const result = await e.DB.prepare("UPDATE boxes SET name=?,city=? WHERE id=?").bind(name, city, m[1]).run();
        if (!result.meta?.changes) return json({error: "Box introuvable."}, 404);
      } catch {
        return json({error: "Une box porte déjà ce nom."}, 409);
      }
      return json({ok: true});
    }
    if (r.method === "DELETE" && (m = p.match(/^\/api\/admin\/boxes\/([\w-]+)$/))) {
      const used = await e.DB.prepare(
        "SELECT 1 FROM training_sessions s JOIN box_wods w ON w.id=s.box_wod_id WHERE w.box_id=? LIMIT 1"
      )
        .bind(m[1])
        .first();
      if (used)
        return json({error: "Des séances sont enregistrées sur les WOD de cette box : suppression impossible."}, 409);
      await e.DB.prepare("DELETE FROM boxes WHERE id=?").bind(m[1]).run();
      return json({ok: true});
    }
    // Demande de gestionnaire : validation (approve=true, le gestionnaire devient aussi membre) ou refus/retrait.
    if (r.method === "PUT" && (m = p.match(/^\/api\/admin\/boxes\/([\w-]+)\/managers\/([\w-]+)$/))) {
      const b = await r.json(),
        row = await e.DB.prepare("SELECT status FROM box_members WHERE box_id=? AND user_id=? AND role='manager'")
          .bind(m[1], m[2])
          .first();
      if (!row) return json({error: "Demande introuvable."}, 404);
      if (b.approve)
        await e.DB.batch([
          e.DB.prepare(
            "UPDATE box_members SET status='approved',decided_at=CURRENT_TIMESTAMP WHERE box_id=? AND user_id=? AND role='manager'"
          ).bind(m[1], m[2]),
          e.DB.prepare(
            "INSERT INTO box_members(box_id,user_id,role,status,decided_at) VALUES(?,?,'member','approved',CURRENT_TIMESTAMP) ON CONFLICT(box_id,user_id,role) DO UPDATE SET status='approved',decided_at=CURRENT_TIMESTAMP"
          ).bind(m[1], m[2]),
        ]);
      else
        await e.DB.prepare("DELETE FROM box_members WHERE box_id=? AND user_id=? AND role='manager'")
          .bind(m[1], m[2])
          .run();
      return json({ok: true});
    }
    return json({error: "Route admin inconnue."}, 404);
  }
  if (r.method === "GET" && p === "/api/boxes") {
    const [boxes, mine, categories] = await Promise.all([
      e.DB.prepare("SELECT id,name,city FROM boxes ORDER BY name COLLATE NOCASE").all(),
      e.DB.prepare("SELECT box_id,role,status FROM box_members WHERE user_id=?").bind(u.id).all(),
      e.DB.prepare(
        "SELECT c.id,c.box_id,c.name FROM box_categories c JOIN box_members m ON m.box_id=c.box_id AND m.user_id=? AND m.role='member' AND m.status='approved' ORDER BY c.box_id,c.sort_order,c.name"
      )
        .bind(u.id)
        .all(),
    ]);
    return json({boxes: boxes.results, memberships: mine.results, categories: categories.results});
  }
  // Demande d'adhésion (role=member) ou de gestion (role=manager) : rejouable sans effet (mode hors ligne).
  if ((m = p.match(/^\/api\/boxes\/([\w-]+)\/requests$/)) && (r.method === "POST" || r.method === "DELETE")) {
    const b = await r.json(),
      role = b.role === "manager" ? "manager" : b.role === "member" ? "member" : null;
    if (!role) return json({error: "Type de demande invalide."}, 400);
    if (!(await e.DB.prepare("SELECT 1 FROM boxes WHERE id=?").bind(m[1]).first()))
      return json({error: "Box introuvable."}, 404);
    if (r.method === "DELETE") {
      await e.DB.prepare("DELETE FROM box_members WHERE box_id=? AND user_id=? AND role=?")
        .bind(m[1], u.id, role)
        .run();
      return json({ok: true});
    }
    if (!String(u.first_name || "").trim() || !String(u.last_name || "").trim())
      return json({error: "Renseigne ton prénom et ton nom dans Mon compte avant de rejoindre une box."}, 400);
    await e.DB.prepare("INSERT OR IGNORE INTO box_members(box_id,user_id,role,status) VALUES(?,?,?,'pending')")
      .bind(m[1], u.id, role)
      .run();
    return json({ok: true});
  }
  // WOD des box dont l'utilisateur est membre validé, sur une période.
  if (r.method === "GET" && p === "/api/box-wods") {
    const range = wodRange(r);
    if (!range) return json({error: "Période invalide."}, 400);
    return json({wods: await memberBoxWods(e, u.id, range.from, range.to)});
  }
  // Classement d'un WOD de box : meilleur score de chaque membre actuel de la box, par catégorie.
  if (r.method === "GET" && (m = p.match(/^\/api\/box-wods\/([\w-]+)\/leaderboard$/))) {
    const wod = await e.DB.prepare(
      "SELECT w.id,w.box_id,b.name AS box_name,w.wod_date,w.name,w.content,w.score_type FROM box_wods w JOIN boxes b ON b.id=w.box_id WHERE w.id=? AND EXISTS(SELECT 1 FROM box_members m WHERE m.box_id=w.box_id AND m.user_id=? AND m.role='member' AND m.status='approved')"
    )
      .bind(m[1], u.id)
      .first();
    if (!wod) return json({error: "WOD de box introuvable."}, 404);
    const [categories, rows] = await Promise.all([
      e.DB.prepare("SELECT id,name FROM box_categories WHERE box_id=? ORDER BY sort_order,name").bind(wod.box_id).all(),
      e.DB.prepare(
        "SELECT s.user_id,u.first_name,u.last_name,s.score_category_id AS category_id," +
          (wod.score_type === "time" ? "MIN" : "MAX") +
          "(s.score_value) AS score FROM training_sessions s JOIN users u ON u.id=s.user_id JOIN box_members m ON m.box_id=? AND m.user_id=s.user_id AND m.role='member' AND m.status='approved' WHERE s.box_wod_id=? AND s.score_value IS NOT NULL AND s.score_category_id IS NOT NULL GROUP BY s.user_id,s.score_category_id"
      )
        .bind(wod.box_id, wod.id)
        .all(),
    ]);
    const better = wod.score_type === "time" ? (a, b) => a.score - b.score : (a, b) => b.score - a.score;
    return json({
      wod,
      categories: categories.results.map(c => ({
        ...c,
        rows: rows.results
          .filter(x => x.category_id === c.id)
          .sort(better)
          .map(x => ({
            first_name: x.first_name,
            last_name: x.last_name,
            score: x.score,
            is_me: x.user_id === u.id ? 1 : 0,
          })),
      })),
    });
  }
  if (p.startsWith("/api/manage/")) {
    // Espace gestionnaire : chaque route vérifie que l'utilisateur gère la box concernée.
    const managed = async boxId => !!boxId && !!(await boxRole(e, u.id, boxId, "manager"));
    const deny = () => json({error: "Box introuvable."}, 404);
    if (r.method === "GET" && (m = p.match(/^\/api\/manage\/boxes\/([\w-]+)$/))) {
      if (!(await managed(m[1]))) return deny();
      const [box, members, categories] = await Promise.all([
        e.DB.prepare("SELECT id,name,city FROM boxes WHERE id=?").bind(m[1]).first(),
        e.DB.prepare(
          "SELECT m.user_id,m.status,m.created_at,u.first_name,u.last_name,u.email,EXISTS(SELECT 1 FROM box_members g WHERE g.box_id=m.box_id AND g.user_id=m.user_id AND g.role='manager' AND g.status='approved') AS is_manager FROM box_members m JOIN users u ON u.id=m.user_id WHERE m.box_id=? AND m.role='member' ORDER BY u.last_name COLLATE NOCASE,u.first_name COLLATE NOCASE"
        )
          .bind(m[1])
          .all(),
        e.DB.prepare("SELECT id,name,sort_order FROM box_categories WHERE box_id=? ORDER BY sort_order,name")
          .bind(m[1])
          .all(),
      ]);
      return json({box, members: members.results, categories: categories.results});
    }
    if ((m = p.match(/^\/api\/manage\/boxes\/([\w-]+)\/members\/([\w-]+)$/))) {
      if (!(await managed(m[1]))) return deny();
      if (r.method === "PUT") {
        const b = await r.json();
        if (b.approve) {
          const result = await e.DB.prepare(
            "UPDATE box_members SET status='approved',decided_at=CURRENT_TIMESTAMP WHERE box_id=? AND user_id=? AND role='member'"
          )
            .bind(m[1], m[2])
            .run();
          if (!result.meta?.changes) return json({error: "Demande introuvable."}, 404);
          return json({ok: true});
        }
      }
      if (r.method === "PUT" || r.method === "DELETE") {
        if (await boxRole(e, m[2], m[1], "manager"))
          return json({error: "Un gestionnaire de la box ne peut pas être retiré des membres."}, 400);
        await e.DB.prepare("DELETE FROM box_members WHERE box_id=? AND user_id=? AND role='member'")
          .bind(m[1], m[2])
          .run();
        return json({ok: true});
      }
    }
    if ((m = p.match(/^\/api\/manage\/boxes\/([\w-]+)\/wods$/)) && (r.method === "GET" || r.method === "POST")) {
      if (!(await managed(m[1]))) return deny();
      if (r.method === "GET") {
        const range = wodRange(r);
        if (!range) return json({error: "Période invalide."}, 400);
        const x = await e.DB.prepare(
          "SELECT id,box_id,wod_date,name,content,score_type FROM box_wods WHERE box_id=? AND wod_date>=? AND wod_date<=? ORDER BY wod_date,created_at"
        )
          .bind(m[1], range.from, range.to)
          .all();
        return json({wods: x.results});
      }
      const b = await r.json(),
        input = boxWodInput(b),
        id = clientId(b.client_id) || uid();
      if (input.error) return json({error: input.error}, 400);
      if (await e.DB.prepare("SELECT 1 FROM box_wods WHERE id=?").bind(id).first()) return json({ok: true, id});
      await e.DB.prepare(
        "INSERT INTO box_wods(id,box_id,wod_date,name,content,score_type,created_by) VALUES(?,?,?,?,?,?,?)"
      )
        .bind(id, m[1], input.date, input.name, input.content, input.type, u.id)
        .run();
      return json({ok: true, id});
    }
    if ((m = p.match(/^\/api\/manage\/wods\/([\w-]+)$/)) && (r.method === "PUT" || r.method === "DELETE")) {
      const wod = await e.DB.prepare("SELECT id,box_id FROM box_wods WHERE id=?").bind(m[1]).first();
      if (!wod || !(await managed(wod.box_id))) return json({error: "WOD introuvable."}, 404);
      if (r.method === "DELETE") {
        if (await e.DB.prepare("SELECT 1 FROM training_sessions WHERE box_wod_id=? LIMIT 1").bind(m[1]).first())
          return json({error: "Ce WOD a déjà été réalisé par des membres et ne peut plus être supprimé."}, 409);
        await e.DB.prepare("DELETE FROM box_wods WHERE id=?").bind(m[1]).run();
        return json({ok: true});
      }
      const input = boxWodInput(await r.json());
      if (input.error) return json({error: input.error}, 400);
      await e.DB.prepare(
        "UPDATE box_wods SET wod_date=?,name=?,content=?,score_type=?,updated_at=CURRENT_TIMESTAMP WHERE id=?"
      )
        .bind(input.date, input.name, input.content, input.type, m[1])
        .run();
      return json({ok: true});
    }
    if (r.method === "POST" && (m = p.match(/^\/api\/manage\/boxes\/([\w-]+)\/categories$/))) {
      if (!(await managed(m[1]))) return deny();
      const b = await r.json(),
        name = boxText(b.name, 40),
        id = clientId(b.client_id) || uid();
      if (!name) return json({error: "Nom de la catégorie requis."}, 400);
      if (await e.DB.prepare("SELECT 1 FROM box_categories WHERE id=? AND box_id=?").bind(id, m[1]).first())
        return json({ok: true, id});
      try {
        await e.DB.prepare(
          "INSERT INTO box_categories(id,box_id,name,sort_order) VALUES(?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM box_categories WHERE box_id=?),0))"
        )
          .bind(id, m[1], name, m[1])
          .run();
      } catch {
        return json({error: "Cette catégorie existe déjà."}, 409);
      }
      return json({ok: true, id});
    }
    if (r.method === "PUT" && (m = p.match(/^\/api\/manage\/boxes\/([\w-]+)\/categories\/order$/))) {
      if (!(await managed(m[1]))) return deny();
      const b = await r.json(),
        ids = Array.isArray(b.ids) ? b.ids.map(String) : [],
        current = (await e.DB.prepare("SELECT id FROM box_categories WHERE box_id=?").bind(m[1]).all()).results;
      if (
        !ids.length ||
        new Set(ids).size !== ids.length ||
        current.length !== ids.length ||
        current.some(x => !ids.includes(x.id))
      )
        return json({error: "La liste a changé. Actualise la page."}, 409);
      await e.DB.batch(
        ids.map((id, i) =>
          e.DB.prepare("UPDATE box_categories SET sort_order=? WHERE id=? AND box_id=?").bind(i, id, m[1])
        )
      );
      return json({ok: true});
    }
    if ((m = p.match(/^\/api\/manage\/categories\/([\w-]+)$/)) && (r.method === "PUT" || r.method === "DELETE")) {
      const category = await e.DB.prepare("SELECT id,box_id FROM box_categories WHERE id=?").bind(m[1]).first();
      if (!category || !(await managed(category.box_id))) return json({error: "Catégorie introuvable."}, 404);
      if (r.method === "PUT") {
        const name = boxText((await r.json()).name, 40);
        if (!name) return json({error: "Nom de la catégorie requis."}, 400);
        try {
          await e.DB.prepare("UPDATE box_categories SET name=? WHERE id=?").bind(name, m[1]).run();
        } catch {
          return json({error: "Cette catégorie existe déjà."}, 409);
        }
        return json({ok: true});
      }
      if (
        (await e.DB.prepare("SELECT COUNT(*) AS n FROM box_categories WHERE box_id=?").bind(category.box_id).first())
          .n <= 1
      )
        return json({error: "La box doit garder au moins une catégorie."}, 400);
      if (await e.DB.prepare("SELECT 1 FROM training_sessions WHERE score_category_id=? LIMIT 1").bind(m[1]).first())
        return json({error: "Des scores utilisent cette catégorie : elle ne peut plus être supprimée."}, 409);
      await e.DB.prepare("DELETE FROM box_categories WHERE id=?").bind(m[1]).run();
      return json({ok: true});
    }
    return json({error: "Route inconnue."}, 404);
  }
  if (r.method === "GET" && p === "/api/prs") {
    const x = await e.DB.prepare(
      "SELECT pr.id,pr.movement_id,mc.name AS movement_name,mc.measurement_method,pr.record_date,pr.value,pr.rep_count,pr.created_at FROM personal_records pr JOIN movement_catalog mc ON mc.id=pr.movement_id WHERE pr.user_id=? ORDER BY pr.record_date,pr.created_at"
    )
      .bind(u.id)
      .all();
    return json({records: x.results});
  }
  if (r.method === "POST" && p === "/api/prs") {
    const b = await r.json(),
      cid = clientId(b.client_id);
    if (cid && (await e.DB.prepare("SELECT 1 FROM personal_records WHERE id=? AND user_id=?").bind(cid, u.id).first()))
      return json({ok: true, id: cid});
    const movementId = String(b.movement_id || ""),
      date = b.record_date,
      value = Number(b.value),
      movement = await e.DB.prepare("SELECT id,measurement_method FROM movement_catalog WHERE id=?")
        .bind(movementId)
        .first();
    if (!movement) return json({error: "Mouvement introuvable dans le catalogue."}, 404);
    if (!validDate(date) || date > localToday()) return json({error: "Date de PR invalide."}, 400);
    const validation = validatePr(movement, value, b.rep_count);
    if (validation.error) return json({error: validation.error}, 400);
    const id = cid || uid();
    await e.DB.prepare(
      "INSERT INTO personal_records(id,user_id,movement_id,record_date,value,rep_count) VALUES(?,?,?,?,?,?)"
    )
      .bind(id, u.id, movementId, date, value, validation.repCount)
      .run();
    return json({ok: true, id});
  }
  if (r.method === "PUT" && (m = p.match(/^\/api\/prs\/([\w-]+)$/))) {
    const b = await r.json(),
      date = b.record_date,
      value = Number(b.value),
      movementId = String(b.movement_id || ""),
      movement = await e.DB.prepare("SELECT id,measurement_method FROM movement_catalog WHERE id=?")
        .bind(movementId)
        .first();
    if (!movement) return json({error: "Mouvement introuvable dans le catalogue."}, 404);
    const owned = await e.DB.prepare("SELECT id FROM personal_records WHERE id=? AND user_id=?")
      .bind(m[1], u.id)
      .first();
    if (!owned) return json({error: "PR introuvable."}, 404);
    if (!validDate(date) || date > localToday()) return json({error: "Date de PR invalide."}, 400);
    const validation = validatePr(movement, value, b.rep_count);
    if (validation.error) return json({error: validation.error}, 400);
    await e.DB.prepare(
      "UPDATE personal_records SET movement_id=?,record_date=?,value=?,rep_count=? WHERE id=? AND user_id=?"
    )
      .bind(movementId, date, value, validation.repCount, m[1], u.id)
      .run();
    return json({ok: true});
  }
  if (r.method === "DELETE" && (m = p.match(/^\/api\/prs\/([\w-]+)$/))) {
    const result = await e.DB.prepare("DELETE FROM personal_records WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    if (!result.meta?.changes) return json({error: "PR introuvable."}, 404);
    return json({ok: true});
  }
  if (r.method === "PUT" && p === "/api/profile") {
    const b = await r.json(),
      first = String(b.first_name || "")
        .trim()
        .slice(0, 80),
      last = String(b.last_name || "")
        .trim()
        .slice(0, 80);
    if (!first || !last) return json({error: "Prénom et nom sont obligatoires."}, 400);
    await e.DB.prepare("UPDATE users SET first_name=?,last_name=? WHERE id=?").bind(first, last, u.id).run();
    return json({ok: true, user: {...u, first_name: first, last_name: last}});
  }
  if (r.method === "GET" && p === "/api/weekly-flags") {
    const q = new URL(r.url).searchParams,
      from = q.get("from"),
      to = q.get("to");
    if (!validDate(from) || !validDate(to)) return json({error: "Période invalide."}, 400);
    const x = await e.DB.prepare(
      "SELECT week_start,competition FROM weekly_flags WHERE user_id=? AND week_start>=? AND week_start<=?"
    )
      .bind(u.id, from, to)
      .all();
    return json({flags: x.results});
  }
  if (r.method === "PUT" && p === "/api/weekly-flags") {
    const b = await r.json(),
      week = b.week_start;
    if (!validDate(week) || new Date(week + "T12:00:00Z").getUTCDay() !== 1)
      return json({error: "La semaine doit commencer un lundi."}, 400);
    await e.DB.prepare(
      "INSERT INTO weekly_flags(user_id,week_start,competition,updated_at) VALUES(?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(user_id,week_start) DO UPDATE SET competition=excluded.competition,updated_at=CURRENT_TIMESTAMP"
    )
      .bind(u.id, week, b.competition ? 1 : 0)
      .run();
    return json({ok: true});
  }
  if (r.method === "GET" && p === "/api/weekly-plans") {
    const q = new URL(r.url).searchParams,
      from = q.get("from"),
      to = q.get("to");
    if (!validDate(from) || !validDate(to)) return json({error: "Période invalide."}, 400);
    const x = await e.DB.prepare(
      "SELECT wp.week_start,wp.wod_id,w.name AS wod_name FROM weekly_plans wp JOIN program_wods w ON w.id=wp.wod_id WHERE wp.user_id=? AND wp.week_start>=? AND wp.week_start<=?"
    )
      .bind(u.id, from, to)
      .all();
    return json({plans: x.results});
  }
  if (r.method === "POST" && p === "/api/weekly-plans") {
    const b = await r.json(),
      week = b.week_start,
      wodId = String(b.wod_id || "");
    if (!validDate(week) || new Date(week + "T12:00:00Z").getUTCDay() !== 1)
      return json({error: "La semaine doit commencer un lundi."}, 400);
    const wod = await e.DB.prepare("SELECT id FROM program_wods WHERE id=? AND user_id=? AND name<>'__AUTRES__'")
      .bind(wodId, u.id)
      .first();
    if (!wod) return json({error: "WOD introuvable."}, 404);
    const program = await e.DB.prepare(
      "SELECT p.start_monday,p.end_monday FROM program_wods w JOIN programs p ON p.id=w.program_id WHERE w.id=? AND p.user_id=?"
    )
      .bind(wodId, u.id)
      .first();
    if (
      !program ||
      week > program.end_monday ||
      new Date(week + "T12:00:00Z") < new Date(program.start_monday + "T12:00:00Z")
    )
      return json({error: "Ce WOD ne fait pas partie du programme de cette semaine."}, 400);
    await e.DB.prepare("INSERT OR IGNORE INTO weekly_plans(user_id,week_start,wod_id) VALUES(?,?,?)")
      .bind(u.id, week, wodId)
      .run();
    return json({ok: true});
  }
  if (r.method === "DELETE" && p === "/api/weekly-plans") {
    const b = await r.json();
    if (!validDate(b.week_start) || !b.wod_id) return json({error: "Planification invalide."}, 400);
    await e.DB.prepare("DELETE FROM weekly_plans WHERE user_id=? AND week_start=? AND wod_id=?")
      .bind(u.id, b.week_start, String(b.wod_id))
      .run();
    return json({ok: true});
  }
  if (r.method === "GET" && p === "/api/program-data") {
    const [p, w, mv, wp] = await Promise.all([
      e.DB.prepare(
        "SELECT p.*,EXISTS(SELECT 1 FROM training_sessions s WHERE s.program_id=p.id AND s.user_id=p.user_id) AS has_sessions FROM programs p WHERE p.user_id=? ORDER BY is_default ASC,start_monday DESC"
      )
        .bind(u.id)
        .all(),
      e.DB.prepare(
        "SELECT w.*,EXISTS(SELECT 1 FROM training_sessions s WHERE s.wod_id=w.id AND s.user_id=w.user_id) AS has_sessions FROM program_wods w WHERE w.user_id=? ORDER BY w.program_id,w.sort_order,w.created_at"
      )
        .bind(u.id)
        .all(),
      e.DB.prepare("SELECT * FROM program_movements WHERE user_id=? ORDER BY program_id,sort_order,created_at")
        .bind(u.id)
        .all(),
      e.DB.prepare("SELECT wod_id,week_start,content FROM weekly_wod_programming WHERE user_id=? ORDER BY week_start")
        .bind(u.id)
        .all(),
    ]);
    const wods = {},
      movements = {};
    for (const row of w.results) (wods[row.program_id] ??= []).push(row);
    for (const row of mv.results) (movements[row.program_id] ??= []).push(row);
    return json({programs: p.results, wods, movements, weeklyWodPrograms: wp.results});
  }
  if (r.method === "GET" && p === "/api/programs") {
    const x = await e.DB.prepare("SELECT * FROM programs WHERE user_id=? ORDER BY is_default ASC,start_monday DESC")
      .bind(u.id)
      .all();
    return json({programs: x.results});
  }
  if (r.method === "POST" && p === "/api/programs") {
    const b = await r.json(),
      name = String(b.name || "")
        .trim()
        .slice(0, 100),
      isDefault = !!b.is_default,
      start = isDefault ? "1970-01-01" : b.start,
      end = isDefault ? "2100-12-31" : b.end;
    if (!name || !validDate(start) || !validDate(end) || start > end)
      return json({error: "Vérifie le nom et les dates."}, 400);
    if (!isDefault) {
      const overlap = await e.DB.prepare(
        "SELECT id FROM programs WHERE user_id=? AND is_default=0 AND NOT(end_monday<? OR start_monday>?)"
      )
        .bind(u.id, start, end)
        .first();
      if (overlap) return json({error: "Les dates chevauchent un autre programme."}, 409);
    }
    const id = uid();
    if (isDefault)
      await e.DB.batch([
        e.DB.prepare("UPDATE programs SET is_default=0 WHERE user_id=? AND is_default=1").bind(u.id),
        e.DB.prepare(
          "INSERT INTO programs(id,user_id,name,start_monday,end_monday,is_default) VALUES(?,?,?,?,?,1)"
        ).bind(id, u.id, name, start, end),
      ]);
    else
      await e.DB.prepare("INSERT INTO programs(id,user_id,name,start_monday,end_monday,is_default) VALUES(?,?,?,?,?,0)")
        .bind(id, u.id, name, start, end)
        .run();
    return json({ok: true, id});
  }
  m = p.match(/^\/api\/programs\/([\w-]+)\/movements$/);
  if (m && r.method === "GET") {
    const x = await e.DB.prepare(
      "SELECT * FROM program_movements WHERE program_id=? AND user_id=? ORDER BY sort_order,created_at"
    )
      .bind(m[1], u.id)
      .all();
    return json({movements: x.results});
  }
  if (m && r.method === "POST") {
    const b = await r.json(),
      pid = m[1],
      ok = await e.DB.prepare("SELECT id FROM programs WHERE id=? AND user_id=?").bind(pid, u.id).first();
    if (!ok) return json({error: "Programme introuvable."}, 404);
    const item = await e.DB.prepare("SELECT id,name FROM movement_catalog WHERE id=?")
      .bind(String(b.catalog_movement_id || ""))
      .first();
    if (!item) return json({error: "Sélectionne un mouvement du catalogue."}, 400);
    const catalogId = item.id,
      name = item.name;
    const id = uid();
    try {
      await e.DB.prepare(
        "INSERT INTO program_movements(id,program_id,user_id,name,sort_order,catalog_movement_id) VALUES(?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM program_movements WHERE program_id=?),0),?)"
      )
        .bind(id, pid, u.id, name, pid, catalogId)
        .run();
    } catch {
      return json({error: "Ce mouvement existe déjà dans le programme."}, 409);
    }
    return json({ok: true, id});
  }
  m = p.match(/^\/api\/movements\/([\w-]+)$/);
  if (m && r.method === "PUT") {
    const b = await r.json(),
      name = String(b.name || "")
        .trim()
        .slice(0, 80);
    if (!name) return json({error: "Libellé du mouvement requis."}, 400);
    try {
      const result = await e.DB.prepare("UPDATE program_movements SET name=? WHERE id=? AND user_id=?")
        .bind(name, m[1], u.id)
        .run();
      if (!result.meta?.changes) return json({error: "Mouvement introuvable."}, 404);
    } catch {
      return json({error: "Ce mouvement existe déjà dans le programme."}, 409);
    }
    return json({ok: true});
  }
  if (m && r.method === "DELETE") {
    await e.DB.prepare("DELETE FROM program_movements WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    return json({ok: true});
  }
  if (r.method === "GET" && p === "/api/movement-checks") {
    const q = new URL(r.url).searchParams,
      from = q.get("from"),
      to = q.get("to");
    if (!validDate(from) || !validDate(to) || from > to)
      return json({error: "Une période de dates est obligatoire."}, 400);
    const x = await e.DB.prepare(
      "SELECT c.session_id,c.movement_id FROM session_movement_checks c JOIN training_sessions s ON s.id=c.session_id WHERE s.user_id=? AND s.session_date>=? AND s.session_date<=?"
    )
      .bind(u.id, from, to)
      .all();
    return json({checks: x.results});
  }
  m = p.match(/^\/api\/programs\/([\w-]+)\/order$/);
  if (m && r.method === "PUT") {
    const pid = m[1],
      b = await r.json(),
      kind = b.kind,
      ids = Array.isArray(b.ids) ? b.ids.map(String) : [];
    if (!["wod", "movement"].includes(kind) || !ids.length || new Set(ids).size !== ids.length)
      return json({error: "Ordre invalide."}, 400);
    const table = kind === "wod" ? "program_wods" : "program_movements";
    const owned = await e.DB.prepare("SELECT id FROM programs WHERE id=? AND user_id=?").bind(pid, u.id).first();
    if (!owned) return json({error: "Programme introuvable."}, 404);
    const current = await e.DB.prepare(
      "SELECT id FROM " + table + " WHERE program_id=? AND user_id=? ORDER BY sort_order,created_at"
    )
      .bind(pid, u.id)
      .all();
    if (current.results.length !== ids.length || current.results.some(x => !ids.includes(x.id)))
      return json({error: "La liste a changé. Actualise la page."}, 409);
    await e.DB.batch(
      ids.map((id, i) =>
        e.DB.prepare("UPDATE " + table + " SET sort_order=? WHERE id=? AND program_id=? AND user_id=?").bind(
          i,
          id,
          pid,
          u.id
        )
      )
    );
    return json({ok: true});
  }
  m = p.match(/^\/api\/programs\/([\w-]+)$/);
  if (m && r.method === "PUT") {
    const b = await r.json(),
      name = String(b.name || "")
        .trim()
        .slice(0, 100),
      isDefault = !!b.is_default,
      start = isDefault ? "1970-01-01" : b.start,
      end = isDefault ? "2100-12-31" : b.end;
    if (!name || !validDate(start) || !validDate(end) || start > end)
      return json({error: "Vérifie le nom et les dates."}, 400);
    const exists = await e.DB.prepare("SELECT id FROM programs WHERE id=? AND user_id=?").bind(m[1], u.id).first();
    if (!exists) return json({error: "Programme introuvable."}, 404);
    if (!isDefault) {
      const overlap = await e.DB.prepare(
        "SELECT id FROM programs WHERE user_id=? AND id<>? AND is_default=0 AND NOT(end_monday<? OR start_monday>?)"
      )
        .bind(u.id, m[1], start, end)
        .first();
      if (overlap) return json({error: "Les dates chevauchent un autre programme."}, 409);
    }
    // Le marqueur « par défaut » (programme technique « Hors programme ») n'est déplacé que si ce programme le demande :
    // modifier un programme ordinaire ne doit jamais retirer le marqueur du programme technique.
    await e.DB.batch([
      ...(isDefault
        ? [e.DB.prepare("UPDATE programs SET is_default=0 WHERE user_id=? AND is_default=1 AND id<>?").bind(u.id, m[1])]
        : []),
      e.DB.prepare("UPDATE programs SET name=?,start_monday=?,end_monday=?,is_default=? WHERE id=? AND user_id=?").bind(
        name,
        start,
        end,
        isDefault ? 1 : 0,
        m[1],
        u.id
      ),
    ]);
    return json({ok: true});
  }
  if (m && r.method === "DELETE") {
    const completed = await e.DB.prepare("SELECT 1 FROM training_sessions WHERE program_id=? AND user_id=? LIMIT 1")
      .bind(m[1], u.id)
      .first();
    if (completed) return json({error: "Ce programme a déjà une séance réalisée et ne peut plus être supprimé."}, 409);
    await e.DB.prepare("DELETE FROM programs WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    return json({ok: true});
  }
  m = p.match(/^\/api\/programs\/([\w-]+)\/weekly-themes$/);
  if (m && r.method === "PUT") {
    const b = await r.json(),
      week = b.week_start,
      wod1 = String(b.wod1_theme || "").slice(0, 2000),
      wod2 = String(b.wod2_theme || "").slice(0, 2000);
    if (!validDate(week) || new Date(week + "T12:00:00Z").getUTCDay() !== 1)
      return json({error: "La semaine doit commencer un lundi."}, 400);
    const program = await e.DB.prepare("SELECT id,start_monday,end_monday FROM programs WHERE id=? AND user_id=?")
      .bind(m[1], u.id)
      .first();
    if (!program) return json({error: "Programme introuvable."}, 404);
    if (addDays(week, 6) < program.start_monday || week > program.end_monday)
      return json({error: "Cette semaine est hors période du programme."}, 400);
    await e.DB.prepare(
      "INSERT INTO weekly_wod_themes(program_id,user_id,week_start,wod1_theme,wod2_theme,updated_at) VALUES(?,?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(program_id,week_start) DO UPDATE SET wod1_theme=excluded.wod1_theme,wod2_theme=excluded.wod2_theme,updated_at=CURRENT_TIMESTAMP"
    )
      .bind(m[1], u.id, week, wod1, wod2)
      .run();
    return json({ok: true});
  }
  m = p.match(/^\/api\/programs\/([\w-]+)\/wods$/);
  if (m && r.method === "GET") {
    const x = await e.DB.prepare(
      "SELECT * FROM program_wods WHERE program_id=? AND user_id=? ORDER BY sort_order,created_at"
    )
      .bind(m[1], u.id)
      .all();
    return json({wods: x.results});
  }
  if (m && r.method === "POST") {
    const b = await r.json(),
      name = String(b.name || "")
        .trim()
        .slice(0, 100),
      comment = String(b.planned_comment || "").slice(0, 3000),
      activity = await e.DB.prepare(
        "SELECT id FROM activities WHERE id=? AND user_id=(SELECT id FROM users WHERE email=?) AND is_active=1"
      )
        .bind(b.activity_id, adminEmail)
        .first(),
      duration = Number(b.duration_minutes);
    if (!activity || !Number.isInteger(duration) || duration < 1 || duration > 600)
      return json({error: "Activité ou durée invalide."}, 400);
    if (!name) return json({error: "Nom du WOD requis."}, 400);
    const pid = m[1],
      ok = await e.DB.prepare("SELECT id FROM programs WHERE id=? AND user_id=?").bind(pid, u.id).first();
    if (!ok) return json({error: "Programme introuvable."}, 404);
    const id = uid();
    try {
      await e.DB.prepare(
        "INSERT INTO program_wods(id,program_id,user_id,name,planned_comment,activity_id,duration_minutes,is_tracked,sort_order) VALUES(?,?,?,?,?,?,?,?,COALESCE((SELECT MAX(sort_order)+1 FROM program_wods WHERE program_id=?),0))"
      )
        .bind(id, pid, u.id, name, comment, b.activity_id, duration, b.is_tracked ? 1 : 0, pid)
        .run();
    } catch {
      return json({error: "Un WOD porte déjà ce nom dans ce programme."}, 409);
    }
    return json({ok: true, id});
  }
  m = p.match(/^\/api\/wods\/([\w-]+)\/weekly-programming$/);
  if (m && r.method === "PUT") {
    const b = await r.json(),
      week = b.week_start,
      content = String(b.content || "").slice(0, 2000);
    if (!validDate(week) || new Date(week + "T12:00:00Z").getUTCDay() !== 1)
      return json({error: "La semaine doit commencer un lundi."}, 400);
    const wod = await e.DB.prepare(
      "SELECT w.id,w.is_tracked,p.start_monday,p.end_monday FROM program_wods w JOIN programs p ON p.id=w.program_id WHERE w.id=? AND w.user_id=? AND p.user_id=?"
    )
      .bind(m[1], u.id, u.id)
      .first();
    if (!wod) return json({error: "WOD introuvable."}, 404);
    if (!wod.is_tracked) return json({error: "Ce WOD n'est pas marqué comme suivi."}, 400);
    if (addDays(week, 6) < wod.start_monday || week > wod.end_monday)
      return json({error: "Cette semaine est hors période du programme."}, 400);
    await e.DB.prepare(
      "INSERT INTO weekly_wod_programming(wod_id,user_id,week_start,content,updated_at) VALUES(?,?,?,?,CURRENT_TIMESTAMP) ON CONFLICT(wod_id,week_start) DO UPDATE SET content=excluded.content,updated_at=CURRENT_TIMESTAMP"
    )
      .bind(m[1], u.id, week, content)
      .run();
    return json({ok: true});
  }
  m = p.match(/^\/api\/wods\/([\w-]+)$/);
  if (m && r.method === "PUT") {
    const b = await r.json(),
      name = String(b.name || "")
        .trim()
        .slice(0, 100),
      activity = await e.DB.prepare(
        "SELECT id FROM activities WHERE id=? AND user_id=(SELECT id FROM users WHERE email=?) AND is_active=1"
      )
        .bind(b.activity_id, adminEmail)
        .first(),
      duration = Number(b.duration_minutes);
    if (!name) return json({error: "Nom requis."}, 400);
    if (!activity || !Number.isInteger(duration) || duration < 1 || duration > 600)
      return json({error: "Activité ou durée invalide."}, 400);
    try {
      const result = await e.DB.prepare(
        "UPDATE program_wods SET name=?,planned_comment=?,activity_id=?,duration_minutes=?,is_tracked=? WHERE id=? AND user_id=?"
      )
        .bind(
          name,
          String(b.planned_comment || "").slice(0, 3000),
          b.activity_id,
          duration,
          b.is_tracked ? 1 : 0,
          m[1],
          u.id
        )
        .run();
      if (!result.meta?.changes) return json({error: "WOD introuvable."}, 404);
    } catch {
      return json({error: "Ce nom de WOD existe déjà dans le programme."}, 409);
    }
    return json({ok: true});
  }
  if (m && r.method === "DELETE") {
    const completed = await e.DB.prepare("SELECT 1 FROM training_sessions WHERE wod_id=? AND user_id=? LIMIT 1")
      .bind(m[1], u.id)
      .first();
    if (completed) return json({error: "Ce WOD a déjà été réalisé et ne peut plus être supprimé."}, 409);
    await e.DB.prepare("DELETE FROM program_wods WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    return json({ok: true});
  }
  if (r.method === "GET" && p === "/api/export-data") {
    const [programs, wods, movements, sessions, checks, catalogChecks] = await Promise.all([
      e.DB.prepare("SELECT id,name,start_monday,end_monday FROM programs WHERE user_id=? ORDER BY start_monday,name")
        .bind(u.id)
        .all(),
      e.DB.prepare(
        "SELECT id,program_id,name,sort_order FROM program_wods WHERE user_id=? AND name<>'__AUTRES__' ORDER BY program_id,sort_order,created_at"
      )
        .bind(u.id)
        .all(),
      e.DB.prepare(
        "SELECT id,program_id,name,sort_order FROM program_movements WHERE user_id=? ORDER BY program_id,sort_order,created_at"
      )
        .bind(u.id)
        .all(),
      e.DB.prepare(
        "SELECT s.id,s.program_id,s.wod_id,s.session_date FROM training_sessions s WHERE s.user_id=? ORDER BY s.session_date,s.id"
      )
        .bind(u.id)
        .all(),
      e.DB.prepare(
        "SELECT c.session_id,c.movement_id,pm.name AS movement_name FROM session_movement_checks c JOIN training_sessions s ON s.id=c.session_id JOIN program_movements pm ON pm.id=c.movement_id WHERE s.user_id=? ORDER BY pm.sort_order,pm.name"
      )
        .bind(u.id)
        .all(),
      e.DB.prepare(
        "SELECT c.session_id,c.catalog_movement_id,mc.name AS movement_name FROM session_catalog_movement_checks c JOIN training_sessions s ON s.id=c.session_id JOIN movement_catalog mc ON mc.id=c.catalog_movement_id WHERE s.user_id=? ORDER BY mc.sort_order,mc.name"
      )
        .bind(u.id)
        .all(),
    ]);
    return json({
      programs: programs.results,
      wods: wods.results,
      movements: movements.results,
      sessions: sessions.results,
      checks: checks.results,
      catalogChecks: catalogChecks.results,
    });
  }
  if (r.method === "GET" && p === "/api/week-data") {
    const q = new URL(r.url).searchParams,
      from = q.get("from"),
      to = q.get("to");
    if (!validDate(from) || !validDate(to) || from > to) return json({error: "Période invalide."}, 400);
    const [s, f, pl, c, cc, bw] = await Promise.all([
      e.DB.prepare(
        SESSION_SELECT + " AND s.session_date>=? AND s.session_date<=? ORDER BY s.session_date DESC,s.created_at DESC"
      )
        .bind(u.id, from, to)
        .all(),
      e.DB.prepare(
        "SELECT week_start,competition FROM weekly_flags WHERE user_id=? AND week_start>=? AND week_start<=?"
      )
        .bind(u.id, from, to)
        .all(),
      e.DB.prepare(
        "SELECT wp.week_start,wp.wod_id,w.name AS wod_name FROM weekly_plans wp JOIN program_wods w ON w.id=wp.wod_id WHERE wp.user_id=? AND wp.week_start>=? AND wp.week_start<=?"
      )
        .bind(u.id, from, to)
        .all(),
      e.DB.prepare(
        "SELECT c.session_id,c.movement_id FROM session_movement_checks c JOIN training_sessions s ON s.id=c.session_id WHERE s.user_id=? AND s.session_date>=? AND s.session_date<=?"
      )
        .bind(u.id, from, to)
        .all(),
      e.DB.prepare(
        "SELECT c.session_id,c.catalog_movement_id FROM session_catalog_movement_checks c JOIN training_sessions s ON s.id=c.session_id WHERE s.user_id=? AND s.session_date>=? AND s.session_date<=?"
      )
        .bind(u.id, from, to)
        .all(),
      daysBetween(from, to) <= 92 ? memberBoxWods(e, u.id, from, to) : [],
    ]);
    return json({
      sessions: s.results,
      flags: f.results,
      plans: pl.results,
      checks: c.results,
      catalogChecks: cc.results,
      boxWods: bw,
    });
  }
  if (r.method === "GET" && p === "/api/sessions") {
    const q = new URL(r.url).searchParams,
      from = q.get("from"),
      to = q.get("to");
    let sql = SESSION_SELECT;
    const args = [u.id];
    if (validDate(from)) {
      sql += " AND s.session_date>=?";
      args.push(from);
    }
    if (validDate(to)) {
      sql += " AND s.session_date<=?";
      args.push(to);
    }
    sql += " ORDER BY s.session_date DESC,s.created_at DESC";
    const x = await e.DB.prepare(sql)
      .bind(...args)
      .all();
    return json({sessions: x.results});
  }
  if (r.method === "POST" && p === "/api/sessions") {
    const b = await r.json(),
      cid = clientId(b.client_id);
    if (cid && (await e.DB.prepare("SELECT 1 FROM training_sessions WHERE id=? AND user_id=?").bind(cid, u.id).first()))
      return json({ok: true, id: cid});
    // WOD de box : la séance est rattachée au programme technique « Hors programme » (WOD « Autres »).
    const box = await sessionBoxWod(e, u.id, b);
    if (box.error) return json({error: box.error}, box.status);
    if (box.wod) {
      b.program_id = "none";
      b.wod_id = "other";
    }
    const date = b.session_date,
      pid = b.program_id === "none" ? await fallbackProgramId(e, u.id) : b.program_id;
    let wid = b.wod_id;
    const act = await e.DB.prepare(
        "SELECT id FROM activities WHERE id=? AND user_id=(SELECT id FROM users WHERE email=?) AND is_active=1"
      )
        .bind(b.activity_id, adminEmail)
        .first(),
      duration = Number(b.duration_minutes);
    if (!act || !Number.isInteger(duration) || duration < 1 || duration > 600)
      return json({error: "Activité ou durée invalide."}, 400);
    if (!validDate(date)) return json({error: "Date invalide."}, 400);
    if (date > localToday()) return json({error: "Impossible d’enregistrer une séance à une date future."}, 400);
    const program = await e.DB.prepare("SELECT id,start_monday,end_monday FROM programs WHERE id=? AND user_id=?")
      .bind(pid, u.id)
      .first();
    if (!program) return json({error: "Programme introuvable."}, 404);
    if (date < program.start_monday || date > program.end_monday)
      return json({error: "La date de la séance doit être comprise dans la période du programme."}, 400);
    if (wid === "other") {
      let w = await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'")
        .bind(pid, u.id)
        .first();
      if (!w) {
        const id = uid();
        await e.DB.prepare(
          "INSERT OR IGNORE INTO program_wods(id,program_id,user_id,name,planned_comment,sort_order) VALUES(?,?,?,'__AUTRES__','',999999)"
        )
          .bind(id, pid, u.id)
          .run();
        w = await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'")
          .bind(pid, u.id)
          .first();
      }
      wid = w.id;
    }
    const w = await e.DB.prepare("SELECT id,program_id FROM program_wods WHERE id=? AND user_id=?")
      .bind(wid, u.id)
      .first();
    if (!w || w.program_id !== pid) return json({error: "WOD ou programme invalide."}, 400);
    const id = cid || uid(),
      checks = await movementCheckStatements(
        e,
        u.id,
        id,
        pid,
        Array.isArray(b.movement_ids) ? b.movement_ids : [],
        Array.isArray(b.catalog_movement_ids) ? b.catalog_movement_ids : []
      );
    await e.DB.batch([
      e.DB.prepare(
        "INSERT INTO training_sessions(id,program_id,wod_id,user_id,session_date,actual_comment,activity_id,duration_minutes,started_at,logged_at,box_wod_id,score_value,score_category_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)"
      ).bind(
        id,
        pid,
        wid,
        u.id,
        date,
        String(b.actual_comment || "").slice(0, 3000),
        b.activity_id,
        duration,
        typeof b.started_at === "string" && !Number.isNaN(Date.parse(b.started_at))
          ? new Date(b.started_at).toISOString()
          : new Date(Date.now() - duration * 60000).toISOString(),
        new Date().toISOString(),
        box.wod?.id || null,
        box.value ?? null,
        box.category ?? null
      ),
      ...checks,
    ]);
    return json({ok: true, id});
  }
  m = p.match(/^\/api\/sessions\/([\w-]+)$/);
  if (m && r.method === "PUT") {
    const b = await r.json(),
      box = await sessionBoxWod(e, u.id, b, m[1]);
    if (box.error) return json({error: box.error}, box.status);
    if (box.wod) {
      b.program_id = "none";
      b.wod_id = "other";
    }
    if (b.program_id === "none") b.program_id = await fallbackProgramId(e, u.id);
    if (!validDate(b.session_date)) return json({error: "Date invalide."}, 400);
    const act = await e.DB.prepare(
        "SELECT id FROM activities WHERE id=? AND user_id=(SELECT id FROM users WHERE email=?) AND is_active=1"
      )
        .bind(b.activity_id, adminEmail)
        .first(),
      duration = Number(b.duration_minutes);
    if (!act || !Number.isInteger(duration) || duration < 1 || duration > 600)
      return json({error: "Activité ou durée invalide."}, 400);
    if (b.session_date > localToday())
      return json({error: "Impossible d’enregistrer une séance à une date future."}, 400);
    const program = await e.DB.prepare("SELECT id,start_monday,end_monday FROM programs WHERE id=? AND user_id=?")
      .bind(b.program_id, u.id)
      .first();
    if (!program) return json({error: "Programme introuvable."}, 404);
    if (b.session_date < program.start_monday || b.session_date > program.end_monday)
      return json({error: "La date de la séance doit être comprise dans la période du programme."}, 400);
    let wid = b.wod_id;
    if (wid === "other") {
      let w = await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'")
        .bind(b.program_id, u.id)
        .first();
      if (!w) {
        const id = uid();
        await e.DB.prepare(
          "INSERT OR IGNORE INTO program_wods(id,program_id,user_id,name,planned_comment,sort_order) VALUES(?,?,?,'__AUTRES__','',999999)"
        )
          .bind(id, b.program_id, u.id)
          .run();
        w = await e.DB.prepare("SELECT id FROM program_wods WHERE program_id=? AND user_id=? AND name='__AUTRES__'")
          .bind(b.program_id, u.id)
          .first();
      }
      wid = w.id;
    }
    const w = await e.DB.prepare("SELECT id,program_id FROM program_wods WHERE id=? AND user_id=?")
      .bind(wid, u.id)
      .first();
    if (!w || w.program_id !== b.program_id) return json({error: "WOD ou programme invalide."}, 400);
    const checks = await movementCheckStatements(
      e,
      u.id,
      m[1],
      b.program_id,
      Array.isArray(b.movement_ids) ? b.movement_ids : [],
      Array.isArray(b.catalog_movement_ids) ? b.catalog_movement_ids : []
    );
    await e.DB.batch([
      e.DB.prepare(
        "UPDATE training_sessions SET program_id=?,wod_id=?,session_date=?,actual_comment=?,activity_id=?,duration_minutes=?,started_at=?,logged_at=?,box_wod_id=?,score_value=?,score_category_id=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?"
      ).bind(
        b.program_id,
        wid,
        b.session_date,
        String(b.actual_comment || "").slice(0, 3000),
        b.activity_id,
        duration,
        typeof b.started_at === "string" && !Number.isNaN(Date.parse(b.started_at))
          ? new Date(b.started_at).toISOString()
          : new Date(Date.now() - duration * 60000).toISOString(),
        new Date().toISOString(),
        box.wod?.id || null,
        box.value ?? null,
        box.category ?? null,
        m[1],
        u.id
      ),
      ...checks,
    ]);
    return json({ok: true});
  }
  if (m && r.method === "DELETE") {
    await e.DB.prepare("DELETE FROM training_sessions WHERE id=? AND user_id=?").bind(m[1], u.id).run();
    return json({ok: true});
  }
  if (r.method === "GET" && p === "/api/stats") {
    const x = await e.DB.prepare(
      "SELECT w.id,w.name,w.planned_comment,COUNT(s.id) AS sessions_count,COALESCE(SUM(s.session_count),0) AS total_sessions FROM program_wods w LEFT JOIN training_sessions s ON s.wod_id=w.id AND s.user_id=w.user_id WHERE w.user_id=? AND w.name<>'__AUTRES__' GROUP BY w.id ORDER BY total_sessions DESC,w.name"
    )
      .bind(u.id)
      .all();
    return json({stats: x.results});
  }
  return json({error: "Route inconnue."}, 404);
}
export default {
  async scheduled(controller, e, ctx) {
    const now = Math.floor(Date.now() / 1000);
    ctx.waitUntil(
      ensureV2Schema(e).then(() =>
        controller.cron === "17 3 * * *"
          ? e.DB.batch([
              e.DB.prepare("DELETE FROM sessions WHERE expires_at<=?").bind(now),
              e.DB.prepare("DELETE FROM login_attempts WHERE attempted_at<=?").bind(now - 86400),
              e.DB.prepare("DELETE FROM password_resets WHERE expires_at<=?").bind(now - 86400),
            ])
          : sendReminders(e)
      )
    );
  },
  async fetch(r, e) {
    const u = new URL(r.url);
    if (!u.pathname.startsWith("/api/")) return e.ASSETS.fetch(r);
    try {
      await ensureV2Schema(e);
      const res = await api(r, e, u.pathname),
        legacy = cookie(r, LEGACY_SESSION_COOKIE);
      if (legacy) {
        if (!cookie(r, SESSION_COOKIE) && !res.headers.has("set-cookie"))
          res.headers.append("set-cookie", setCookie(legacy, SESSION_DAYS * 86400));
        res.headers.append("set-cookie", setCookie("", 0, LEGACY_SESSION_COOKIE));
      }
      return res;
    } catch (err) {
      console.error("FitFactory", {name: err?.name, message: err?.message, stack: err?.stack, cause: err?.cause});
      return json({error: "Erreur serveur. Réessaie."}, 500);
    }
  },
};
