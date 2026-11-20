// Score de forme : calcul des piliers (fonctions pures) et route GET /api/fitness-score avec le profil d'athlète.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {computeFitness, levelPoints, ageFactor, epley1RM, athleteProfileInput} from "../src/fitness.js";
import {startWorker, client, ADMIN_EMAIL, today, addDays} from "./helpers.mjs";

const TODAY = "2026-11-20";
const catalog = [
  {name: "Back Squat", measurement_method: "force"},
  {name: "Deadlift", measurement_method: "force"},
  {name: "Snatch", measurement_method: "load"},
  {name: "Pull-up", measurement_method: "reps"},
];
const rec = (name, method, value, date, reps = null, id = name) => ({
  movement_id: id,
  name,
  measurement_method: method,
  value,
  rep_count: reps,
  record_date: date,
  created_at: date,
});

test("forme : repères et ajustements", () => {
  assert.equal(levelPoints(1.0, [1, 1.5, 2, 2.5]), 25);
  assert.equal(levelPoints(1.75, [1, 1.5, 2, 2.5]), 62.5);
  assert.equal(levelPoints(3, [1, 1.5, 2, 2.5]), 100);
  assert.equal(levelPoints(0.5, [1, 1.5, 2, 2.5]), 12.5);
  assert.equal(ageFactor(30), 1);
  assert.equal(ageFactor(45), 1.1);
  assert.equal(ageFactor(80), 1.3);
  assert.equal(Math.round(epley1RM(100, 3)), 110);
});

test("forme : piliers et score global", () => {
  const sessionDates = [];
  for (let w = 0; w < 8; w++) for (let s = 0; s < 3; s++) sessionDates.push(addDays(TODAY, -(w * 7 + s)));
  const r = computeFitness({
    today: TODAY,
    profile: {body_weight_kg: 80, birth_date: "1990-05-01", sex: "M"},
    records: [
      rec("Back Squat", "force", 140, "2026-08-01"),
      rec("Back Squat", "force", 150, "2026-11-01"),
      rec("Snatch", "load", 80, "2026-10-01"),
      rec("Pull-up", "reps", 15, "2026-10-15"),
    ],
    sessionDates,
    movementNames: ["Back Squat", "Snatch", "Pull-up", "Deadlift"],
    catalog,
    boxResults: [
      {rank: 1, total: 5, categoryIndex: 0},
      {rank: 3, total: 5, categoryIndex: 1},
    ],
  });
  const p = Object.fromEntries(r.pillars.map(x => [x.key, x.score]));
  assert.equal(p.regularite, 80, "3 séances / semaine sur 8 semaines actives");
  assert.equal(p.force, 70, "back squat 150 kg pour 80 kg = 1,875 × PdC, +1 % à 36 ans");
  assert.equal(p.halterophilie, 66, "snatch 1 × PdC : entre intermédiaire (0,85) et avancé (1,1)");
  assert.equal(p.gym, 63, "15 pull-ups");
  assert.equal(p.conditionnement, 71, "1er / 5 en RX, 3e / 5 en 2e catégorie");
  assert.equal(p.polyvalence, 53, "4 mouvements, 3 familles sur 3");
  assert.equal(p.progression, 40, "1 PR battu, 2 premiers PR (le squat d'août date de plus de 90 jours)");
  assert.ok(r.score > 0 && r.score <= 100);
  assert.equal(r.complete, true);
  assert.deepEqual(r.profile_missing, []);
});

test("forme : piliers à compléter sans poids de corps ni données", () => {
  const r = computeFitness({
    today: TODAY,
    profile: {},
    records: [rec("Back Squat", "force", 100, "2026-11-01")],
    sessionDates: [],
    movementNames: [],
    catalog,
    boxResults: [],
  });
  const p = Object.fromEntries(r.pillars.map(x => [x.key, x]));
  assert.equal(p.force.score, null);
  assert.match(p.force.hint, /poids de corps/);
  assert.equal(p.conditionnement.score, null);
  assert.equal(p.regularite.score, 0);
  assert.deepEqual(r.profile_missing, ["poids de corps", "sexe", "date de naissance"]);
  assert.equal(r.complete, false);
});

test("forme : validation du profil d'athlète", () => {
  assert.deepEqual(athleteProfileInput({body_weight_kg: "72.35", sex: "F", birth_date: "1990-02-28"}), {
    body_weight_kg: 72.4,
    sex: "F",
    birth_date: "1990-02-28",
  });
  assert.ok(athleteProfileInput({body_weight_kg: 10}).error);
  assert.ok(athleteProfileInput({sex: "X"}).error);
  assert.ok(athleteProfileInput({birth_date: "1990-02-30"}).error);
  assert.deepEqual(athleteProfileInput({body_weight_kg: "", birth_date: ""}), {body_weight_kg: null, birth_date: null});
  assert.deepEqual(athleteProfileInput({first_name: "A"}), {}, "champs absents : inchangés");
});

let worker, alice, bob;
before(async () => {
  worker = await startWorker();
  const admin = client(worker.base);
  alice = client(worker.base);
  bob = client(worker.base);
  await admin.post("/register", {email: ADMIN_EMAIL, password: "MotDePasse-Test-123"});
  await alice.post("/register", {email: "alice@test.local", password: "MotDePasse-Test-123"});
  await bob.post("/register", {email: "bob@test.local", password: "MotDePasse-Test-123"});
  await admin.post("/admin/movements", {name: "Back Squat", measurement_method: "force"});
});
after(() => worker?.stop());

test("forme : profil d'athlète enregistré et score calculé par le serveur", async () => {
  assert.equal((await alice.put("/profile", {first_name: "Alice", last_name: "A", body_weight_kg: 500})).status, 400);
  assert.equal(
    (await alice.put("/profile", {first_name: "Alice", last_name: "A", birth_date: addDays(today(), -30)})).status,
    400,
    "date de naissance trop récente"
  );
  const saved = await alice.put("/profile", {
    first_name: "Alice",
    last_name: "A",
    body_weight_kg: 60,
    birth_date: "1992-03-14",
    sex: "F",
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.user.body_weight_kg, 60);
  // Un enregistrement des seuls prénom et nom (fenêtre d'accueil des box) garde le profil d'athlète.
  await alice.put("/profile", {first_name: "Alice", last_name: "B"});
  const me = (await alice.get("/me")).data.user;
  assert.deepEqual([me.body_weight_kg, me.birth_date, me.sex], [60, "1992-03-14", "F"]);

  const squat = (await alice.get("/movement-catalog")).data.movements.find(m => m.name === "Back Squat").id;
  assert.equal(
    (await alice.post("/prs", {movement_id: squat, record_date: today(), value: 90, rep_count: 1})).status,
    200
  );
  const r = await alice.get("/fitness-score");
  assert.equal(r.status, 200);
  const force = r.data.pillars.find(x => x.key === "force");
  assert.ok(force.score > 50, "squat 1,5 × PdC pour une femme : niveau intermédiaire à avancé");
  assert.equal(r.data.pillars.length, 7);
  const other = await bob.get("/fitness-score");
  assert.equal(other.data.pillars.find(x => x.key === "force").score, null, "chacun son score");
});
