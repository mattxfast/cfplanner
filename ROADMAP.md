# Évolutions envisagées

Idées notées pour plus tard, pas encore commencées.

## Affichage dynamique sur un écran dans la box

Un écran installé dans la salle fait défiler des informations sur la box : WOD du jour, scores, anniversaires, mot du jour, événements.

### Contenu

- **Depuis les données de l'application** :
  - WOD du jour de la box (WOD de box existants).
  - Scores et classements des WOD (classements de box existants, par catégorie RX / Inter / Scaled).
  - Anniversaires des membres. Il faudra ajouter une date de naissance au profil, avec une case « Afficher mon anniversaire sur l'écran de la box ». On n'affiche que le jour et le mois, jamais l'âge.
- **Saisi par le gestionnaire de la box** (nouvelle page dans l'espace gestionnaire) :
  - Mot du jour.
  - Événements sociaux : plusieurs en même temps, chacun avec une période d'affichage (dates de début et de fin).

### Principes

- Plusieurs box : chaque box a son propre écran et son propre contenu.
- Une page dédiée (par exemple `/ecran`) en plein écran, sans interaction. Elle fait tourner des cartes (WOD, scores, anniversaires, mot du jour, événements), chacune avec une durée d'affichage. Une carte sans contenu est sautée.
- Authentification par un **jeton d'écran** propre à la box : lecture seule, généré et révocable par le gestionnaire. On ne laisse pas de session utilisateur ouverte sur un écran public.
- Une seule route qui renvoie tout le contenu de l'écran, interrogée toutes les 1 à 5 minutes, avec un cache côté Worker (limites du plan gratuit Cloudflare).
- Vie privée : un membre doit pouvoir choisir de ne pas apparaître sur l'écran (scores, anniversaire). Afficher le prénom et l'initiale du nom plutôt que le nom complet.

### Matériel (à décider)

- Idéalement une TV avec navigateur intégré, sinon un Raspberry Pi en mode kiosque.
- Prévoir une mise en page lisible de loin (grands caractères, fort contraste), en 16:9, et éviter que l'écran se mette en veille.
