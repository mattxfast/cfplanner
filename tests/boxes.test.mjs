// Tests d'intégration : administrateurs multiples, box, gestionnaires, adhésions, WOD de box, scores, programmes publics.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {startWorker, client, ADMIN_EMAIL, today, mondayOf, addDays} from "./helpers.mjs";

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

let boxId;
test("box : création par un admin, demande de gestionnaire validée par un admin", async () => {
  assert.equal((await alice.post("/admin/boxes", {name: "Box intruse"})).status, 403);
  const created = await admin.post("/admin/boxes", {name: "CrossFit Test", city: "Marseille"});
  assert.equal(created.status, 200, JSON.stringify(created.data));
  boxId = created.data.id;
  assert.equal((await admin.post("/admin/boxes", {name: "crossfit test"})).status, 409);
  assert.ok((await bob.get("/boxes")).data.boxes.some(b => b.id === boxId));
  // sans prénom ni nom, pas de demande
  const nameless = client(worker.base);
  await nameless.post("/register", {email: "anonyme@test.local", password: PASSWORD});
  assert.equal((await nameless.post(`/boxes/${boxId}/requests`, {role: "member"})).status, 400);
  // Alice demande à gérer la box : rejouable sans doublon
  assert.equal((await alice.post(`/boxes/${boxId}/requests`, {role: "manager"})).status, 200);
  assert.equal((await alice.post(`/boxes/${boxId}/requests`, {role: "manager"})).status, 200);
  assert.equal((await alice.get(`/manage/boxes/${boxId}`)).status, 404, "pas encore validée");
  const pending = (await admin.get("/admin/boxes")).data.managers.filter(x => x.box_id === boxId);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending");
  const aliceId = await idOf("alice@test.local");
  assert.equal((await bob.put(`/admin/boxes/${boxId}/managers/${aliceId}`, {approve: true})).status, 403);
  assert.equal((await admin.put(`/admin/boxes/${boxId}/managers/${aliceId}`, {approve: true})).status, 200);
  const box = await alice.get(`/manage/boxes/${boxId}`);
  assert.equal(box.status, 200);
  // la box est créée avec les catégories RX, Inter, Scaled ; le gestionnaire est aussi membre
  assert.deepEqual(
    box.data.categories.map(c => c.name),
    ["RX", "Inter", "Scaled"]
  );
  assert.ok(box.data.members.some(m => m.user_id === aliceId && m.status === "approved" && m.is_manager));
});

test("box : adhésion validée par un gestionnaire de la box, catégories paramétrables", async () => {
  const bobId = await idOf("bob@test.local"),
    carolId = await idOf("carol@test.local");
  assert.equal((await bob.post(`/boxes/${boxId}/requests`, {role: "member"})).status, 200);
  assert.equal((await carol.post(`/boxes/${boxId}/requests`, {role: "member"})).status, 200);
  assert.deepEqual((await bob.get("/boxes")).data.memberships, [{box_id: boxId, role: "member", status: "pending"}]);
  // un simple membre (ou l'admin) ne gère pas la box
  assert.equal((await bob.get(`/manage/boxes/${boxId}`)).status, 404);
  assert.equal((await carol.put(`/manage/boxes/${boxId}/members/${bobId}`, {approve: true})).status, 404);
  assert.equal((await admin.get(`/manage/boxes/${boxId}`)).status, 404);
  assert.equal((await alice.put(`/manage/boxes/${boxId}/members/${bobId}`, {approve: true})).status, 200);
  assert.equal((await alice.put(`/manage/boxes/${boxId}/members/${carolId}`, {approve: true})).status, 200);
  assert.equal((await bob.get("/boxes")).data.memberships[0].status, "approved");
  // le gestionnaire ne peut pas être retiré des membres
  const aliceId = await idOf("alice@test.local");
  assert.equal((await alice.del(`/manage/boxes/${boxId}/members/${aliceId}`)).status, 400);
  // catégories : ajout rejouable, renommage, ordre, suppression
  const cid = "6f1c2c1e-1b2a-4c3d-8e4f-5a6b7c8d9e0f";
  assert.equal((await alice.post(`/manage/boxes/${boxId}/categories`, {name: "Masters", client_id: cid})).data.id, cid);
  assert.equal((await alice.post(`/manage/boxes/${boxId}/categories`, {name: "Masters", client_id: cid})).status, 200);
  assert.equal((await alice.post(`/manage/boxes/${boxId}/categories`, {name: "RX"})).status, 409);
  assert.equal((await bob.put(`/manage/categories/${cid}`, {name: "Pirate"})).status, 404);
  assert.equal((await alice.put(`/manage/categories/${cid}`, {name: "Masters 40+"})).status, 200);
  let cats = (await alice.get(`/manage/boxes/${boxId}`)).data.categories;
  assert.deepEqual(
    cats.map(c => c.name),
    ["RX", "Inter", "Scaled", "Masters 40+"]
  );
  const ids = cats.map(c => c.id).reverse();
  assert.equal((await alice.put(`/manage/boxes/${boxId}/categories/order`, {ids})).status, 200);
  cats = (await alice.get(`/manage/boxes/${boxId}`)).data.categories;
  assert.equal(cats[0].name, "Masters 40+");
  assert.equal((await alice.del(`/manage/categories/${cid}`)).status, 200);
});

