# CFPlanner — Cloudflare Workers + D1

Prototype V1 pour usage personnel. Application web responsive, comptes avec mot de passe hashé PBKDF2, sessions HttpOnly/Secure, isolation des données par utilisateur, programmes non chevauchants et suivi hebdomadaire.

## Déploiement (une seule configuration initiale)

1. Créer une base D1 nommée `cfplanner` dans Cloudflare ou avec Wrangler.
2. Copier son identifiant dans `wrangler.toml` à la place de `REPLACE_WITH_D1_DATABASE_ID`.
3. Appliquer la migration `0001_init.sql` à la base D1.
4. Déployer le Worker avec les assets statiques `public/`.

Commandes avec Wrangler :
```bash
npm install -g wrangler
wrangler login
wrangler d1 create cfplanner
# Copier le database_id retourné dans wrangler.toml
wrangler d1 migrations apply cfplanner --remote
wrangler deploy
```

## Sécurité / limites connues de cette V1

- Le premier compte créé est un compte normal ; aucune restriction d'inscription n'est encore prévue. À utiliser pour des essais, pas pour des données sensibles.
- L'inscription ne comporte pas de confirmation e-mail et la récupération de mot de passe n'est pas encore implémentée. Ne pas perdre le mot de passe.
- Ajouter une protection anti-abus/rate limiting et un flux de récupération sécurisé avant une mise en production ouverte.
- La session dure 30 jours et le cookie est HttpOnly, Secure, SameSite=Lax.
- Les secrets ne doivent jamais être ajoutés au dépôt.
- D1 n'est pas un fichier SQLite local téléchargeable : c'est une base SQLite gérée par Cloudflare.
- Cette version ne comprend pas encore la saisie détaillée des séries/répétitions/charges, les notifications, ni la génération automatique des catégories sur toutes les semaines.
