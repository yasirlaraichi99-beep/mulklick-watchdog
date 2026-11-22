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
- cockpit muet, injoignable ou désactivé : 🔴 alerte « La surveillance principale ne tourne plus »,
  puis il fait lui-même les contrôles A à D avec les mêmes règles de communication ;
- ni résumé du lundi ni message « n'a pas tourné » ici : c'est le cockpit qui s'en charge.

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
  avec son seulement si le cockpit le demande, 5 au plus par passage (le reste attend le passage
  suivant), puis acquittés. Au premier échec d'envoi, arrêt : seuls les messages partis sont acquittés.
- **Boîte non lisible** (404 = pas encore déployée, 401, 5xx, réseau, réponse illisible) : le relais
  fait lui-même les contrôles A à D, comme si le cockpit était mort. Fusionner ce dépôt seul protège
  donc déjà mulklick.ch. Hors 404, un incident 🟠 silencieux « boîte » est ouvert (une fois, après
  2 passages de suite).
- **Diagnostics du `/health` public** : 🟠 silencieux « envoi direct du cockpit » quand son dernier
  échec Telegram est plus récent que son dernier succès (le texte reprend l'erreur donnée par
  Telegram ; ses alertes arrivent quand même ici) ; clos 1 h après un succès postérieur. Si le plus
  ancien message de la boîte attend depuis plus de 30 min sans avoir été relevé, incident « boîte ».
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
