// Score de forme de l'athlète (page PR) : 7 piliers notés de 0 à 100, puis un score global pondéré.
// Calcul pur (sans base de données) : le Worker lui passe le profil, les PR, les séances et les classements de box.
//
// - Régularité : séances des 8 dernières semaines (objectif : 4 par semaine) et semaines actives.
// - Force et Haltérophilie : meilleur 1RM de chaque mouvement de référence (estimé par la formule d'Epley pour un PR
//   à plusieurs répétitions), rapporté au poids de corps et comparé à des repères débutant / intermédiaire / avancé /
//   élite, selon le sexe ; ajustement selon l'âge (masters après 35 ans, jeunes avant 18 ans).
// - Gym : PR en répétitions des mouvements de gymnastique de référence, comparés aux mêmes 4 niveaux.
// - Conditionnement : place dans les classements des WOD de box (8 dernières semaines, catégorie prise en compte).
// - Polyvalence : variété des mouvements et des familles (Lift, Force, Gym, Engine) cochés dans les séances.
// - Progression : PR battus (et premiers PR) des 90 derniers jours.
// Un pilier sans données vaut null (« à compléter ») et n'entre pas dans le score global.
import {movementKey} from "./ai.js";

export const FITNESS_VERSION = "forme-v1";
const WEIGHTS = {
  regularite: 20,
  force: 15,
  halterophilie: 15,
  gym: 15,
  conditionnement: 15,
  polyvalence: 10,
  progression: 10,
};
const LABELS = {
  regularite: "Régularité",
  force: "Force",
  halterophilie: "Haltérophilie",
  gym: "Gym",
  conditionnement: "Conditionnement",
  polyvalence: "Polyvalence",
  progression: "Progression",
};
// Repères en multiple du poids de corps (hommes) : débutant, intermédiaire, avancé, élite.
// Pour les femmes : multipliés par le coefficient indiqué (bas du corps plus proche que le haut du corps).
const LIFTS = {
  "back squat": {family: "force", levels: [1.0, 1.5, 2.0, 2.5], women: 0.75},
  "front squat": {family: "force", levels: [0.8, 1.25, 1.7, 2.1], women: 0.75},
  deadlift: {family: "force", levels: [1.25, 1.75, 2.25, 2.75], women: 0.75},
  "bench press": {family: "force", levels: [0.75, 1.1, 1.45, 1.8], women: 0.65},
  "push press": {family: "force", levels: [0.6, 0.9, 1.15, 1.4], women: 0.65},
  "strict press": {family: "force", levels: [0.45, 0.65, 0.85, 1.05], women: 0.65},
  "shoulder press": {family: "force", levels: [0.45, 0.65, 0.85, 1.05], women: 0.65},
  thruster: {family: "force", levels: [0.6, 0.9, 1.2, 1.45], women: 0.7},
  snatch: {family: "halterophilie", levels: [0.55, 0.85, 1.1, 1.4], women: 0.7},
  "squat snatch": {family: "halterophilie", levels: [0.55, 0.85, 1.1, 1.4], women: 0.7},
  "power snatch": {family: "halterophilie", levels: [0.5, 0.75, 1.0, 1.25], women: 0.7},
  clean: {family: "halterophilie", levels: [0.75, 1.1, 1.45, 1.75], women: 0.7},
  "squat clean": {family: "halterophilie", levels: [0.75, 1.1, 1.45, 1.75], women: 0.7},
  "power clean": {family: "halterophilie", levels: [0.7, 1.0, 1.3, 1.6], women: 0.7},
  jerk: {family: "halterophilie", levels: [0.7, 1.05, 1.4, 1.7], women: 0.7},
  "split jerk": {family: "halterophilie", levels: [0.7, 1.05, 1.4, 1.7], women: 0.7},
  "push jerk": {family: "halterophilie", levels: [0.65, 1.0, 1.3, 1.6], women: 0.7},
  "clean jerk": {family: "halterophilie", levels: [0.7, 1.05, 1.4, 1.7], women: 0.7},
  "overhead squat": {family: "halterophilie", levels: [0.6, 0.95, 1.3, 1.6], women: 0.7},
};
// Repères en répétitions (hommes) ; coefficient femmes.
const GYM = {
  "pull up": {levels: [3, 10, 20, 35], women: 0.6},
  butterfly: {levels: [5, 15, 30, 50], women: 0.6},
  "chest to bar": {levels: [1, 7, 15, 25], women: 0.6},
  "toe to bar": {levels: [3, 10, 20, 35], women: 0.8},
  "handstand push up": {levels: [1, 7, 15, 30], women: 0.6},
  "bar muscle up": {levels: [1, 3, 8, 15], women: 0.5},
  "ring muscle up": {levels: [1, 3, 6, 12], women: 0.5},
  "muscle up": {levels: [1, 3, 6, 12], women: 0.5},
  "double under": {levels: [10, 50, 100, 200], women: 1},
  "push up": {levels: [10, 25, 45, 70], women: 0.6},
  pistol: {levels: [2, 8, 15, 25], women: 0.9},
};
const DAY = 86400000;
const days = (a, b) => Math.round((new Date(a + "T12:00:00Z") - new Date(b + "T12:00:00Z")) / DAY);
const round = v => Math.round(v);
const fr = (v, digits = 1) => String(Number(v.toFixed(digits))).replace(".", ",");

