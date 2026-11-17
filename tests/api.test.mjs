// Tests d'intégration des routes critiques. Lancer : node --test tests/
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {randomUUID, createECDH, randomBytes} from "node:crypto";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";

let worker, admin, alice, bob, activityId, programId, wodId;
const PASSWORD = "MotDePasse-Test-123";

before(async () => {
  worker = await startWorker();
  admin = client(worker.base);
  alice = client(worker.base);
  bob = client(worker.base);
  assert.equal((await admin.post("/register", {email: ADMIN_EMAIL, password: PASSWORD})).status, 200);
  assert.equal((await alice.post("/register", {email: "alice@test.local", password: PASSWORD})).status, 200);
  assert.equal((await bob.post("/register", {email: "bob@test.local", password: PASSWORD})).status, 200);
  activityId = (await alice.get("/activities")).data.activities[0].id;
  const start = mondayOf(addDays(today(), -14)),
    end = addDays(mondayOf(today()), 7);
  const program = await alice.post("/programs", {name: "Programme test", start, end});
  assert.equal(program.status, 200, JSON.stringify(program.data));
  programId = program.data.id || (await alice.get("/programs")).data.programs.find(p => p.name === "Programme test").id;
  const wod = await alice.post(`/programs/${programId}/wods`, {
    name: "WOD 1 : test",
    activity_id: activityId,
    duration_minutes: 60,
  });
  assert.equal(wod.status, 200, JSON.stringify(wod.data));
  wodId = wod.data.id || (await alice.get(`/programs/${programId}/wods`)).data.wods[0].id;
});
after(() => worker?.stop());

const sessionBody = extra => ({
  program_id: programId,
  wod_id: wodId,
  session_date: today(),
  activity_id: activityId,
  duration_minutes: 60,
  actual_comment: "",
  movement_ids: [],
  catalog_movement_ids: [],
  ...extra,
});

test("connexion : compte, cookie fitfactory_session, déconnexion", async () => {
  const c = client(worker.base);
  assert.equal((await c.post("/login", {email: "alice@test.local", password: PASSWORD})).status, 200);
  assert.match(c.cookie, /^fitfactory_session=/);
  assert.equal((await c.get("/me")).data.user.email, "alice@test.local");
  assert.equal((await c.post("/logout")).status, 200);
  assert.equal((await c.get("/me")).data.user, null);
});

test("ancien cookie cfplanner_session accepté puis remplacé", async () => {
  const c = client(worker.base);
  await c.post("/login", {email: "alice@test.local", password: PASSWORD});
  const token = c.cookie.split("=")[1];
  const res = await fetch(worker.base + "/api/me", {headers: {cookie: "cfplanner_session=" + token}});
  assert.equal((await res.json()).user.email, "alice@test.local");
  const set = res.headers.getSetCookie().join("\n");
  assert.match(set, /fitfactory_session=/);
  assert.match(set, /cfplanner_session=;.*Max-Age=0/);
});

test("trop de tentatives de connexion : blocage après 5 échecs", async () => {
  const c = client(worker.base);
  for (let i = 0; i < 5; i++)
    assert.equal((await c.post("/login", {email: "bob@test.local", password: "faux"})).status, 401);
  const blocked = await c.post("/login", {email: "bob@test.local", password: PASSWORD});
  assert.equal(blocked.status, 429);
  assert.match(blocked.data.error, /Trop de tentatives/);
  // un autre compte depuis une autre adresse n'est pas bloqué
  assert.equal((await client(worker.base).post("/login", {email: "alice@test.local", password: PASSWORD})).status, 200);
});

test("route protégée sans connexion : 401", async () => {
  assert.equal((await client(worker.base).get("/program-data")).status, 401);
});

