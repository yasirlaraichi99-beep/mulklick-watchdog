# Watchdog Mulklick

Surveille www.mulklick.ch toutes les 10 minutes depuis GitHub Actions et prévient sur Telegram
**avant** que les données disparaissent du site (disque de la base), et **tout de suite** si elles
disparaissent (panne, page vide). Il est indépendant de la base, du backend et de l'hébergement du
site.

Le dépôt est public parce que les minutes GitHub Actions y sont gratuites. Il ne contient aucun
secret : jetons et identifiants vivent uniquement dans les secrets du dépôt.

## Rôle depuis le 21.11.2026 : SECOURS de la surveillance du cockpit

La surveillance principale tourne dans le cockpit (backend sur Railway), **toutes les 5 minutes**,
sans dépendre de la base ni de Vercel, et publie son signe de vie sur sa route publique `/health`.
Ce workflow GitHub n'est plus que le **secours** (secret `PRINCIPAL_HEALTH_URL`) :

- cockpit vivant (dernier passage il y a moins de 15 min) : il ne contrôle pas le site et se tait ;
- cockpit muet, injoignable ou désactivé : 🟠 IMPORTANT sans son « La surveillance principale ne
  tourne plus » (c'est la surveillance qui est en panne, pas le site), puis il fait lui-même les
  contrôles A à D avec les mêmes règles de communication : si mulklick.ch est réellement en panne,
  c'est ce contrôle qui donne le 🔴 URGENT ;
- ni bilan du lundi ni message « n'a pas tourné » ici : le bilan est celui du cockpit.

## Relais toutes les 10 min (si Railway tombe)

Le workflow « Relais du secours » se relance lui-même toutes les 10 minutes (jeton fourni par
GitHub au passage, aucune clé ajoutée, aucun service extérieur) ; le cron ne sert qu'à relancer
la chaîne si elle casse. Si Railway tombe, l'alerte part en 25 minutes au plus. Cockpit vivant :
le passage ne fait qu'une lecture de son signe de vie et n'envoie rien.

Chaque passage se signale au cockpit (`/health?secours=1`) : si le secours ne passe plus depuis
40 minutes, le cockpit prévient Yasir (une fois, en silencieux). Les deux se surveillent l'un l'autre.
Les passages automatiques ne passent plus par watchdog.yml (lancement manuel et garde-vie seulement).

## Boîte d'alertes du cockpit (22.11.2026)

Le propriétaire reçoit ce bot (« Mulklick Alertes »), pas celui du cockpit. Le cockpit dépose donc
chacun de ses messages dans une boîte en mémoire (`GET /health/boite`, `POST /health/boite/acquitter`)
que le relais relève à chaque passage :

- **Authentification** : jeton OIDC de GitHub Actions (audience `mulklick-cockpit-boite`), vérifié
  par le cockpit avec les clés publiques de GitHub. Aucun secret partagé, rien à copier. Le job
  `relais` de `relais.yml` a pour cela la permission `id-token: write` ; `watchdog.yml` (lancement
  manuel) ne l'a pas : sans jeton, un lancement manuel ne relève rien (mode historique).
- **Cockpit vivant et boîte lisible** : les messages sont livrés par ce bot, le plus ancien d'abord,
  avec son seulement si le cockpit le demande (champ `sonner`, inchangé), 5 au plus par passage (le reste attend le passage
  suivant), puis acquittés. Au premier échec d'envoi, arrêt : seuls les messages partis sont acquittés.
- **Boîte non lisible** (404 = pas encore déployée, 401, 5xx, réseau, réponse illisible) : le relais
  fait lui-même les contrôles A à D, comme si le cockpit était mort. Fusionner ce dépôt seul protège
  donc déjà mulklick.ch. Hors 404, un incident 🟠 silencieux « boîte » est ouvert (une fois, après
  2 passages de suite).
- **Diagnostics du `/health` public** : l'échec du bot direct du cockpit n'est plus un message
  (hors règle) : seulement une ligne de journal du run, sans texte d'erreur. Si le plus ancien
  message de la boîte attend depuis plus de 30 min sans avoir été relevé, incident « boîte ».
- **Journaux publics** : seulement des statuts et compteurs (`Boîte : 2 relevé(s), 2 livré(s), 2
  acquitté(s)`), jamais un texte d'alerte, un jeton ni un corps de réponse.
- **Limite connue** : si le relais lui-même s'arrête, la boîte n'est plus relevée ; l'alerte
  « secours absent » du cockpit ne part alors que par son bot direct.

## Contrôles

| | Contrôle | Ce qui est mesuré |
|---|---|---|
| A | `GET /api/health` du site | statut 200 et `db_ok` vrai, 3 essais espacés de 20 s |
| B | `GET /fr/intelligence` (anti-cache) | cartes nationales avec donnée. Deux formats : `data-card-state="value"`/`"reserved"` (donnée en clair ou masquée aux visiteurs non connectés) contre `"empty"` (aucune donnée) ; à défaut, ancien comptage `data-spark=""` / « Aucune valeur actuelle ». Le watchdog reste anonyme (aucune session ni clé) |
| C | fraîcheur (`age_hours` de /api/health) | ≤ 120 h (scraper lun/mar/jeu/ven, écart max ven → lun 3 j, + 2 j) |
| D | disque (`disk_level`, `disk_pct` de /api/health, aucune clé) | seuils 65 / 80 % de 18 GB (IMPORTANT) et 95 % (URGENT : lecture seule) + projection du remplissage |

## Règle Telegram (Yasir, 23.11.2026)

« Je ne dois pas être dérangé. Je reçois uniquement : 1. URGENT, avec son : une panne en cours
(site, API, base, paiement). 2. IMPORTANT, sans son : un risque détecté AVANT la panne. 3. Le bilan
de la semaine, le lundi à 7h, sans son. Rien d'autre. Un seul message par incident, puis un seul
message « résolu » avec la durée et la cause. Jamais de répétition. »

| Niveau | Quand | Message |
|---|---|---|
| 🔴 **URGENT** | panne en cours : base ou `/api/health` injoignable, page publique sans données, disque à 95 % (base en lecture seule) | **avec son** |
| 🟠 **IMPORTANT** | risque avant la panne : disque ≥ 65 % ou plein dans moins de 30 jours (même « sous 48 h » tant que la base n'est pas en lecture seule), page incomplète, données trop anciennes, niveau disque illisible (**confirmés** sur 2 passages), surveillance principale du cockpit muette, boîte d'alertes du cockpit non relevée, contrôleur de vie externe muet, watchdog arrêté plus de 2 h | **sans son** |
| 🟢 **RÉSOLU** | fin d'un incident, après 1 h de retour à la normale continu (pas de yo-yo) | **sans son** |

- **Aucun message quand tout va bien.** Pas de résumé ici : le bilan du lundi 7 h est celui du cockpit.
- **Un incident = un message d'ouverture** (3 lignes : ce qui se passe, gravité + « Depuis … UTC »,
  action exacte). Une cause = un incident : base injoignable et page vide forment un seul message.
- **Jamais de répétition** : ni rappel, ni « toujours en cours », ni aggravation, ni amélioration, ni
  message « regroupé », ni plafond de sons, ni message de test. Seule exception : un risque IMPORTANT
  qui devient une vraie panne donne **un** message URGENT.
- **RÉSOLU** : deux lignes, `🟢 RÉSOLU — <titre> : <durée> (JJ.MM HH:MM → JJ.MM HH:MM UTC).` puis
  `Cause : <dernier symptôme mesuré par le contrôle>.` (jamais une supposition ; sans symptôme
  enregistré : « non identifiée par la surveillance »).
- **Un problème qui revient après son RÉSOLU** est un nouvel incident : ouverture normale.
- Le relais de la boîte du cockpit livre chaque message déposé tel quel, avec ou sans son selon le
  champ `sonner` du message : la règle est appliquée par le cockpit.
- Si un envoi Telegram échoue, le job échoue et le message repart au passage suivant.

## Preuve de vie

- **Déclencheur arrêté** : cron-job.org envoie un e-mail si sa tâche échoue.
- **Watchdog arrêté plus de 2 h** : signalé (🟠 sans son) dès qu'il repart ; les interruptions plus
  courtes ne donnent aucun message.
- **Contrôleur de vie externe (facultatif)** : avec le secret `HEARTBEAT_URL` (par exemple une
  URL de ping healthchecks.io), le watchdog envoie un signal à chaque passage (`/fail` si ses
  alertes n'ont pas pu partir). Le contrôleur alerte, lui, si le watchdog se tait ; le watchdog
  alerte (🟠 sans son) si le contrôleur refuse ses signaux 3 fois de suite.

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

- Plus de message de test : la règle les interdit (le lancement manuel de `watchdog.yml` ne sert
  qu'à un passage réel).
- Tests locaux et banc d'essai du bruit (réponses simulées, aucun message envoyé) :
  `node --test watchdog.test.mjs`. Le banc simule des semaines entières, un passage toutes les
  10 minutes : une semaine sans incident doit donner 0 message.
- Le 1er de chaque mois, un commit automatique `.keepalive` empêche GitHub de désactiver le cron
  (règle des 60 jours sans activité pour les dépôts publics).
