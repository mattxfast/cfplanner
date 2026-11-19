// WOD du jour : reconnaissance des mouvements du catalogue cités par l'IA (pluriels, abréviations, noms plus longs).
import {test} from "node:test";
import assert from "node:assert/strict";
import {dailyMovementIds} from "../src/ai.js";

const catalog = [
  "Wall ball",
  "Pull-up",
  "Toes to bar",
  "Handstand push-up",
  "Double under",
  "Bar MU",
  "Kettlebell swing",
  "Clean & Jerk",
  "Overhead Squat",
  "Back Squat",
  "Deadlift",
].map((name, i) => ({id: "m" + i, name}));
const found = names =>
  dailyMovementIds({blocs: [{mouvements: names.map(nom => ({nom}))}]}, catalog).map(
    id => catalog.find(m => m.id === id).name
  );

test("mouvements : pluriels, casse, accents et ponctuation", () => {
  assert.deepEqual(found(["Wall balls", "pull ups", "OVERHEAD SQUATS"]), ["Wall ball", "Pull-up", "Overhead Squat"]);
});
test("mouvements : abréviations courantes", () => {
  assert.deepEqual(found(["T2B", "HSPU", "DUs", "C&J", "Bar muscle-ups"]), [
    "Toes to bar",
    "Handstand push-up",
    "Double under",
    "Clean & Jerk",
    "Bar MU",
  ]);
});
test("mouvements : nom plus long, sans faux positif sur un nom d'un seul mot", () => {
  assert.deepEqual(found(["Kettlebell swings russes"]), ["Kettlebell swing"]);
  assert.deepEqual(found(["Sumo deadlift high pull", "Squat"]), [], "ni Deadlift ni Back Squat");
});