test("séance : création rejouable sans doublon (client_id)", async () => {
  const id = randomUUID();
  const first = await alice.post("/sessions", sessionBody({client_id: id, actual_comment: "hors ligne"}));
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.id, id);
  const replay = await alice.post("/sessions", sessionBody({client_id: id, actual_comment: "rejeu"}));
  assert.equal(replay.status, 200);
  assert.equal(replay.data.id, id);
  const week = await alice.get(`/week-data?from=${mondayOf(today())}&to=${addDays(mondayOf(today()), 6)}`);
  const same = week.data.sessions.filter(s => s.id === id);
  assert.equal(same.length, 1);
  assert.equal(same[0].actual_comment, "hors ligne");
});

test("séance : date future refusée", async () => {
  const res = await alice.post("/sessions", sessionBody({session_date: addDays(today(), 1)}));
  assert.equal(res.status, 400);
});

test("isolation : un utilisateur ne voit ni ne modifie les données d'un autre", async () => {
  const created = await alice.post("/sessions", sessionBody({client_id: randomUUID()}));
  const sid = created.data.id;
  const week = await bob.get(`/week-data?from=${mondayOf(today())}&to=${addDays(mondayOf(today()), 6)}`);
  assert.equal(week.data.sessions.length, 0);
  const edit = await bob.put(`/sessions/${sid}`, sessionBody({actual_comment: "piraté"}));
  assert.notEqual(edit.status, 200);
  await bob.del(`/sessions/${sid}`);
  const still = await alice.get(`/week-data?from=${mondayOf(today())}&to=${addDays(mondayOf(today()), 6)}`);
  assert.ok(still.data.sessions.some(s => s.id === sid && s.actual_comment !== "piraté"));
  assert.equal(
    (await bob.post(`/programs/${programId}/wods`, {name: "intrus", activity_id: activityId, duration_minutes: 30}))
      .status,
    404
  );
});

test("PR : création rejouable sans doublon (client_id)", async () => {
  const mv = await admin.post("/admin/movements", {name: "Back Squat test", measurement_method: "load"});
  assert.equal(mv.status, 200, JSON.stringify(mv.data));
  const movementId = (await alice.get("/movement-catalog")).data.movements.find(m => m.name === "Back Squat test").id;
  const id = randomUUID(),
    body = {client_id: id, movement_id: movementId, record_date: today(), value: 100, rep_count: 1};
  assert.equal((await alice.post("/prs", body)).data.id, id);
  assert.equal((await alice.post("/prs", {...body, value: 200})).data.id, id);
  const records = (await alice.get("/prs")).data.records.filter(r => r.id === id);
  assert.equal(records.length, 1);
  assert.equal(records[0].value, 100);
});

test("administration réservée au compte ADMIN_EMAIL", async () => {
  assert.equal((await alice.get("/admin/users")).status, 403);
  assert.equal((await admin.get("/admin/users")).status, 200);
});

test("rappels : configuration, validation de l'abonnement et des réglages", async () => {
  const config = await alice.get("/push/config");
  assert.equal(config.status, 200);
  assert.match(config.data.publicKey, /^[\w-]{80,100}$/);
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const keys = {p256dh: ecdh.getPublicKey("base64url"), auth: randomBytes(16).toString("base64url")};
  assert.equal((await alice.post("/push/subscribe", {endpoint: "https://evil.example.com/x", keys})).status, 400);
  assert.equal((await alice.post("/push/subscribe", {endpoint: "https://web.push.apple.com/abc", keys})).status, 200);
  assert.equal((await alice.get("/push/config")).data.devices, 1);
  assert.equal((await alice.put("/push/settings", {days: 9, hour: 3})).status, 400);
  assert.equal((await alice.put("/push/settings", {days: 5, hour: 7})).status, 200);
  const after = (await alice.get("/push/config")).data;
  assert.equal(after.days, 5);
  assert.equal(after.hour, 7);
  assert.equal((await alice.post("/push/unsubscribe", {endpoint: "https://web.push.apple.com/abc"})).status, 200);
  assert.equal((await alice.get("/push/config")).data.devices, 0);
});
