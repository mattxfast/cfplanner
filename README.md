# CFPlanner V2 — Cloudflare Workers + D1

Application web responsive de suivi CrossFit : programmes, WOD réutilisables par programme, séances datées, notes prévues/réalisées et statistiques par WOD.

## Premier lancement

La base D1 doit déjà contenir le socle V1 initial (migrations/0001_init.sql : utilisateurs, sessions, programmes et anciennes entrées hebdomadaires).

Au premier appel API de la V2, le Worker :
1. crée automatiquement les tables V2 et leurs index ;
2. inscrit une migration dans app_migrations ;
3. vide une seule fois les comptes et données V1, comme demandé pour le démarrage propre ;
4. ne répète plus jamais cette remise à zéro aux appels suivants.

Aucune commande Wrangler ni intervention manuelle dans le tableau de bord Cloudflare n'est nécessaire pour la mise à niveau V2. Le bootstrap est exécuté côté Worker et le reset est transactionnel/idempotent.

## Déploiement

Le dépôt est configuré pour Cloudflare Workers avec les assets statiques dans public/ et la base D1 cfplanner. Le déploiement du Worker déclenche le bootstrap au premier appel API.

## Sécurité et limites

- Prototype personnel ; ne pas utiliser pour des données sensibles.
- Authentification PBKDF2-SHA256 à 100 000 itérations, contrainte de compatibilité WebCrypto observée sur Cloudflare Workers.
- Pas encore de récupération de mot de passe, validation d'e-mail ni limitation anti-abus.
- Sessions de 30 jours avec cookie HttpOnly, Secure et SameSite=Lax.
- Ne jamais committer de secrets.
