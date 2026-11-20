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
| D | niveau du disque lu dans `/api/health` (`disk_level`, calculé côté site, aucune clé nécessaire) | ≥ 65 % 🟠, ≥ 80 % 🔴 de 18 GB (taille de la base, sous-estime légèrement le disque réel) | 🟠 / 🔴 |

Anti-spam : un message au passage OK → KO, un rappel par heure tant que c'est KO, un message
🟢 « rétabli » au retour. Si l'envoi Telegram échoue, le job échoue et l'alerte repart au passage
suivant.

**Bilan du matin** : chaque jour, au premier passage à partir de 08:00 heure suisse, un message
« ☀️ BILAN DU MATIN » donne l'heure du passage, le niveau du disque, les contrôles en alerte s'il
y en a et le nombre de passages depuis le bilan précédent (≈ 144 attendus). **S'il manque un
matin, le watchdog est arrêté.**

## Déclenchement

- **cron-job.org** appelle toutes les 10 minutes l'API `workflow_dispatch` de ce workflow, avec un
  jeton GitHub limité à ce seul dépôt et au seul droit « Actions ». C'est le déclencheur principal :
  depuis fin octobre 2026, le cron de GitHub ne déclenche plus les nouveaux workflows (problème
  GitHub connu, non résolu), alors que le lancement manuel marche.
- Le cron GitHub (`*/10`) est laissé en place : s'il se remet à marcher, il double simplement les
  passages, sans doublon d'alerte (l'état anti-spam est partagé).

## Secrets du dépôt

| Secret | Rôle |
|---|---|
| `TELEGRAM_BOT_TOKEN` | jeton du bot d'alertes |
| `TELEGRAM_CHAT_ID` | destinataire |

## Utilisation

- Test manuel (envoie un résumé même si tout va bien) : `gh workflow run watchdog.yml -f test=true`
- Tests locaux, réponses simulées, aucun message envoyé : `node --test watchdog.test.mjs`
- Le 1er de chaque mois, un commit automatique `.keepalive` empêche GitHub de désactiver le cron
  (règle des 60 jours sans activité pour les dépôts publics).
