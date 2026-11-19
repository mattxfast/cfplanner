// Suivi de l'alimentation : analyse d'un repas par IA (faux service OpenAI local), repas enregistrés, contrôles d'accès.
import {test, before, after} from "node:test";
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {startWorker, client, today, addDays} from "./helpers.mjs";

const PASSWORD = "MotDePasse-Test-123";
const PHOTO = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8U";
const aliment = (nom, quantite, grammes, kcal, proteines_g) => ({
  nom,
  quantite,
  grammes,
  kcal,
  proteines_g,
  glucides_g: 10,
  sucres_g: 1,
  lipides_g: 2,
  satures_g: 0.5,
  fibres_g: 1.5,
  sel_g: 0.2,
});
const FAKE_MEAL = {
  titre: "Poulet riz",
  aliments: [aliment("Blanc de poulet", "150 g", 150, 180, 34.5), aliment("Riz basmati cuit", "200 g", 200, 260, 5.4)],
  confiance: "bonne",
  remarques: "Repas riche en protéines.",
};
let worker,
  openai,
  requests = [],
  alice,
  bob;

before(async () => {
  openai = createServer((req, res) => {
    let raw = "";
    req.on("data", c => (raw += c));
    req.on("end", () => {
      requests.push(JSON.parse(raw));
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          model: "faux-modele",
          status: "completed",
          output: [{type: "message", content: [{type: "output_text", text: JSON.stringify(FAKE_MEAL)}]}],
        })
      );
    });
  });
  await new Promise(r => openai.listen(0, "127.0.0.1", r));
  worker = await startWorker(undefined, {
    OPENAI_API_KEY: "cle-de-test",
    OPENAI_API_URL: `http://127.0.0.1:${openai.address().port}/v1/responses`,
  });
  alice = client(worker.base);
  bob = client(worker.base);
  await alice.post("/register", {email: "alice@test.local", password: PASSWORD});
  await bob.post("/register", {email: "bob@test.local", password: PASSWORD});
});
after(() => {
  worker?.stop();
  openai?.close();
});

test("Alimentation : contrôles de saisie de l'analyse", async () => {
  assert.equal((await client(worker.base).post("/meal-analysis", {items: [{name: "Pomme"}]})).status, 401);
  assert.equal((await alice.post("/meal-analysis", {items: []})).status, 400, "photo ou aliment obligatoire");
  assert.equal((await alice.post("/meal-analysis", {photo: "data:text/html;base64,PGgxPg=="})).status, 400);
  assert.equal(
    (await alice.post("/meal-analysis", {photo: "data:image/jpeg;base64," + "A".repeat(2_100_000)})).status,
    400
  );
  assert.equal(requests.length, 0, "aucun appel au service d'IA pour une demande refusée");
  const st = await alice.get("/meal-analysis");
  assert.equal(st.data.enabled, true);
  assert.equal(st.data.remaining, 50);
});