// Valeur → points (0 à 100) selon 4 repères : 25 au niveau débutant, 50 intermédiaire, 75 avancé, 100 élite.
export function levelPoints(value, levels) {
  if (!(value > 0)) return 0;
  const [b] = levels;
  if (value <= b) return (25 * value) / b;
  for (let i = 1; i < levels.length; i++)
    if (value <= levels[i]) return 25 * i + (25 * (value - levels[i - 1])) / (levels[i] - levels[i - 1]);
  return 100;
}
export function age(birthDate, today) {
  if (!birthDate) return null;
  let a = Number(today.slice(0, 4)) - Number(birthDate.slice(0, 4));
  if (today.slice(5) < birthDate.slice(5)) a--;
  return a;
}
// Ajustement d'âge des performances : +1 % par année après 35 ans (30 % au plus), +1,5 % par année avant 18 ans.
export function ageFactor(a) {
  if (a === null || a === undefined) return 1;
  if (a > 35) return 1 + Math.min(0.3, 0.01 * (a - 35));
  if (a < 18) return 1 + Math.min(0.2, 0.015 * (18 - a));
  return 1;
}
// Repères selon le sexe ; sexe non précisé : moyenne des repères hommes et femmes.
const forSex = (levels, women, sex) => {
  const k = sex === "F" ? women : sex === "M" ? 1 : (1 + women) / 2;
  return levels.map(v => v * k);
};
export const epley1RM = (value, reps) => (reps && reps > 1 ? value * (1 + Math.min(reps, 10) / 30) : value);

