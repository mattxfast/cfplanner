# FitFactory

FitFactory (anciennement CFPlanner) est une application web responsive de planification et de suivi de l'entraînement CrossFit. Elle sépare la programmation prévue, les séances réellement effectuées et les records personnels (PR).

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
- Choix du thème dans « Mon compte », par trois cases exclusives : Automatique (selon le réglage du téléphone), Clair ou Sombre. La préférence est mémorisée sur l'appareil.
- Export Excel dans « Mon compte » : un seul tableau « Bilan », une ligne par semaine ISO dans l'ordre chronologique, tous programmes confondus (une semaine qui chevauche deux programmes a une ligne par programme). Toujours 7 colonnes « WOD 1 » à « WOD 7 », par position (le 1er WOD de son programme compte en WOD 1, etc.) ; à chaque changement de programme, une ligne rappelle le nom du programme et de ses 7 WOD. Les colonnes de mouvements travaillés sont fixes pour tout le fichier : regroupées par nom (un même mouvement présent dans plusieurs programmes garde une seule colonne), limitées aux mouvements cochés au moins une fois.
- Création de compte et connexion par e-mail et mot de passe.
- Protection contre les essais de mots de passe : après 5 échecs en 15 minutes pour un même e-mail (ou 20 depuis une même adresse IP), la connexion est refusée avec le délai d'attente restant. Une connexion réussie remet le compteur de l'e-mail à zéro ; la tâche quotidienne purge les tentatives de plus de 24 h.
- Modification du prénom et du nom.
- Administration réservée au compte défini par `ADMIN_EMAIL`.
- Gestion des utilisateurs (activation / désactivation).
- Gestion de la « Liste des mouvements » (catalogue commun), de leur catégorie et de leur ordre ; les flèches de tri s'affichent via le bouton ⇅ du titre.
- Gestion des activités proposées lors de la création d'un WOD ou d'une séance.

### Application installable (PWA)
- Icône barre de musculation (noire sur fond jaune), plein écran et nom « FitFactory » sur l'écran d'accueil.
- iPhone : ouvrir le site dans Safari, bouton Partager, puis « Sur l'écran d'accueil ».
- Android : ouvrir le site dans Chrome, menu ⋮, puis « Installer l'application ».
- Service worker (`public/sw.js`) en « réseau d'abord » : la dernière version publiée est toujours chargée ; hors connexion, l'application (pages, scripts, polices) s'ouvre depuis le cache. Le service worker ne met jamais en cache les appels `/api/`.
- Rappels par notification (profil → « Rappels ») : une notification si aucune séance n'a été enregistrée depuis 2, 3, 4, 5 ou 7 jours, vers 7 h, 12 h, 18 h ou 20 h (heure de Paris), au plus une fois par jour. Activation par téléphone (sur iPhone : app ajoutée à l'écran d'accueil, iOS 16.4 minimum), bouton de notification de test. Envoi Web Push depuis le Worker (`src/push.js`, sans dépendance : chiffrement RFC 8291, signature VAPID RFC 8292) ; les clés VAPID sont générées une seule fois et gardées dans la table `app_settings` (aucun secret à configurer). Seuls les services de notification d'Apple, Google, Mozilla et Microsoft sont acceptés comme destinataires ; un abonnement expiré (404/410) est supprimé.
- Mode hors ligne (`public/offline.js`) :
  - chaque lecture `/api/…` réussie est gardée sur le téléphone (localStorage) ; sans réseau, la dernière copie est affichée, y compris au démarrage ;
  - sans réseau, les modifications (séances, PR, planification, compétition, programmes…) sont mises en file d'attente dans l'ordre et appliquées tout de suite à l'affichage, puis rejouées automatiquement au retour du réseau (événement « online », retour sur l'application, ou toutes les 20 s) ;
  - un bandeau sous l'en-tête indique « Hors ligne » et le nombre de modifications en attente (toucher le bandeau relance la synchronisation) ;
  - les créations de séance et de PR envoient un `client_id` (UUID généré sur le téléphone) : `POST /api/sessions` et `POST /api/prs` l'utilisent comme identifiant et ne créent jamais de doublon en cas de rejeu ;
  - une modification refusée par le serveur lors du rejeu (par exemple une donnée devenue invalide) est retirée de la file avec un message ;
  - connexion, création de compte, déconnexion et administration nécessitent le réseau ; la déconnexion avertit s'il reste des modifications non synchronisées et efface les données locales.
- Icônes dans `public/icons/` (SVG source + PNG 180, 192, 512 et 512 « maskable »).
- Écran de démarrage : fond jaune, barre de musculation et « FitFactory ». Sur iPhone, images fixes par taille d'écran dans `public/splash/` (une par modèle, déclarées dans `index.html`) ; sur Android, généré à partir de l'icône et de la couleur de fond du manifest.

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
- V8 ajoute la table `login_attempts` (tentatives de connexion échouées, indexées par clé e-mail/IP et date).
- V9 ajoute les tables `app_settings` (clés VAPID), `push_subscriptions` (un abonnement par téléphone) et `reminder_settings` (jours sans séance, heure, dernier envoi).

Le Worker consulte `app_migrations` et n'exécute que les versions qui ne sont pas marquées comme terminées. Les migrations applicatives sont additives : elles ne réinitialisent pas les comptes ni les données existantes. Toute nouvelle évolution de schéma doit recevoir une nouvelle version de migration ; ne pas modifier rétroactivement une migration déjà appliquée.

### Configuration

`wrangler.toml` déclare le Worker `fitfactory` (adresse `fitfactory.mattxfast.workers.dev`), le binding D1, la variable `ADMIN_EMAIL` et active les logs Cloudflare (`[observability]` : consultables dans le tableau de bord, Workers & Pages → `fitfactory` → Logs, ou via `npx wrangler tail fitfactory`). La base D1 s'appelle `fitfactory` (copie de l'ancienne base `cfplanner`, une base D1 ne se renommant pas) . Le cookie de session s'appelle `fitfactory_session` et la préférence de thème `fitfactory-theme` ; les anciens noms (`cfplanner_session`, `cfplanner-theme`) sont encore acceptés et remplacés automatiquement, sans déconnexion. Cette adresse identifie le compte administrateur et le propriétaire du référentiel commun des activités.

Les polices (DM Sans et Manrope, sous-ensemble latin, licence OFL) sont hébergées dans `public/fonts/` et la bibliothèque Excel (SheetJS 0.18.5, Apache-2.0) dans `public/vendor/` : l'application ne charge aucune ressource externe.

Pour un autre environnement, configurez `ADMIN_EMAIL` avec l'adresse du compte administrateur de cet environnement. La variable n'est pas un secret. Les mots de passe, jetons et clés privées ne doivent jamais être enregistrés dans le dépôt.

## Développement et déploiement

Prérequis : Node.js et Wrangler (via `npx`).

Appliquer les migrations Wrangler sur la base distante :

```bash
npx wrangler d1 migrations apply fitfactory --remote
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