test("Alimentation : analyse d'un repas (photo et aliments)", async () => {
  const res = await alice.post("/meal-analysis", {
    photo: PHOTO,
    items: [{name: "Poulet", quantity: "150 g"}, {name: "Riz"}],
    note: "cuit à l'huile d'olive",
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const a = res.data.analysis;
  assert.equal(a.title, "Poulet riz");
  assert.equal(a.items.length, 2);
  assert.deepEqual(a.items[0], {
    name: "Blanc de poulet",
    quantity: "150 g",
    grams: 150,
    kcal: 180,
    protein_g: 34.5,
    carbs_g: 10,
    sugars_g: 1,
    fat_g: 2,
    sat_fat_g: 0.5,
    fiber_g: 1.5,
    salt_g: 0.2,
  });
  assert.equal(a.totals.kcal, 440, "totaux calculés par le serveur");
  assert.equal(a.totals.protein_g, 39.9);
  assert.equal(a.totals.fiber_g, 3);
  assert.equal(a.confidence, "bonne");
  const call = requests.at(-1);
  assert.equal(call.text.format.name, "repas");
  assert.equal(call.text.format.strict, true);
  const content = call.input[0].content;
  assert.match(content[0].text, /- Poulet : 150 g/);
  assert.match(content[0].text, /- Riz\n/);
  assert.match(content[0].text, /Précision : cuit à l'huile d'olive/);
  assert.equal(content[1].type, "input_image");
  assert.equal(content[1].image_url, PHOTO);
  assert.equal((await alice.get("/meal-analysis")).data.remaining, 49);
  assert.equal((await bob.get("/meal-analysis")).data.remaining, 50);
  assert.equal((await alice.get(`/meals?from=${today()}&to=${today()}`)).data.meals.length, 0, "rien d'enregistré");
});

test("Alimentation : repas enregistrés, modifiés, supprimés", async () => {
  const day = today(),
    items = [
      {name: "Pomme", quantity: "1", grams: 150, kcal: 78, protein_g: 0.4, carbs_g: 17, fiber_g: 3.6},
      {name: "Amandes", quantity: "20 g", grams: 20, kcal: 120.4, protein_g: 4.2, fat_g: 10, kcal_bidon: 9},
    ],
    meal = {meal_date: day, meal_time: "10:30", title: "Collation", items, kcal: 99999};
  assert.equal((await alice.post("/meals", {...meal, meal_time: "25:00"})).status, 400);
  assert.equal((await alice.post("/meals", {...meal, meal_date: "2026-02-30x"})).status, 400);
  assert.equal((await alice.post("/meals", {...meal, items: [{name: ""}]})).status, 400);
  assert.equal((await alice.post("/meals", {...meal, meal_date: addDays(day, 5)})).status, 400, "pas dans le futur");
  const clientId = crypto.randomUUID();
  const created = await alice.post("/meals", {...meal, client_id: clientId});
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.data.id, clientId);
  assert.equal((await alice.post("/meals", {...meal, client_id: clientId})).data.id, clientId, "rejeu sans doublon");
  await alice.post("/meals", {...meal, meal_date: addDays(day, -1), meal_time: "20:00", title: "Dîner"});
  let list = (await alice.get(`/meals?from=${addDays(day, -6)}&to=${day}`)).data.meals;
  assert.equal(list.length, 2);
  const saved = list.find(x => x.id === clientId);
  assert.equal(saved.kcal, 198.4, "total recalculé à partir des aliments");
  assert.equal(saved.fiber_g, 3.6);
  assert.equal(saved.items.length, 2);
  assert.equal(saved.items[1].fat_g, 10);
  assert.equal(saved.items[1].kcal_bidon, undefined);
  assert.equal(list[0].title, "Dîner", "tri par date puis heure");
  assert.equal((await alice.get(`/meals?from=${day}&to=${addDays(day, 100)}`)).status, 400, "93 jours au plus");

  // Isolation : bob ne voit, ne modifie ni ne supprime les repas d'alice.
  assert.equal((await bob.get(`/meals?from=${addDays(day, -6)}&to=${day}`)).data.meals.length, 0);
  assert.equal((await bob.put("/meals/" + clientId, {...meal, title: "Piraté"})).status, 404);
  await bob.del("/meals/" + clientId);
  const other = await bob.post("/meals", {...meal, client_id: clientId});
  assert.equal(other.status, 200);
  assert.notEqual(other.data.id, clientId, "identifiant déjà pris par un autre compte");

  const updated = await alice.put("/meals/" + clientId, {...meal, meal_time: "11:00", items: [items[0]]});
  assert.equal(updated.status, 200);
  list = (await alice.get(`/meals?from=${day}&to=${day}`)).data.meals;
  assert.equal(list.length, 1);
  assert.equal(list[0].meal_time, "11:00");
  assert.equal(list[0].kcal, 78);
  assert.equal((await alice.del("/meals/" + clientId)).status, 200);
  assert.equal((await alice.get(`/meals?from=${day}&to=${day}`)).data.meals.length, 0);
});
