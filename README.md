# Watchdog Mulklick

Surveille www.mulklick.ch toutes les 10 minutes depuis GitHub Actions et prévient sur Telegram
**avant** que les données disparaissent du site (disque de la base), et **tout de suite** si elles
disparaissent (panne, page vide). Il est indépendant de la base, du backend et de l'hébergement du
site.

Le dépôt est public parce que les minutes GitHub Actions y sont gratuites. Il ne contient aucun
secret : jetons et identifiants vivent uniquement dans les secrets du dépôt.

## Contrôles

| | Contrôle | Échec | Niveau |
|---|---|---|---|
| A | `GET /api/health` du site | statut ≠ 200 ou `db_ok` faux, après 3 essais espacés de 20 s | 🔴 |
| B | `GET /fr/intelligence` (anti-cache) | cartes nationales vides (« Aucune valeur actuelle ») ou marqueurs absents | 🔴 / 🟠 |
| C | fraîcheur (`age_hours` de /api/health) | > 120 h (scraper lun/mar/jeu/ven, écart max ven → lun 3 j, + 2 j) | 🟠 |
| D | disque de la base (métriques Supabase) | ≥ 70 % 🟠, ≥ 85 % 🔴 (du plafond de 18 GB ou du disque actuel, le plus élevé) | 🟠 / 🔴 |

Anti-spam : un message au passage OK → KO, un rappel par heure tant que c'est KO, un message
🟢 « rétabli » au retour. Si l'envoi Telegram échoue, le job échoue et l'alerte repart au passage
suivant.

## Secrets du dépôt

| Secret | Rôle |
|---|---|
| `TELEGRAM_BOT_TOKEN` | jeton du bot d'alertes |
| `TELEGRAM_CHAT_ID` | destinataire |
| `SUPABASE_PROJECT_REF` | référence du projet Supabase (contrôle D) |
| `SUPABASE_SERVICE_KEY` | clé secrète Supabase (contrôle D) — tant qu'elle manque, D est sauté |

## Utilisation

- Test manuel (envoie un résumé même si tout va bien) : `gh workflow run watchdog.yml -f test=true`
- Tests locaux, réponses simulées, aucun message envoyé : `node --test watchdog.test.mjs`
- Le 1er de chaque mois, un commit automatique `.keepalive` empêche GitHub de désactiver le cron
  (règle des 60 jours sans activité pour les dépôts publics).
