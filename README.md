# CFPlanner

CFPlanner est une application web responsive de planification et de suivi de l'entraînement CrossFit. Elle sépare la programmation prévue, les séances réellement effectuées et les records personnels (PR).

## Fonctionnalités

### Navigation
- En-tête compact (logo, nom de l'utilisateur, accès au compte et déconnexion).
- Barre d'onglets fixée en bas de l'écran, toujours visible pendant le défilement, avec des icônes : kettlebell (Séances), planning (Programmes & WOD) et éclair (PR).

### Séances
- Vue hebdomadaire avec navigation entre les semaines.
- Suivi du nombre de séances réalisées et de l'avancement des WOD de la programmation.
- Planification d'un WOD sur une semaine, indépendamment de son enregistrement réel.
- Indicateur de semaine de compétition.
- Historique des séances avec modification et suppression.
- Enregistrement de la date, de l'activité, des notes et des mouvements travaillés. L'heure de départ et la durée sont masquées pour l'instant : elles restent renseignées automatiquement (durée par défaut du WOD ou de l'activité).
- Si le programme n'a aucun mouvement à travailler, la séance permet de cocher n'importe quel mouvement du catalogue ; ces mouvements apparaissent dans le récapitulatif de la semaine et dans l'export Excel.

Une planification n'est pas une séance réalisée : elle sert de repère dans la semaine. La séance n'est comptabilisée qu'après son enregistrement.

### Programmes et WOD
- Création de programmes avec dates de début et de fin.
- Ajout de WOD réutilisables dans chaque programme.
- Description du contenu prévu, activité associée et durée par défaut.
- Réorganisation des WOD via le bouton ⇅ du titre de rubrique (mode « Réorganiser » qui affiche les flèches ↑ ↓).
- Un WOD ou un programme qui a déjà une séance réalisée ne peut plus être supprimé.
- Liste de mouvements à travailler pour chaque programme.
- Ajout de mouvements depuis le catalogue commun, géré par l’administrateur.
- Réorganisation des mouvements via le même bouton ⇅.

### Records personnels (PR)
Les mouvements du catalogue sont répartis en quatre familles :

| Catégorie | Type de mesure | Exemple de saisie |
|---|---|---|
| Lift | Charge en kg | 100 kg – 1 RM |
| Force | Charge en kg | 120 kg – 3 RM |
| Gym | Nombre de répétitions | 25 répétitions |
| Engine | Distance en mètres | 2 000 m |

Les cartes PR sont classées selon l'ordre du catalogue. L'historique d'un mouvement affiche les enregistrements et la courbe d'évolution. Les enregistrements peuvent être supprimés depuis leur historique.

### Compte et administration
- Choix du thème dans « Mon compte » : Automatique (selon le réglage du téléphone), Clair ou Sombre. La préférence est mémorisée sur l'appareil.
- Création de compte et connexion par e-mail et mot de passe.
- Modification du prénom et du nom.
- Administration réservée au compte défini par `ADMIN_EMAIL`.
- Gestion des utilisateurs (activation / désactivation).
- Gestion de la « Liste des mouvements » (catalogue commun), de leur catégorie et de leur ordre ; les flèches de tri s'affichent via le bouton ⇅ du titre.
- Gestion des activités proposées lors de la création d'un WOD ou d'une séance.

## Utilisation

1. Créer un compte et se connecter.
2. Renseigner son prénom et son nom dans **Mon compte**.
3. Créer un programme avec ses dates.
4. Ajouter les WOD et leurs consignes, puis les mouvements à travailler.
5. Dans **Séances**, planifier les WOD de la semaine si utile.
6. Après l'entraînement, enregistrer la séance réelle : WOD, date, heure, durée, activité, notes et mouvements travaillés.
7. Dans **PR**, saisir les records personnels et consulter leur historique.

Les dates de séance ne peuvent pas être dans le futur. Un programme doit couvrir la date de la séance enregistrée.

## Architecture technique

- **Frontend** : HTML, CSS et JavaScript dans `public/`.
- **Couleurs** : toutes définies dans la palette en tête de `public/style.css` (variables `:root` nommées par rôle : bandeau, rubrique, contenu, action, suppression…). Le thème sombre redéfinit les mêmes variables sous `:root[data-theme="dark"]`.
- **Backend** : Cloudflare Worker dans `src/worker.js`.
- **Base de données** : Cloudflare D1, binding `DB`.
- **Assets statiques** : binding Cloudflare `ASSETS`.
- **Configuration Wrangler** : `wrangler.toml`.
- **Migrations D1 initiales** : dossier `migrations/`.
- **Migrations applicatives** : registre `app_migrations`, piloté par le Worker.

### Migrations de base de données

La migration Wrangler `0001_init.sql` installe le socle initial (utilisateurs, sessions, programmes et anciennes entrées hebdomadaires).

Les évolutions applicatives V2 et V3 sont versionnées dans le Worker :
- V2 crée les tables et colonnes nécessaires à l'application actuelle.
- V3 ajoute l'index sur les mouvements cochés dans les séances.
- V7 ajoute la table `session_catalog_movement_checks` (mouvements du catalogue cochés dans une séance d'un programme sans mouvement à travailler).

Le Worker consulte `app_migrations` et n'exécute que les versions qui ne sont pas marquées comme terminées. Les migrations applicatives sont additives : elles ne réinitialisent pas les comptes ni les données existantes. Toute nouvelle évolution de schéma doit recevoir une nouvelle version de migration ; ne pas modifier rétroactivement une migration déjà appliquée.

### Configuration

`wrangler.toml` contient le binding D1 et la variable `ADMIN_EMAIL`. Cette adresse identifie le compte administrateur et le propriétaire du référentiel commun des activités.

Pour un autre environnement, configurez `ADMIN_EMAIL` avec l'adresse du compte administrateur de cet environnement. La variable n'est pas un secret. Les mots de passe, jetons et clés privées ne doivent jamais être enregistrés dans le dépôt.

## Développement et déploiement

Prérequis : Node.js et Wrangler (via `npx`).

Appliquer les migrations Wrangler sur la base distante :

```bash
npx wrangler d1 migrations apply cfplanner --remote
```

Déployer le Worker et les assets :

```bash
npx wrangler deploy
```

Le premier appel API après déploiement déclenche la vérification et, si nécessaire, l'application des migrations applicatives V2/V3. Vérifier les journaux du Worker après une évolution de schéma.

## API conservées

Le Worker conserve notamment les routes de statistiques et d'export (`/api/stats` et `/api/export-data`) pour préserver une compatibilité éventuelle avec des consommateurs externes, même si elles ne sont pas utilisées par l'interface actuelle.

## Sécurité et limites connues

- Application personnelle ; ne pas y stocker de données médicales ou hautement sensibles.
- Mots de passe hachés avec PBKDF2-SHA256 (100 000 itérations).
- Sessions de 30 jours, cookie HttpOnly, Secure et SameSite=Lax.
- Pas encore de récupération de mot de passe, de validation d'adresse e-mail ni de protection anti-abus dédiée.
- Ne jamais committer de secrets.