let boxWodId;
test("WOD de box : saisis par le gestionnaire (passés et à venir), visibles des seuls membres", async () => {
  const day = today(),
    from = mondayOf(day),
    to = addDays(from, 6),
    cid = "0b7e5a9c-3f1d-4e2a-9c8b-7a6d5e4f3c2b";
  // nom par défaut « WOD du JJ/MM/AAAA », création rejouable sans doublon
  const created = await alice.post(`/manage/boxes/${boxId}/wods`, {
    client_id: cid,
    wod_date: day,
    content: "21-15-9 Thrusters / Pull-ups",
    score_type: "time",
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  boxWodId = created.data.id;
  assert.equal(boxWodId, cid);
  await alice.post(`/manage/boxes/${boxId}/wods`, {client_id: cid, wod_date: day, score_type: "time"});
  const upcoming = await alice.post(`/manage/boxes/${boxId}/wods`, {
    wod_date: addDays(day, 30),
    name: "Murph",
    score_type: "time",
  });
  assert.equal(upcoming.status, 200);
  assert.equal((await alice.post(`/manage/boxes/${boxId}/wods`, {wod_date: day, score_type: "x"})).status, 400);
  assert.equal((await bob.post(`/manage/boxes/${boxId}/wods`, {wod_date: day, score_type: "time"})).status, 404);
  const list = (await alice.get(`/manage/boxes/${boxId}/wods?from=${from}&to=${to}`)).data.wods;
  assert.equal(list.length, 1);
  const [d, mo, y] = [day.slice(8, 10), day.slice(5, 7), day.slice(0, 4)];
  assert.equal(list[0].name, `WOD du ${d}/${mo}/${y}`);
  // un membre validé voit les WOD de sa box ; un non-membre ne voit rien
  assert.equal((await bob.get(`/box-wods?from=${from}&to=${to}`)).data.wods.length, 1);
  const outsider = client(worker.base);
  await outsider.post("/register", {email: "dehors@test.local", password: PASSWORD});
  assert.equal((await outsider.get(`/box-wods?from=${from}&to=${to}`)).data.wods.length, 0);
  assert.equal((await bob.get(`/box-wods?from=${from}&to=${addDays(from, 200)}`)).status, 400);
  // modification par le gestionnaire seulement, puis suppression
  assert.equal((await bob.put(`/manage/wods/${upcoming.data.id}`, {wod_date: day, score_type: "reps"})).status, 404);
  const edit = await alice.put(`/manage/wods/${upcoming.data.id}`, {
    wod_date: addDays(day, 31),
    name: "Murph",
    content: "1 mile run…",
    score_type: "time",
  });
  assert.equal(edit.status, 200);
  assert.equal((await alice.del(`/manage/wods/${upcoming.data.id}`)).status, 200);
});
