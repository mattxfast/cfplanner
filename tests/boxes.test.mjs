// Tests d'intégration : administrateurs multiples, box, gestionnaires, adhésions, WOD de box, scores, programmes publics.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {startWorker, client, ADMIN_EMAIL} from "./helpers.mjs";

let worker, admin, alice, bob, carol;
const PASSWORD = "MotDePasse-Test-123";
const idOf = async email => (await admin.get("/admin/users")).data.users.find(u => u.email === email).id;

before(async () => {
  worker = await startWorker();
  admin = client(worker.base);
  alice = client(worker.base);
  bob = client(worker.base);
  carol = client(worker.base);
  assert.equal((await admin.post("/register", {email: ADMIN_EMAIL, password: PASSWORD})).status, 200);
  for (const [c, email, first] of [
    [alice, "alice@test.local", "Alice"],
    [bob, "bob@test.local", "Bob"],
    [carol, "carol@test.local", "Carol"],
  ]) {
    assert.equal((await c.post("/register", {email, password: PASSWORD})).status, 200);
    assert.equal((await c.put("/profile", {first_name: first, last_name: "Test"})).status, 200);
  }
});
after(() => worker?.stop());

test("administrateurs : un admin en nomme un autre, l'admin principal reste protégé", async () => {
  const aliceId = await idOf("alice@test.local"),
    ownerId = await idOf(ADMIN_EMAIL);
  assert.equal((await alice.get("/admin/users")).status, 403);
  assert.equal((await bob.put(`/admin/users/${aliceId}`, {is_admin: true})).status, 403);
  assert.equal((await admin.put(`/admin/users/${aliceId}`, {is_admin: true})).status, 200);
  assert.equal((await alice.get("/me")).data.is_admin, true);
  assert.equal((await alice.get("/admin/users")).status, 200);
  // l'admin principal ne peut être ni rétrogradé ni désactivé
  assert.equal((await alice.put(`/admin/users/${ownerId}`, {is_admin: false})).status, 400);
  assert.equal((await alice.put(`/admin/users/${ownerId}`, {is_active: false})).status, 400);
  // un admin ne retire pas ses propres droits
  assert.equal((await alice.put(`/admin/users/${aliceId}`, {is_admin: false})).status, 400);
  // les activités gérées par un admin secondaire sont celles du référentiel commun
  const created = await alice.post("/admin/activities", {name: "Haltéro", duration_minutes: 45});
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.ok((await bob.get("/activities")).data.activities.some(a => a.name === "Haltéro"));
  // l'admin principal retire les droits
  assert.equal((await admin.put(`/admin/users/${aliceId}`, {is_admin: false})).status, 200);
  assert.equal((await alice.get("/admin/users")).status, 403);
  assert.equal((await alice.get("/me")).data.is_admin, false);
});
