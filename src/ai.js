// Génération de WOD par IA (API OpenAI, sans dépendance) : options de séance, prompt modèle, appel et mise en texte.
// Le Worker (src/worker.js) lit le contexte en base (profil, records, programme, séances) et enregistre le résultat.

export const AI_PROMPT_VERSION = "wod-seance-v1";
export const AI_DAILY_LIMIT = 100; // générations par utilisateur et par 24 h (maîtrise du coût)
export const AI_DEFAULT_MODEL = "gpt-5-mini";
export const AI_LEVELS = {
  debutant: "Débutant",
  intermediaire: "Intermédiaire",
  avance: "Avancé",
  competiteur: "Compétiteur",
};
export const AI_BLOCKS = ["echauffement", "technique", "force", "metcon", "retour_au_calme"];
export const AI_METCON_FORMATS = ["AMRAP", "EMOM", "For Time", "Intervalles", "Chipper"];
export const AI_MAX_MOVEMENTS = 5;
const BLOCK_LABELS = {
  echauffement: "Échauffement",
  technique: "Technique",
  force: "Force",
  metcon: "Metcon",
  retour_au_calme: "Retour au calme",
};
const FAMILY = {load: "Lift", force: "Force", reps: "Gym", distance: "Engine"};

const text = (v, max) =>
  String(v ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);

// Profil d'entraînement (champs libres courts ; pas de données médicales).
export function aiProfileInput(b) {
  const level = String(b.level || "");
  if (level && !AI_LEVELS[level]) return {error: "Niveau invalide."};
  return {
    level,
    goals: text(b.goals, 300),
    equipment: text(b.equipment, 300),
    constraints: text(b.constraints, 300),
  };
}

// Options de la séance demandée. Les mouvements imposés sont des identifiants du catalogue (5 au plus par bloc).
export function aiOptionsInput(b) {
  const duration = Number(b.duration_minutes);
  if (!Number.isInteger(duration) || duration < 15 || duration > 180)
    return {error: "La durée doit être comprise entre 15 et 180 minutes."};
  const blocks = {};
  for (const k of AI_BLOCKS) blocks[k] = !!b.blocks?.[k];
  if (!AI_BLOCKS.some(k => blocks[k])) return {error: "Choisis au moins un bloc."};
  const ids = v => [...new Set((Array.isArray(v) ? v : []).map(x => String(x)).filter(x => /^[\w-]{1,64}$/.test(x)))];
  const technique = blocks.technique ? ids(b.technique_movements) : [],
    force = blocks.force ? ids(b.force_movements) : [];
  if (technique.length > AI_MAX_MOVEMENTS || force.length > AI_MAX_MOVEMENTS)
    return {error: "5 mouvements au plus pour la technique et pour la force."};
  const format = blocks.metcon ? String(b.metcon_format || "") : "";
  if (format && !AI_METCON_FORMATS.includes(format)) return {error: "Format de metcon invalide."};
  return {
    duration_minutes: duration,
    blocks,
    technique_movements: technique,
    force_movements: force,
    metcon_format: format,
    instructions: text(b.instructions, 300),
  };
}

const SYSTEM = `Tu es un coach CrossFit expérimenté. Tu écris des séances sûres, progressives et adaptées à l'athlète.

Règles :
- Respecte strictement les blocs demandés : ne génère que les blocs activés, dans l'ordre échauffement, technique, force, metcon, retour au calme.
- Respecte la durée totale (tolérance ±5 min) en incluant les transitions.
- Les blocs technique et force comportent de 1 à 5 mouvements. Si des mouvements sont imposés, utilise exactement ceux-là ; sinon choisis-en 1 à 3 selon la durée disponible.
- Utilise de préférence les noms de mouvements du catalogue fourni, à l'identique.
- Adapte mouvements et charges au niveau, aux records et au matériel disponible. Exprime les charges en kg (ou en % du 1RM quand un record est connu), les distances en mètres.
- Respecte les contraintes de l'athlète ; propose une alternative pour tout mouvement qui ne convient pas.
- Assure la progression et la variété avec le programme et les séances récentes : évite de solliciter lourdement le même groupe musculaire deux jours de suite.
- Sois concis : le texte final doit tenir sur un écran de téléphone.
- Rédige en français.
- Si la demande est incompatible (trop de blocs pour la durée, par exemple), adapte au mieux et explique-le dans "notes_coach".`;

