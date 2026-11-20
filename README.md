# Watchdog Mulklick

Surveille www.mulklick.ch toutes les 10 minutes depuis GitHub Actions et prévient sur Telegram
**avant** que les données disparaissent du site (disque de la base), et **tout de suite** si elles
disparaissent (panne, page vide). Il est indépendant de la base, du backend et de l'hébergement du
site.

Le dépôt est public parce que les minutes GitHub Actions y sont gratuites. Il ne contient aucun
secret : jetons et identifiants vivent uniquement dans les secrets du dépôt.

## Contrôles

| | Contrôle | Ce qui est mesuré |
|---|---|---|
| A | `GET /api/health` du site | statut 200 et `db_ok` vrai, 3 essais espacés de 20 s |
| B | `GET /fr/intelligence` (anti-cache) | cartes nationales chiffrées (« Aucune valeur actuelle » = carte vide) |
| C | fraîcheur (`age_hours` de /api/health) | ≤ 120 h (scraper lun/mar/jeu/ven, écart max ven → lun 3 j, + 2 j) |
| D | disque (`disk_level`, `disk_pct` de /api/health, aucune clé) | seuils 65 / 80 / 90 % de 18 GB + projection du remplissage |

## Règles de communication

| Niveau | Quand | Message |
|---|---|---|
| 🔴 **Urgent** | panne (base ou page injoignable), données absentes, disque ≥ 90 % ou plein dans moins de 48 h au rythme actuel, contrôleur de vie muet | **avec son**, immédiat |
| 🟠 **Important** | disque ≥ 65 % ou plein dans moins de 30 jours, page incomplète, données trop anciennes, niveau disque illisible (anomalies **confirmées** sur 2 passages), watchdog arrêté plus de 2 h | **silencieux**, une seule fois |
| 📋 **Information** | tout le reste (passages, petites interruptions, tendance du disque) | uniquement dans le **résumé silencieux du lundi** (08:00 heure suisse) |

- **Aucun message quand tout va bien**, pas de message quotidien.
- **Une cause = un message** : base injoignable et page vide forment un seul incident, y compris
  pendant l'heure où le cache du site reste vide après le retour de la base.
- **Pas de répétition** : un problème signalé ne redonne un message que s'il s'aggrave ou change de
  niveau (`renotifyMs` permet une répétition après une durée, désactivée par défaut).
- **Clôture** : message silencieux 🟢 après 1 h de retour à la normale continu (pas de yo-yo).
- **Récidive** : un problème qui revient moins de 6 h après sa clôture donne un seul message
  silencieux 🔁 ; il n'est ensuite clos qu'après 6 h normales.
- Un niveau ne baisse qu'après 3 passages plus bas de suite ; le disque garde son alerte jusqu'à
  60 % (pas de yo-yo autour de 65 %).
- **Plafond** : au plus 3 messages sonores par jour hors panne en cours ; au-delà, un message
  silencieux 🔕 les regroupe et le dit.
- **Format** : 3 lignes au plus (ce qui se passe, gravité, action). Le détail est dans le journal
  du run (onglet Actions).
- Si un envoi Telegram échoue, le job échoue et le message repart au passage suivant.

## Preuve de vie

- **Déclencheur arrêté** : cron-job.org envoie un e-mail si sa tâche échoue.
- **Watchdog arrêté plus de 2 h** : signalé (🟠 silencieux) dès qu'il repart ; les petites
  interruptions vont dans le résumé du lundi, qui compte aussi les passages faits / attendus.
- **Contrôleur de vie externe (facultatif)** : avec le secret `HEARTBEAT_URL` (par exemple une
  URL de ping healthchecks.io), le watchdog envoie un signal à chaque passage (`/fail` si ses
  alertes n'ont pas pu partir). Le contrôleur alerte, lui, si le watchdog se tait ; le watchdog
  alerte (🔴) si le contrôleur refuse ses signaux 3 fois de suite.

## Prise en charge des incidents (partie 7) — inerte sans `GARDE_ACTIVE`

Quand Yasir pose la variable de dépôt `GARDE_ACTIVE` = `true` (après le banc d'essai réussi et la
garde du cockpit allumée) :

- chaque incident a **son sujet** dans le groupe Telegram « Incidents Mulklick » ; le watchdog le
  crée, y poste ses messages et **signale l'incident au cockpit**, qui tire l'agent de garde
  (routine Claude) puis, s'il se tait ou échoue, l'agent relais automatique ;
- le watchdog vérifie **lui-même** les délais : pris en charge en 5 min (urgent) / 30 min
  (important), diagnostic en 60 min / 24 h. Personne à temps (ou cockpit injoignable) →
  🚨 **URGENCE ABSOLUE**, sonore, répétée toutes les 10 min jusqu'à ce que Yasir réponde dans le
  sujet, avec l'agent attendu et la raison connue de son silence ;
- secrets : `TELEGRAM_INCIDENTS_CHAT_ID`, `COCKPIT_API_URL`, `COCKPIT_WATCHDOG_TOKEN`,
  `CF_ACCESS_CLIENT_ID`, `CF_ACCESS_CLIENT_SECRET` (ces trois derniers n'ouvrent que les deux
  routes du watchdog au cockpit).

Banc d'essai : `node banc-garde.mjs` (rapport scénario par scénario, échecs en premier) ; rejoué
par GitHub à chaque PR (workflow « Tests et banc d'essai »).

## Déclenchement

- **cron-job.org** appelle toutes les 10 minutes l'API `workflow_dispatch` de ce workflow, avec un
  jeton GitHub limité à ce seul dépôt et au seul droit « Actions ». C'est le déclencheur principal :
  depuis fin octobre 2026, le cron de GitHub ne déclenche plus les nouveaux workflows (problème
  GitHub connu, non résolu), alors que le lancement manuel marche.
- Le cron GitHub (`*/10`) est laissé en place : s'il se remet à marcher, il double simplement les
  passages, sans doublon d'alerte (l'état est partagé).

## Secrets du dépôt

| Secret | Rôle |
|---|---|
| `TELEGRAM_BOT_TOKEN` | jeton du bot d'alertes |
| `TELEGRAM_CHAT_ID` | destinataire |
| `HEARTBEAT_URL` | facultatif : URL de ping du contrôleur de vie externe |

## Utilisation

- Test manuel (résumé silencieux des 4 contrôles) : `gh workflow run watchdog.yml -f test=true`
- Tests locaux et banc d'essai du bruit (réponses simulées, aucun message envoyé) :
  `node --test watchdog.test.mjs`. Le banc simule des semaines entières, un passage toutes les
  10 minutes : une semaine sans incident doit donner 0 message sonore et 1 seul silencieux.
- Le 1er de chaque mois, un commit automatique `.keepalive` empêche GitHub de désactiver le cron
  (règle des 60 jours sans activité pour les dépôts publics).
