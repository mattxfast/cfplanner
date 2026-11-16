# CFPlanner

Application web responsive de suivi CrossFit : programmes, WOD réutilisables par programme, séances datées, notes prévues/réalisées et records personnels.

## Architecture

- **Frontend** : assets statiques dans `public/`.
- **Backend** : Cloudflare Worker dans `src/worker.js`.
- **Base de données** : Cloudflare D1, binding `DB`.
- **Migrations initiales D1** : dossier `migrations/`, appliquées avec Wrangler.
- **Migrations applicatives** : registre `app_migrations`, exécutées par le Worker au premier appel API après déploiement. Chaque version terminée est enregistrée et n'est pas rejouée aux démarrages suivants.

La migration `0001_init.sql` crée le socle initial (utilisateurs, sessions, programmes et anciennes entrées hebdomadaires). Les migrations applicatives V2 et V3 complètent ce schéma de manière additive. Elles ne suppriment pas les comptes ni les données existantes.

## Configuration

Le fichier `wrangler.toml` définit le binding D1 et la variable `ADMIN_EMAIL`, utilisée pour identifier le compte administrateur et rattacher le catalogue des activités à ce compte.

Pour un autre environnement, configurez `ADMIN_EMAIL` avec l'adresse du compte administrateur correspondant. Cette variable n'est pas un secret ; ne placez jamais de mot de passe, jeton ou clé privée dans le dépôt.

## Déploiement

Le projet est configuré pour Cloudflare Workers avec les assets statiques dans `public/` et la base D1 `cfplanner`.

Après application des migrations D1 Wrangler nécessaires, déployez le Worker. Au premier appel API, le Worker vérifie le registre des migrations applicatives et applique uniquement les versions encore absentes.

## Sécurité et limites

- Prototype personnel ; ne pas utiliser pour des données sensibles.
- Authentification PBKDF2-SHA256 à 100 000 itérations.
- Pas encore de récupération de mot de passe, validation d'e-mail ni limitation anti-abus.
- Sessions de 30 jours avec cookie HttpOnly, Secure et SameSite=Lax.
- Ne jamais committer de secrets.