// Message utilisateur : contexte de l'athlète, du programme et de la séance demandée.
export function buildPrompt(c) {
  const p = c.profile || {},
    o = c.options,
    names = ids => ids.map(id => c.catalog.find(m => m.id === id)?.name).filter(Boolean),
    yes = (k, extra = "") => (o.blocks[k] ? "oui" + extra : "non"),
    imposed = ids =>
      names(ids).length ? " — mouvements imposés : " + names(ids).join(", ") : " — mouvements au choix du coach";
  const prs = c.records.map(r => {
    const unit = r.measurement_method === "reps" ? " rép." : r.measurement_method === "distance" ? " m" : " kg";
    return `${r.name} : ${r.value}${unit}${r.rep_count ? " (" + r.rep_count + " RM)" : ""}`;
  });
  const lines = [
    "## Athlète",
    "Niveau : " + (AI_LEVELS[p.level] || "non précisé"),
    "Objectifs : " + (p.goals || "non précisés"),
    "Matériel disponible : " + (p.equipment || "box CrossFit complète"),
    "Contraintes : " + (p.constraints || "aucune"),
    "Records : " + (prs.length ? prs.join(" ; ") : "aucun enregistré"),
    "",
    "## Programme",
    `${c.program.name} — semaine ${c.weekIndex}/${c.weekCount} (du ${c.weekLabel})`,
    "WOD à écrire : " +
      c.wod.name +
      (c.wod.planned_comment ? " — consignes : " + text(c.wod.planned_comment, 400) : ""),
    "Mouvements à travailler dans le programme : " + (c.focus.length ? c.focus.join(", ") : "aucun en particulier"),
    "",
    "## Programmation déjà écrite (semaines récentes et cette semaine)",
    ...(c.planned.length ? c.planned.map(x => `- ${x.week} · ${x.name} : ${text(x.content, 300)}`) : ["Aucune."]),
    "",
    "## Séances réalisées récemment",
    ...(c.sessions.length
      ? c.sessions.map(s => `- ${s.date} · ${s.name}${s.comment ? " : " + text(s.comment, 150) : ""}`)
      : ["Aucune."]),
    "",
    "## Séance demandée",
    "Durée totale : " + o.duration_minutes + " min",
    "Échauffement : " + yes("echauffement"),
    "Travail technique : " + yes("technique", imposed(o.technique_movements)),
    "Force : " + yes("force", imposed(o.force_movements)),
    "Metcon : " + yes("metcon", o.metcon_format ? " — format : " + o.metcon_format : " — format au choix du coach"),
    "Retour au calme : " + yes("retour_au_calme"),
    "Consigne particulière : " + (o.instructions || "aucune"),
    "",
    "## Catalogue des mouvements",
    c.catalog
      .map(m => m.name + (FAMILY[m.measurement_method] ? " (" + FAMILY[m.measurement_method] + ")" : ""))
      .join(", ") || "vide",
  ];
  return lines.join("\n");
}

const nullable = type => ({type: [type, "null"]});
export const WOD_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["titre", "duree_estimee_min", "blocs", "objectif_score", "notes_coach"],
  properties: {
    titre: {type: "string"},
    duree_estimee_min: {type: "integer"},
    blocs: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "duree_min", "format", "time_cap_min", "description", "mouvements"],
        properties: {
          type: {type: "string", enum: AI_BLOCKS},
          duree_min: {type: "integer"},
          format: nullable("string"),
          time_cap_min: nullable("integer"),
          description: {type: "string"},
          mouvements: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["nom", "reps", "charge", "scaling"],
              properties: {
                nom: {type: "string"},
                reps: nullable("string"),
                charge: nullable("string"),
                scaling: nullable("string"),
              },
            },
          },
        },
      },
    },
    objectif_score: nullable("string"),
    notes_coach: nullable("string"),
  },
};

// Appel de l'API Responses d'OpenAI avec un format JSON imposé (structured outputs).
export async function callOpenAI(env, prompt) {
  const model = String(env.OPENAI_MODEL || AI_DEFAULT_MODEL),
    body = {
      model,
      instructions: SYSTEM,
      input: prompt,
      store: false,
      max_output_tokens: 6000,
      text: {format: {type: "json_schema", name: "wod", strict: true, schema: WOD_SCHEMA}},
    };
  // Modèles « à raisonnement » : effort réduit pour une réponse plus rapide et moins chère.
  if (/^(gpt-5|o\d)/.test(model)) body.reasoning = {effort: "low"};
  let res;
  try {
    res = await fetch(String(env.OPENAI_API_URL || "https://api.openai.com/v1/responses"), {
      method: "POST",
      headers: {"content-type": "application/json", authorization: "Bearer " + env.OPENAI_API_KEY},
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90000),
    });
  } catch {
    return {error: "Le service d'IA ne répond pas. Réessaie dans un instant."};
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error("OpenAI", res.status, JSON.stringify(data?.error || data).slice(0, 500));
    if (res.status === 429) return {error: "Le service d'IA est saturé ou le crédit est épuisé. Réessaie plus tard."};
    return {error: "Le service d'IA a renvoyé une erreur (" + res.status + ")."};
  }
  const parts = (data?.output || []).filter(x => x.type === "message").flatMap(x => x.content || []);
  if (parts.some(x => x.type === "refusal")) return {error: "L'IA a refusé de générer cette séance."};
  const out = parts.find(x => x.type === "output_text")?.text;
  try {
    const wod = JSON.parse(out);
    if (!Array.isArray(wod?.blocs) || !wod.blocs.length) throw Error();
    return {wod, model: String(data.model || model)};
  } catch {
    console.error("OpenAI réponse illisible", data?.status, JSON.stringify(data?.incomplete_details || ""));
    return {error: "La réponse de l'IA est incomplète. Réessaie."};
  }
}

// Mise en texte du WOD pour le champ « Programmation hebdomadaire » (2 000 caractères au plus).
export function wodToText(wod, max = 2000) {
  const render = withScaling => {
    const out = [text(wod.titre, 120) + (wod.duree_estimee_min ? " (~" + wod.duree_estimee_min + " min)" : "")];
    for (const b of wod.blocs) {
      const head = [BLOCK_LABELS[b.type] || b.type, b.format, b.duree_min ? b.duree_min + " min" : ""]
        .filter(Boolean)
        .join(" · ");
      out.push("", head.toUpperCase() + (b.time_cap_min ? " (cap " + b.time_cap_min + " min)" : ""));
      if (b.description) out.push(text(b.description, 400));
      for (const m of b.mouvements || []) {
        let line = "- " + [m.reps, m.nom].filter(Boolean).join(" ");
        if (m.charge) line += " @ " + m.charge;
        if (withScaling && m.scaling) line += " (adapté : " + m.scaling + ")";
        out.push(line);
      }
    }
    if (wod.objectif_score) out.push("", "Objectif : " + text(wod.objectif_score, 200));
    if (wod.notes_coach) out.push("", "Note du coach : " + text(wod.notes_coach, 300));
    return out.join("\n");
  };
  const full = render(true);
  return (full.length <= max ? full : render(false)).slice(0, max);
}
