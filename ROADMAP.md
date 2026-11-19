# Feuille de route — idées et évolutions

Liste partagée par tous les agents et par Matt. Chaque idée a un **numéro définitif** (on ne renumérote jamais) : on peut
dire « fais l'idée 7 ».

- Idée faite : cocher la case (`[x]`) et ajouter la date et le commit en fin de ligne ; on peut la déplacer dans
  « Fait » plus tard.
- Idée abandonnée : la barrer (`~~…~~`) en disant pourquoi, sans la supprimer (le numéro reste pris).
- Nouvelle idée : l'ajouter dans la bonne rubrique avec le **numéro suivant le plus grand existant**.
- *En italique* : la décision de Matt quand il y en a une.

Prochain numéro libre : **29**

## Fiabilité et exploitation

- [ ] **1.** Sauvegardes automatiques de la base D1 (copie hebdomadaire dans R2, en plus du Time Travel de 30 jours). *Reporté à plus tard.*
- [ ] **2.** Supprimer l'ancien Worker `fitfactory` (page « déménagé ») et l'ancienne base D1 `fitfactory`. *Après validation de Matt.*
- [ ] **3.** Envoi des e-mails « mot de passe oublié » : compte Resend, secret `RESEND_API_KEY`, variable `MAIL_FROM` (voir README, Configuration).

## Déploiement

- [ ] **4.** Branche `dev` déployée sur une adresse de test, pour valider avant la production. *Prévu plus tard.*
- [ ] **5.** Contrôle automatique sur GitHub (GitHub Action : `node --check`, Prettier, tests) à chaque push.
- [ ] **6.** Nom de domaine propre (par exemple `myfitfactory.fr`) au lieu de `workers.dev`.

## Code

- [ ] **7.** Finir le nettoyage du CSS : supprimer les `!important` restants de `style.css` (52 au 19/11/2026, 374 au départ).
- [ ] **8.** Tests : éviter les collisions de ports entre fichiers de test (port choisi au hasard dans 8790–8889) et les serveurs `wrangler dev` restés ouverts, qui font échouer des tests sans raison.

## Fonctionnalités

- [ ] **9.** Graphiques de progression : séances par semaine, répartition par WOD et par mouvement, régularité.
- [ ] **10.** Score des WOD de la programmation (temps, tours, charge) avec historique par WOD, comme pour les WOD de box.
- [ ] **11.** Objectifs : nombre de séances par semaine ou PR cible, avec une jauge. *Pas maintenant.*
- [ ] **12.** Calculateur de charges : pourcentages des PR (WOD « à 75 % du 1RM »).
- [ ] **13.** Rappeler le dernier commentaire laissé sur le même WOD au moment d'enregistrer une séance.
- [ ] **14.** WOD du jour : WOD de référence tirés au hasard (Fran, Cindy, Murph…), sans IA, gratuits et hors ligne.
- [ ] **15.** WOD du jour : mode « Mon coach » (WOD proposé chaque matin, semaine équilibrée, notification possible).
- [ ] **16.** WOD du jour : privilégier les mouvements peu travaillés ces dernières semaines.
- [ ] **18.** Affichage dynamique sur un écran dans la box (WOD du jour, scores, anniversaires, mot du jour, événements) : voir le détail plus bas.

## Look and feel

- [ ] **19.** Thèmes de couleur supplémentaires dans « Apparence » : orange, rose, vert citron (maquettes faites le 19/11/2026). *Matt doit choisir.*
- [ ] **20.** Bordure un peu plus foncée pour les blocs « pas de contenu », sur toutes les pages.
- [x] **21.** WOD de la box déjà fait : retirer aussi son bouton ＋ (comme pour la programmation). — fait le 19/11/2026
- [x] **22.** Mouvements cochés d'office par le WOD du jour : reconnaître aussi les variantes de noms (« Wall ball » / « Wall balls », pluriels, abréviations). — fait le 19/11/2026
- [ ] **23.** Écrans de démarrage et icône : vérifier le rendu sur Android (icône « maskable »).

## Écartées

- ~~**17.** WOD du jour : proposer d'abord le WOD de la box du jour s'il existe, l'IA en alternative.~~ *Matt : ne sera pas fait.*
- ~~**24.** Accessibilité : respecter « réduire les animations », renforcer les contrastes.~~ *Matt : non.*

## Fait

- [x] **25.** Logs du Worker, limitation des tentatives de connexion, bibliothèque Excel et polices hébergées dans l'app.
- [x] **26.** Rappels par notification, mode hors ligne avec resynchronisation, chronomètre de WOD.
- [x] **27.** Renommage en myFitFactory (dépôt, Worker, base D1), icône et écran de démarrage, police Saira.
- [x] **28.** WOD du jour généré par IA, chrono préréglé, séance enregistrée plus tard (19/11/2026, `3480ad8`).

## Détails des idées

### 18. Affichage dynamique sur un écran dans la box

Un écran installé dans la salle fait défiler des informations sur la box : WOD du jour, scores, anniversaires, mot du jour, événements.

#### Contenu

- **Depuis les données de l'application** :
  - WOD du jour de la box (WOD de box existants).
  - Scores et classements des WOD (classements de box existants, par catégorie RX / Inter / Scaled).
  - Anniversaires des membres. Il faudra ajouter une date de naissance au profil, avec une case « Afficher mon anniversaire sur l'écran de la box ». On n'affiche que le jour et le mois, jamais l'âge.
- **Saisi par le gestionnaire de la box** (nouvelle page dans l'espace gestionnaire) :
  - Mot du jour.
  - Événements sociaux : plusieurs en même temps, chacun avec une période d'affichage (dates de début et de fin).

#### Principes

- Plusieurs box : chaque box a son propre écran et son propre contenu.
- Une page dédiée (par exemple `/ecran`) en plein écran, sans interaction. Elle fait tourner des cartes (WOD, scores, anniversaires, mot du jour, événements), chacune avec une durée d'affichage. Une carte sans contenu est sautée.
- Authentification par un **jeton d'écran** propre à la box : lecture seule, généré et révocable par le gestionnaire. On ne laisse pas de session utilisateur ouverte sur un écran public.
- Une seule route qui renvoie tout le contenu de l'écran, interrogée toutes les 1 à 5 minutes, avec un cache côté Worker (limites du plan gratuit Cloudflare).
- Vie privée : un membre doit pouvoir choisir de ne pas apparaître sur l'écran (scores, anniversaire). Afficher le prénom et l'initiale du nom plutôt que le nom complet.

#### Matériel (à décider)

- Idéalement une TV avec navigateur intégré, sinon un Raspberry Pi en mode kiosque.
- Prévoir une mise en page lisible de loin (grands caractères, fort contraste), en 16:9, et éviter que l'écran se mette en veille.