export function computeFitness(d) {
  const today = d.today,
    profile = d.profile || {},
    sex = profile.sex === "F" || profile.sex === "M" ? profile.sex : "",
    weight = Number(profile.body_weight_kg) > 0 ? Number(profile.body_weight_kg) : null,
    a = age(profile.birth_date, today),
    factor = ageFactor(a),
    pillars = {};
  const hintsProfile = [];
  if (!weight) hintsProfile.push("poids de corps");
  if (!sex) hintsProfile.push("sexe");
  if (a === null) hintsProfile.push("date de naissance");

  // Régularité : 8 semaines glissantes se terminant aujourd'hui.
  {
    const dates = (d.sessionDates || []).filter(x => x <= today && days(today, x) < 56),
      weeks = new Set(dates.map(x => Math.floor(days(today, x) / 7))),
      perWeek = dates.length / 8;
    pillars.regularite = {
      score: round(80 * Math.min(1, perWeek / 4) + (20 * weeks.size) / 8),
      detail: `${fr(perWeek)} séance${perWeek >= 2 ? "s" : ""} par semaine en moyenne, ${weeks.size} semaine${weeks.size > 1 ? "s" : ""} active${weeks.size > 1 ? "s" : ""} sur 8`,
    };
  }

  // Meilleur résultat de chaque mouvement de référence (1RM estimé pour les charges, répétitions pour la gym).
  const bestLift = new Map(),
    bestGym = new Map();
  for (const r of d.records || []) {
    const key = movementKey(r.name);
    if (LIFTS[key] && (r.measurement_method === "load" || r.measurement_method === "force")) {
      const v = epley1RM(Number(r.value), Number(r.rep_count) || 1);
      if (!bestLift.has(key) || v > bestLift.get(key).value) bestLift.set(key, {value: v, name: r.name});
    }
    if (GYM[key] && r.measurement_method === "reps") {
      const v = Number(r.value);
      if (!bestGym.has(key) || v > bestGym.get(key).value) bestGym.set(key, {value: v, name: r.name});
    }
  }
  for (const family of ["force", "halterophilie"]) {
    const lifts = [...bestLift.entries()].filter(([k]) => LIFTS[k].family === family);
    if (!lifts.length) {
      pillars[family] = {
        score: null,
        hint:
          "Enregistre un PR de charge (" +
          (family === "force" ? "squat, deadlift, press…" : "snatch, clean, jerk…") +
          ").",
      };
      continue;
    }
    if (!weight) {
      pillars[family] = {score: null, hint: "Renseigne ton poids de corps dans Mon compte."};
      continue;
    }
    const scored = lifts.map(([k, x]) => ({
      name: x.name,
      ratio: x.value / weight,
      points: levelPoints((x.value / weight) * factor, forSex(LIFTS[k].levels, LIFTS[k].women, sex)),
    }));
    const best = scored.reduce((p, x) => (x.points > p.points ? x : p));
    pillars[family] = {
      score: round(scored.reduce((n, x) => n + x.points, 0) / scored.length),
      detail: `${scored.length} mouvement${scored.length > 1 ? "s" : ""} de référence ; meilleur : ${best.name} à ${fr(best.ratio, 2)} × ton poids de corps`,
    };
  }
  {
    const gym = [...bestGym.entries()].map(([k, x]) => ({
      name: x.name,
      reps: x.value,
      points: levelPoints(x.value * factor, forSex(GYM[k].levels, GYM[k].women, sex)),
    }));
    pillars.gym = gym.length
      ? {
          score: round(gym.reduce((n, x) => n + x.points, 0) / gym.length),
          detail: `${gym.length} mouvement${gym.length > 1 ? "s" : ""} de référence (pull-ups, T2B, HSPU, muscle-up, DU…)`,
        }
      : {score: null, hint: "Enregistre un PR en répétitions (pull-ups, T2B, HSPU, DU…)."};
  }

  // Conditionnement : place dans la catégorie (1 = meilleur), pénalité pour les catégories après la première (RX).
  {
    const results = (d.boxResults || []).filter(x => x.total >= 3);
    if (results.length) {
      const pts = results.map(x => {
        const pct = (x.total - x.rank) / (x.total - 1);
        return 100 * pct * (1 - 0.15 * Math.min(2, x.categoryIndex || 0));
      });
      pillars.conditionnement = {
        score: round(pts.reduce((n, v) => n + v, 0) / pts.length),
        detail: `${results.length} WOD de box classé${results.length > 1 ? "s" : ""} sur 8 semaines`,
      };
    } else
      pillars.conditionnement = {
        score: null,
        hint: "Enregistre ton score sur des WOD de ta box (au moins 3 participants dans ta catégorie).",
      };
  }

  // Polyvalence : mouvements différents (objectif : 12) et familles couvertes parmi celles du catalogue.
  {
    const familyOf = new Map((d.catalog || []).map(m => [movementKey(m.name), m.measurement_method])),
      available = new Set((d.catalog || []).map(m => m.measurement_method)),
      names = new Set((d.movementNames || []).map(movementKey).filter(Boolean)),
      families = new Set([...names].map(k => familyOf.get(k)).filter(f => f && available.has(f)));
    pillars.polyvalence = {
      score: round(70 * Math.min(1, names.size / 12) + (available.size ? (30 * families.size) / available.size : 0)),
      detail: `${names.size} mouvement${names.size > 1 ? "s" : ""} différent${names.size > 1 ? "s" : ""} travaillé${names.size > 1 ? "s" : ""} sur 8 semaines, ${families.size} famille${families.size > 1 ? "s" : ""} sur ${available.size}`,
    };
  }

  // Progression : 1 point par PR battu, 0,5 par premier PR d'un mouvement, sur 90 jours (5 points = 100).
  {
    const recs = [...(d.records || [])].sort(
      (x, y) => x.record_date.localeCompare(y.record_date) || String(x.created_at).localeCompare(String(y.created_at))
    );
    if (!recs.length) pillars.progression = {score: null, hint: "Enregistre tes PR pour suivre ta progression."};
    else {
      const best = new Map();
      let points = 0,
        beaten = 0,
        firsts = 0;
      for (const r of recs) {
        const key =
          r.movement_id +
          ":" +
          (r.measurement_method === "load" || r.measurement_method === "force" ? r.rep_count || 1 : "");
        const recent = days(today, r.record_date) <= 90,
          prev = best.get(key);
        if (recent) {
          if (prev === undefined) {
            points += 0.5;
            firsts++;
          } else if (Number(r.value) > prev) {
            points += 1;
            beaten++;
          }
        }
        if (prev === undefined || Number(r.value) > prev) best.set(key, Number(r.value));
      }
      pillars.progression = {
        score: round(Math.min(100, points * 20)),
        detail: `${beaten} PR battu${beaten > 1 ? "s" : ""} et ${firsts} nouveau${firsts > 1 ? "x" : ""} PR sur 90 jours`,
      };
    }
  }

  const list = Object.keys(WEIGHTS).map(key => ({key, label: LABELS[key], weight: WEIGHTS[key], ...pillars[key]})),
    known = list.filter(x => x.score !== null && x.score !== undefined),
    total = known.reduce((n, x) => n + x.weight, 0),
    score = known.length >= 2 ? round(known.reduce((n, x) => n + x.score * x.weight, 0) / total) : null;
  return {
    version: FITNESS_VERSION,
    score,
    level: score === null ? null : levelLabel(score),
    complete: known.length === list.length,
    pillars: list.map(x => ({...x, score: x.score ?? null})),
    profile_missing: hintsProfile,
    age: a,
  };
}
export function levelLabel(score) {
  return score < 20
    ? "Débutant"
    : score < 40
      ? "En progression"
      : score < 60
        ? "Intermédiaire"
        : score < 80
          ? "Avancé"
          : "Élite";
}
// Bornes du profil d'athlète (validées par le Worker).
export function athleteProfileInput(b) {
  const out = {};
  if ("body_weight_kg" in b) {
    const raw = b.body_weight_kg;
    if (raw === null || raw === "") out.body_weight_kg = null;
    else {
      const w = Number(raw);
      if (!Number.isFinite(w) || w < 25 || w > 300) return {error: "Le poids doit être compris entre 25 et 300 kg."};
      out.body_weight_kg = Math.round(w * 10) / 10;
    }
  }
  if ("birth_date" in b) {
    const v = b.birth_date ? String(b.birth_date) : null;
    if (v !== null) {
      const ok =
        /^\d{4}-\d{2}-\d{2}$/.test(v) &&
        !Number.isNaN(Date.parse(v + "T12:00:00Z")) &&
        new Date(v + "T12:00:00Z").toISOString().slice(0, 10) === v;
      if (!ok || v < "1900-01-01") return {error: "Date de naissance invalide."};
    }
    out.birth_date = v;
  }
  if ("sex" in b) {
    const v = String(b.sex || "");
    if (!["", "F", "M"].includes(v)) return {error: "Sexe invalide."};
    out.sex = v;
  }
  return out;
}
