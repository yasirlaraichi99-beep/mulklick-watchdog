// Watchdog Mulklick — tourne sur GitHub Actions (.github/workflows/watchdog.yml), indépendamment de
// la base et de l'hébergement du site. Lecture seule : il ne fait que des GET publics et envoie les
// alertes sur Telegram. Aucune clé d'API n'est nécessaire.
// DÉPÔT PUBLIC : aucun secret ni identifiant interne dans ce code, tout passe par les secrets GitHub.
//
// Quatre contrôles :
//   A — panne      : GET /api/health → 200 et db_ok=true, 3 essais espacés de 20 s.
//   B — page       : GET /fr/intelligence → les cartes nationales ont une donnée. Deux formats lus :
//                    NOUVEAU (data-card-state="value|reserved|empty" : une donnée masquée aux visiteurs
//                    non connectés compte comme présente) ou ANCIEN (courbes data-spark / « Aucune valeur
//                    actuelle »). Le watchdog reste anonyme : aucune session, aucun cookie, aucune clé.
//   C — fraîcheur  : age_hours (rendu par /api/health) ≤ seuil.
//   D — disque     : disk_level / disk_pct (rendus par /api/health), avec projection du remplissage.
//
// RÈGLE TELEGRAM (Yasir, 23.11.2026 — prioritaire sur toute autre consigne de message) :
//   « Je ne dois pas être dérangé. Je reçois uniquement : 1. URGENT, avec son : une panne en cours
//   (site, API, base, paiement). 2. IMPORTANT, sans son : un risque détecté AVANT la panne. 3. Le bilan
//   de la semaine, le lundi à 7h, sans son (celui du cockpit : ce dépôt n'envoie plus de résumé).
//   Rien d'autre. Un seul message par incident, puis un seul message « résolu » avec la durée et la
//   cause. Jamais de répétition. »
//   - Aucun message quand tout va bien.
//   - Ouverture : UN message (🔴 URGENT avec son, ou 🟠 IMPORTANT sans son), 3 lignes au plus :
//     ce qui se passe, gravité + « Depuis … UTC », action exacte.
//     Exception unique : un risque IMPORTANT qui devient une vraie panne donne UN message URGENT.
//   - Fin : UN message 🟢 RÉSOLU sans son (titre, durée, début → fin, cause = dernier symptôme mesuré),
//     après un retour à la normale continu d'1 h (anti yo-yo).
//   - Un problème qui revient APRÈS son « résolu » est un nouvel incident : ouverture normale.
//   - Interdits : rappel, « toujours en cours », aggravation, amélioration, « REGROUPÉ », plafond de
//     sons, résumé, digest, message de test.
//   - Regroupement : les symptômes d'une même cause donnent UN message (base injoignable + page vide).
//   - Son : seulement une panne en cours (page, API, base). Tout le reste est un risque : sans son.
//   - Preuve de vie sans message : un arrêt du watchdog de plus de 2 h est signalé à la reprise (IMPORTANT,
//     hors mode secours) ; un contrôleur de vie externe facultatif (secret HEARTBEAT_URL) reçoit un
//     signal à chaque passage ; le watchdog signale (IMPORTANT) si ce contrôleur ne répond plus.
//
// État (anti-spam, incidents) : relu depuis WATCHDOG_STATE_FILE (cache Actions). Un message
// non parti n'avance pas l'état : il repartira au passage suivant, et le job échoue.
//
// Aucune dépendance : Node ≥ 20 (fetch global). Le module exporte sa logique pour les tests
// (watchdog.test.mjs), qui simulent toutes les réponses réseau — aucun vrai message n'y part.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const CONFIG = {
  siteBase: 'https://www.mulklick.ch',
  healthPath: '/api/health',
  pagePath: '/fr/intelligence',
  // Marqueurs relevés dans le code du site (cartes nationales de /fr/intelligence) :
  // - carte SANS donnée : « Aucune valeur actuelle », une fois par carte vide ;
  // - carte AVEC donnée : la courbe <polyline data-spark="">, rendue seulement quand la carte a un
  //   score. La page en porte 8 quand tout va bien (environ 130 Ko de HTML).
  // Format ANCIEN ci-dessus, utilisé seulement si la page ne porte aucun « data-card-state= ».
  // Format NOUVEAU (données réservées aux visiteurs connectés) : chaque carte porte
  // data-card-state="value" (en clair), "reserved" (donnée présente mais masquée) ou "empty" (aucune
  // donnée). Présent = value + reserved ; absent = empty. Les deux formats marchent, avant et après
  // le déploiement du site.
  markerAbsent: 'Aucune valeur actuelle',
  markerPresent: 'data-spark=""',
  markerCardState: 'data-card-state=',
  markerCardValue: 'data-card-state="value"',
  markerCardReserved: 'data-card-state="reserved"',
  markerCardEmpty: 'data-card-state="empty"',
  expectedCards: 8,
  minPageBytes: 20_000, // sans aucun marqueur et plus courte que ça : page vide ou page d'erreur
  healthAttempts: 3,
  retryDelayMs: 20_000,
  requestTimeoutMs: 15_000,
  // Le scraper tourne lun, mar, jeu, ven à 03:00 Europe/Zurich. Le plus long écart normal entre deux
  // captures est ven → lun = 3 jours. Seuil = cadence + 2 jours = 5 jours.
  freshnessMaxHours: 120,

  // ── Communication ──
  confirmRuns: 2, // anomalie « confirmée » : vue 2 passages de suite avant un message IMPORTANT
  resolveAfterOkMs: HOUR, // clôture après 1 h de retour à la normale continu (pas de yo-yo)
  runEveryMs: 10 * MIN,
  gapImportantMs: 2 * HOUR, // watchdog arrêté plus de 2 h : message IMPORTANT à la reprise

  // ── Disque ──
  diskWarnPct: 65, // seuil « avertissement » calculé côté site (/api/health)
  diskReadOnlyPct: 95, // à 95 %, Supabase passe la base en lecture seule : seule vraie panne (URGENT)
  diskUrgentDays: 2, // « risque sous 48 h » : IMPORTANT tant que la base n'est pas en lecture seule
  diskImportantDays: 30, // « risque prévu sous 30 jours »
  diskMinStepMs: 12 * HOUR, // pas de projection sur un palier franchi en moins de 12 h (à-coups du scraper)
  diskHysteresisPct: 5, // un incident disque ne se clôt que 5 points sous 65 % (pas de yo-yo)

  // ── Contrôleur de vie externe (facultatif) ──
  heartbeatFailRuns: 3,

  // ── Mode secours (21.11.2026) ──
  // La surveillance principale tourne dans le cockpit (Railway), toutes les 5 min, et publie son
  // signe de vie sur sa route publique /health. Ce workflow GitHub n'est plus que le SECOURS : quand
  // il passe, il lit ce signe de vie ; plus vieux que ce délai (ou absent) → alerte + contrôles.
  principalStaleMs: 15 * MIN,

  // ── Boîte d'alertes du cockpit (22.11.2026) ──
  // Le propriétaire reçoit ce bot (« Mulklick Alertes »), pas celui du cockpit. Le cockpit dépose donc
  // ses messages dans une boîte que ce relais relève (jeton OIDC de GitHub Actions, aucun secret
  // partagé), livre par ce bot, puis acquitte. Si la boîte n'est pas relevable, le relais fait lui-même
  // les contrôles du site (comme si le cockpit était mort).
  boiteAudience: 'mulklick-cockpit-boite',
  boitePath: '/health/boite',
  boiteAcquitterPath: '/health/boite/acquitter',
  boiteMaxParPassage: 5, // un afflux ne sonne pas en rafale : le reste attend le passage suivant
  boiteAncienneteMs: 30 * MIN, // message plus ancien que ça dans la boîte du cockpit : elle n'est pas relevée
};

const TITLES = {
  base: 'Base de données / API santé',
  site: 'Page publique /fr/intelligence',
  fraicheur: 'Fraîcheur des données de marché',
  disque: 'Disque de la base',
  disque_lecture: 'Lecture du niveau du disque',
  relais: 'Contrôleur de vie du watchdog',
  principal: 'Surveillance principale (cockpit)',
  boite: 'Boîte d’alertes du cockpit',
};

const ACTIONS = {
  base: 'tableau de bord Supabase (projet restreint ? en pause ?), puis logs Vercel de /api/health.',
  site: 'ouvrir mulklick.ch/fr/intelligence ; relancer le cron snapshot-cards ou redéployer.',
  fraicheur: 'vérifier que le scraper (lun/mar/jeu/ven 03:00) a tourné : logs du backend et crédit du fournisseur de scraping.',
  disque: 'libérer de la place dans la base (rétention des archives de scraping) ou agrandir le disque avant la restriction.',
  disque_lecture: 'vérifier /api/health (champs disk_level, disk_pct) et le dernier déploiement du site.',
  relais: 'vérifier le compte du contrôleur de vie ; le watchdog, lui, continue de surveiller.',
  principal: 'Railway → service admin-backend : vérifier le dernier déploiement et ses journaux ; en attendant, ce secours fait les contrôles quand il passe.',
  boite: 'onglet Actions de mulklick-watchdog (étape « Secours ») et déploiement du cockpit sur Railway.',
};

const ICON = { urgent: '🔴', important: '🟠' };
const LEVEL = { urgent: 'URGENT', important: 'IMPORTANT' };

// ───────────────────────────── utilitaires ─────────────────────────────

export const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs = CONFIG.requestTimeoutMs) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

/** « JJ.MM HH:MM UTC ». */
function fmtUtc(nowMs) {
  const d = new Date(nowMs).toISOString();
  return `${d.slice(8, 10)}.${d.slice(5, 7)} ${d.slice(11, 16)} UTC`;
}

function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / MIN));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return min % 60 ? `${h} h ${String(min % 60).padStart(2, '0')}` : `${h} h`;
  return `${Math.round(h / 24)} j`;
}

function errText(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'délai dépassé';
  return 'erreur réseau';
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let n = 0;
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    n += 1;
    i = haystack.indexOf(needle, i + needle.length);
  }
  return n;
}

// ───────────────────────────── contrôles ─────────────────────────────

/** A — /api/health, 3 essais espacés de 20 s. Rend aussi le JSON pour les contrôles C et D. */
export async function checkHealth({ fetchImpl, sleep, cfg = CONFIG }) {
  const url = `${cfg.siteBase}${cfg.healthPath}?wd=${Date.now()}`;
  let last = '';
  for (let attempt = 1; attempt <= cfg.healthAttempts; attempt += 1) {
    try {
      const res = await fetchWithTimeout(fetchImpl, url, { headers: { 'cache-control': 'no-cache' } });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (res.status === 200 && body && body.db_ok === true) {
        return {
          id: 'A',
          status: 'ok',
          value: `HTTP 200, db_ok=true, ${body.response_ms ?? '?'} ms`,
          health: body,
        };
      }
      last = `HTTP ${res.status}, db_ok=${body && 'db_ok' in body ? String(body.db_ok) : 'absent'}`;
    } catch (e) {
      last = errText(e);
    }
    if (attempt < cfg.healthAttempts) await sleep(cfg.retryDelayMs);
  }
  return { id: 'A', status: 'crit', value: `${last} (${cfg.healthAttempts} essais à ${cfg.retryDelayMs / 1000} s)` };
}

/** B — la page publique affiche-t-elle les données ? Paramètre anti-cache à chaque appel. */
export async function checkPage({ fetchImpl, sleep, cfg = CONFIG }) {
  let last = '';
  for (let attempt = 1; attempt <= cfg.healthAttempts; attempt += 1) {
    const url = `${cfg.siteBase}${cfg.pagePath}?wd=${Date.now()}`;
    try {
      const res = await fetchWithTimeout(fetchImpl, url, { headers: { 'cache-control': 'no-cache' } });
      if (res.status !== 200) {
        last = `HTTP ${res.status}`;
      } else {
        const html = await res.text();
        let absent;
        let present;
        let counts;
        if (countOccurrences(html, cfg.markerCardState) > 0) {
          // Nouveau format : un seul marqueur par carte, pas de double comptage avec data-spark.
          const clear = countOccurrences(html, cfg.markerCardValue);
          const hidden = countOccurrences(html, cfg.markerCardReserved);
          absent = countOccurrences(html, cfg.markerCardEmpty);
          present = clear + hidden;
          counts = `${present}/${cfg.expectedCards} cartes avec donnée (${clear} en clair, ${hidden} masquées), ${absent} vides`;
        } else {
          absent = countOccurrences(html, cfg.markerAbsent);
          present = countOccurrences(html, cfg.markerPresent);
          counts = `${present}/${cfg.expectedCards} cartes chiffrées, ${absent} « ${cfg.markerAbsent} »`;
        }
        // Les marqueurs dépendent du contenu, pas du réseau : inutile de réessayer.
        if (present === 0 && absent > 0) return { id: 'B', status: 'crit', value: `données absentes : ${counts}` };
        if (present === 0 && html.length < cfg.minPageBytes) {
          return { id: 'B', status: 'crit', value: `page vide ou page d'erreur (${html.length} octets, aucun marqueur)` };
        }
        if (present === 0) return { id: 'B', status: 'warn', value: `marqueurs introuvables (page modifiée ?) : ${counts}` };
        if (absent > 0) return { id: 'B', status: 'warn', value: `données partielles : ${counts}` };
        return { id: 'B', status: 'ok', value: counts };
      }
    } catch (e) {
      last = errText(e);
    }
    if (attempt < cfg.healthAttempts) await sleep(cfg.retryDelayMs);
  }
  return { id: 'B', status: 'crit', value: `page injoignable : ${last} (${cfg.healthAttempts} essais)` };
}

/** C — fraîcheur, à partir du JSON du contrôle A. Sauté si A n'a rien rendu. */
export function checkFreshness(healthResult, cfg = CONFIG) {
  const h = healthResult?.health;
  if (!h) return { id: 'C', status: 'skip', value: 'non mesurable (contrôle A en échec)' };
  if (!h.latest_capture || typeof h.age_hours !== 'number') {
    return { id: 'C', status: 'warn', value: 'aucune date de capture rendue par /api/health' };
  }
  const value = `dernière capture ${h.latest_capture}, âge ${Math.round(h.age_hours)} h (seuil ${cfg.freshnessMaxHours} h)`;
  return { id: 'C', status: h.age_hours > cfg.freshnessMaxHours ? 'warn' : 'ok', value, capture: h.latest_capture };
}

/** D — niveau du disque, à partir du JSON du contrôle A (calculé côté site). Aucun appel réseau, aucune clé. */
export function checkDisk(healthResult) {
  const h = healthResult?.health;
  if (!h) return { id: 'D', status: 'skip', value: 'non mesurable (contrôle A en échec)' };
  const level = h.disk_level;
  if (level === undefined || level === null) {
    return { id: 'D', status: 'warn', value: 'niveau disque absent de /api/health' };
  }
  const value = `≈ ${h.disk_pct} % de 18 GB (taille de la base, hors journaux Postgres ; seuils 65 / 80 %)`;
  const pct = h.disk_pct;
  if (level === 'ok') return { id: 'D', status: 'ok', value, level, pct };
  if (level === 'avertissement') return { id: 'D', status: 'warn', value, level, pct };
  if (level === 'critique') return { id: 'D', status: 'crit', value, level, pct };
  return { id: 'D', status: 'warn', value: `niveau disque inconnu : ${level}` };
}

// ───────────────────────────── état ─────────────────────────────

function freshState() {
  return {
    version: 2,
    incidents: {},
    pending: {},
    pendingGap: null,
    lastRunAt: null,
    diskSteps: {},
    heartbeatFails: 0,
  };
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Normalise l'état relu. Un état valide est complété champ par champ ; un état illisible (ancienne
 * version, fichier tronqué) repart de zéro sans rien envoyer. Les anciens champs (résumé, plafond de
 * sons, clôtures récentes) et les incidents de causes supprimées sont écartés sans message.
 */
export function normalizeState(prev) {
  if (prev === null || prev === undefined) return freshState();
  if (!isObj(prev) || prev.version !== 2) return freshState();
  const s = structuredClone(prev);
  for (const k of ['incidents', 'pending', 'diskSteps']) if (!isObj(s[k])) s[k] = {};
  for (const k of ['period', 'sound', 'closed', 'lastWeeklyKey']) delete s[k];
  for (const k of ['incidents', 'pending']) for (const key of Object.keys(s[k])) if (!TITLES[key]) delete s[k][key];
  if (typeof s.lastRunAt !== 'number') s.lastRunAt = null;
  if (typeof s.heartbeatFails !== 'number') s.heartbeatFails = 0;
  if (!isObj(s.pendingGap)) s.pendingGap = null;
  return s;
}

/** Paliers de disque : instant où chaque palier de 5 % a été franchi EN OBSERVATION (entered=true). */
export function updateDiskSteps(steps, pct, nowMs) {
  if (typeof pct !== 'number') return steps;
  const keys = Object.keys(steps).map(Number);
  const max = keys.length ? Math.max(...keys) : null;
  if (max !== null && pct <= max - 10) steps = {}; // vrai nettoyage : on repart de zéro
  const keys2 = Object.keys(steps).map(Number);
  const max2 = keys2.length ? Math.max(...keys2) : null;
  if (max2 === null) return { [pct]: { t: nowMs, entered: false } }; // palier de départ : date d'entrée inconnue
  if (pct > max2) return { ...steps, [pct]: { t: nowMs, entered: true } };
  return steps;
}

/**
 * Jours avant 95 % au rythme des deux derniers paliers franchis en observation, ou null. Prudent :
 * on suppose la valeur réelle en haut de son palier (arrondi à 5 % inférieur côté site). Un palier
 * franchi en moins de 12 h (à-coup d'une nuit de scraping) ne sert pas de rythme.
 */
export function projectDiskDays(steps, pct, cfg = CONFIG) {
  const b2 = steps[pct];
  const b1 = steps[pct - 5];
  if (!b1 || !b2 || !b1.entered || !b2.entered) return null;
  const dt = b2.t - b1.t;
  if (dt < cfg.diskMinStepMs) return null;
  const remaining = cfg.diskReadOnlyPct - (pct + 5);
  return Math.max(0, (remaining / 5) * dt) / DAY;
}

// ───────────────────────────── incidents (regroupés par cause) ─────────────────────────────

/**
 * Traduit les résultats des contrôles en incidents, UN par cause. Rend aussi les causes non
 * mesurables à ce passage (leur incident éventuel reste tel quel : ni aggravé, ni clos).
 */
export function deriveIncidents(results, state, nowMs, cfg = CONFIG) {
  const by = Object.fromEntries(results.map((r) => [r.id, r]));
  const a = by.A;
  const b = by.B;
  const c = by.C;
  const d = by.D;
  const out = [];
  const unmeasured = new Set();
  const baseOpen = Boolean(state.incidents.base);

  // Mode secours : la surveillance principale (cockpit) ne donne plus signe de vie.
  const p = by.P;
  if (p && p.status !== 'ok') {
    out.push({
      // La surveillance est en panne, pas le site : IMPORTANT sans son. Si mulklick.ch est réellement
      // en panne, les contrôles A/B de ce secours donnent eux-mêmes l'URGENT.
      key: 'principal', level: 'important', panne: false, symptom: p.value,
      what: `La surveillance principale (cockpit) ne tourne plus : ${p.value}.`,
      gravity: 'plus aucun contrôle toutes les 5 min ; ce secours GitHub ne passe que de temps en temps.',
    });
  }
  // Cockpit vivant seulement : sa boîte d'alertes. Cockpit mort : on ne sait rien d'elle, son incident
  // reste tel quel (le message « cockpit arrêté » suffit, pas de doublon). L'échec du bot direct du
  // cockpit (T) n'est plus un message : seulement une ligne de journal sans texte sensible.
  const k = by.K;
  if (!p || p.status !== 'ok' || !k || k.status === 'skip') unmeasured.add('boite');
  else if (k.status === 'crit') {
    out.push({
      key: 'boite', level: 'important', panne: false, confirm: true, symptom: k.value,
      what: `Les alertes du cockpit ne te parviennent plus (${k.value}).`,
      gravity: k.fallback
        ? 'en attendant, le relais refait lui-même les contrôles du site.'
        : 'le relais ne les relève pas ; les contrôles du site restent faits par le cockpit.',
    });
  }
  if (!a) {
    // Mode secours, cockpit vivant : les contrôles du site sont faits par le cockpit, pas ici.
    for (const k of ['base', 'site', 'fraicheur', 'disque', 'disque_lecture']) unmeasured.add(k);
    return { incidents: out, unmeasured };
  }

  if (a.status === 'crit') {
    // Une seule cause : la page vide est un symptôme de la base injoignable.
    const page = b.status !== 'ok' ? ` ; page publique : ${b.value}` : '';
    out.push({
      key: 'base', level: 'urgent', panne: true, symptom: a.value,
      what: `Base de données ou /api/health injoignable (${a.value})${page}.`,
      gravity: 'panne en cours, les visiteurs peuvent voir des pages sans données.',
    });
    unmeasured.add('site');
  } else if (b.status !== 'ok' && baseOpen) {
    // Même incident : la base répond de nouveau, la page n'est pas encore rafraîchie (cache ≤ 1 h).
    out.push({
      key: 'base', level: 'urgent', panne: true, symptom: b.value,
      what: `La base répond de nouveau, mais la page publique reste sans données (${b.value}).`,
      gravity: 'même incident, cache du site pas encore rafraîchi (jusqu’à 1 h).',
    });
    unmeasured.add('site');
  } else if (b.status === 'crit') {
    out.push({
      key: 'site', level: 'urgent', panne: true, symptom: b.value,
      what: `Page publique sans données alors que la base répond (${b.value}).`,
      gravity: 'données absentes de mulklick.ch.',
    });
  } else if (b.status === 'warn') {
    out.push({
      key: 'site', level: 'important', panne: false, confirm: true, symptom: b.value,
      what: `Page publique incomplète (${b.value}).`,
      gravity: 'anomalie confirmée, une partie des chiffres manque.',
    });
  }

  if (c.status === 'skip') unmeasured.add('fraicheur');
  else if (c.status === 'warn') {
    out.push({
      key: 'fraicheur', level: 'important', panne: false, confirm: true, symptom: c.value,
      what: `Données de marché trop anciennes (${c.value}).`,
      gravity: 'anomalie confirmée, le site affiche des chiffres datés.',
    });
  }

  if (d.status === 'skip') {
    unmeasured.add('disque');
    unmeasured.add('disque_lecture');
  } else if (!d.level) {
    // Lecture impossible : cause distincte ; l'incident « disque » éventuel reste tel quel.
    unmeasured.add('disque');
    out.push({
      key: 'disque_lecture', level: 'important', panne: false, confirm: true, symptom: d.value,
      what: `Niveau du disque illisible (${d.value}).`,
      gravity: 'anomalie confirmée, le disque n’est plus surveillé.',
    });
  } else {
    const pct = d.pct;
    const days = projectDiskDays(state.diskSteps, pct, cfg);
    let level = null;
    // URGENT seulement quand la base est réellement en lecture seule (95 %). Avant : un risque, même
    // « sous 48 h » → IMPORTANT sans son.
    if (pct >= cfg.diskReadOnlyPct) level = 'urgent';
    else if (d.level === 'critique' || d.level === 'avertissement' || (days !== null && days < cfg.diskImportantDays)) level = 'important';
    const open = state.incidents.disque;
    // Hystérésis : un incident ouvert reste ouvert tant qu'on n'est pas 5 points sous le seuil de 65 %.
    if (!level && open && pct >= cfg.diskWarnPct - cfg.diskHysteresisPct) level = 'important';
    if (level) {
      const proj = days !== null ? `, plein (95 %) dans ≈ ${Math.max(0, Math.round(days))} j au rythme actuel` : '';
      out.push({
        key: 'disque', level, panne: level === 'urgent', pct, symptom: `disque ≈ ${pct} % de 18 GB${proj}`,
        what: `Disque de la base ≈ ${pct} % de 18 GB${proj}.`,
        gravity:
          level === 'urgent'
            ? 'la base est en lecture seule (95 %) : le site perd ses données.'
            : days !== null && days < cfg.diskUrgentDays
              ? 'risque sous 48 h : à 95 %, Supabase bloque la base et le site perd ses données.'
              : 'risque à venir : à 95 %, Supabase bloque la base et le site perd ses données.',
      });
    }
  }

  if (state.heartbeatFails >= cfg.heartbeatFailRuns) {
    out.push({
      key: 'relais', level: 'important', panne: false, symptom: `${state.heartbeatFails} signaux de vie refusés`,
      what: `Le contrôleur de vie du watchdog ne répond plus (${state.heartbeatFails} signaux de vie refusés).`,
      gravity: 'si le watchdog s’arrêtait maintenant, personne ne le saurait.',
    });
  }
  return { incidents: out, unmeasured };
}

// ───────────────────────────── messages (3 lignes au plus) ─────────────────────────────

function incidentText(inc, since) {
  const head = `${ICON[inc.level]} ${LEVEL[inc.level]} — ${inc.what}`;
  return [head, `Gravité : ${inc.gravity} Depuis ${fmtUtc(since)}.`, `Action : ${ACTIONS[inc.key]}`].join('\n');
}

/** Message de fin : durée, début → fin, cause = dernier symptôme mesuré (jamais une supposition). */
function closeText(key, okSince, openedAt, symptom) {
  const cause = typeof symptom === 'string' && symptom ? symptom.replace(/[.\s]+$/, '') : 'non identifiée par la surveillance';
  return [
    `🟢 RÉSOLU — ${TITLES[key]} : ${fmtDuration(okSince - openedAt)} (${fmtUtc(openedAt).replace(' UTC', '')} → ${fmtUtc(okSince)}).`,
    `Cause : ${cause}.`,
  ].join('\n');
}

function gapText(fromMs, toMs) {
  return [
    `🟠 IMPORTANT — Le watchdog n’a pas tourné pendant ${fmtDuration(toMs - fromMs)} (du ${fmtUtc(fromMs)} au ${fmtUtc(toMs)}).`,
    'Gravité : rien n’a été surveillé pendant ce temps ; il tourne de nouveau.',
    'Action : vérifier l’historique de cron-job.org et l’onglet Actions de mulklick-watchdog.',
  ].join('\n');
}

// ───────────────────────────── plan d'un passage ─────────────────────────────

/**
 * Décide ce qu'un passage envoie. Rend { state, messages } : `state` contient déjà tout ce qui ne
 * dépend pas d'un envoi (compteurs, paliers, confirmations, retours à la normale) ; chaque message
 * porte un `commit` qui n'est appliqué à l'état que si CE message est bien parti.
 * Message : { text, sound, panne, key, commit(state) }.
 */
export function planRun(prevState, results, nowMs, env = {}, cfg = CONFIG) {
  const s = normalizeState(prevState);
  const msgs = [];
  const by = Object.fromEntries(results.map((r) => [r.id, r]));

  // En mode secours, pas de message « n'a pas tourné » (ce workflow passe rarement, c'est attendu).
  const secours = Boolean(env.PRINCIPAL_HEALTH_URL);

  // 1) Preuve de vie : le watchdog s'est-il arrêté ? (une alerte non partie est gardée et renvoyée)
  if (!secours && s.lastRunAt !== null) {
    const gap = nowMs - s.lastRunAt;
    if (gap > cfg.gapImportantMs && !s.pendingGap) s.pendingGap = { from: s.lastRunAt, to: nowMs };
  }
  if (s.pendingGap) {
    const g = s.pendingGap;
    msgs.push({
      text: gapText(g.from, g.to), sound: false, panne: false, key: 'gap',
      commit: (st) => { st.pendingGap = null; },
    });
  }
  s.lastRunAt = nowMs;

  // 2) Projection du disque.
  if (by.D && typeof by.D.pct === 'number') s.diskSteps = updateDiskSteps(s.diskSteps, by.D.pct, nowMs);

  // 3) Incidents : UN message d'ouverture, jamais de rappel. Seule exception : un risque IMPORTANT
  // devenu une vraie panne donne UN message URGENT. Une baisse de niveau ne dit rien.
  const { incidents, unmeasured } = deriveIncidents(results, s, nowMs, cfg);
  const current = new Set(incidents.map((i) => i.key));

  for (const inc of incidents) {
    const prev = s.incidents[inc.key];
    if (!prev) {
      // Nouveau constat : compté dans l'état de base, pour qu'un envoi raté ne remette pas la
      // confirmation à zéro ; le message part dès que le seuil de confirmation est atteint.
      const pend = s.pending[inc.key] ?? { seen: 0, first: nowMs };
      pend.seen += 1;
      s.pending[inc.key] = pend;
      if (pend.seen < (inc.confirm ? cfg.confirmRuns : 1)) continue;
      const record = {
        level: inc.level, panne: inc.panne, openedAt: pend.first, notifiedAt: nowMs, okSince: null,
        symptom: inc.symptom ?? null, pct: inc.pct,
      };
      msgs.push({
        text: incidentText(inc, pend.first), sound: inc.level === 'urgent', panne: inc.panne, key: inc.key,
        commit: (st) => {
          st.incidents[inc.key] = { ...record };
          delete st.pending[inc.key];
        },
      });
      continue;
    }
    prev.okSince = null;
    prev.panne = inc.panne;
    if (inc.pct !== undefined) prev.pct = inc.pct;
    if (inc.symptom) prev.symptom = inc.symptom; // dernier symptôme mesuré : la cause du message « résolu »
    if (inc.level === 'urgent' && prev.level !== 'urgent') {
      msgs.push({
        text: incidentText(inc, prev.openedAt), sound: true, panne: inc.panne, key: inc.key,
        commit: (st) => Object.assign(st.incidents[inc.key], { level: 'urgent', notifiedAt: nowMs }),
      });
    }
  }
  for (const key of Object.keys(s.pending)) if (!current.has(key) && !unmeasured.has(key)) delete s.pending[key];

  // 4) Fin : UN message RÉSOLU (sans son) après un retour à la normale continu d'1 h (pas de yo-yo).
  for (const [key, prev] of Object.entries(s.incidents)) {
    if (current.has(key) || unmeasured.has(key)) continue;
    if (prev.okSince === null || prev.okSince === undefined) prev.okSince = nowMs;
    if (nowMs - prev.okSince >= cfg.resolveAfterOkMs) {
      const { okSince, openedAt, symptom } = prev;
      msgs.push({
        text: closeText(key, okSince, openedAt, symptom), sound: false, panne: false, key,
        commit: (st) => { delete st.incidents[key]; },
      });
    }
  }

  // Ordre d'envoi : sonores d'abord.
  msgs.sort((x, y) => Number(y.sound) - Number(x.sound));
  return { state: s, messages: msgs };
}

// ───────────────────────────── Telegram ─────────────────────────────

export async function sendTelegram({ fetchImpl, token, chatId, text, silent = false }) {
  if (!token || !chatId) throw new Error('Telegram : TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID absent');
  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, `https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true, disable_notification: silent }),
    });
  } catch (e) {
    // Jamais l'URL (elle contient le jeton) : seulement la nature de l'erreur.
    throw new Error(`Telegram : ${errText(e)}`);
  }
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  if (res.status !== 200 || !body || body.ok !== true) {
    const desc = body && typeof body.description === 'string' ? body.description.slice(0, 200) : 'réponse illisible';
    throw new Error(`Telegram : HTTP ${res.status} — ${desc}`);
  }
}

/** Signal de vie vers le contrôleur externe ; « /fail » si ce passage n'a pas pu envoyer ses alertes. */
async function pingHeartbeat(fetchImpl, url, ok) {
  try {
    const res = await fetchWithTimeout(fetchImpl, ok ? url : `${url.replace(/\/$/, '')}/fail`, {}, 10_000);
    return res.status >= 200 && res.status < 300;
  } catch {
    return false;
  }
}

// ───────────────────────────── orchestration ─────────────────────────────

export async function runChecks({ fetchImpl, sleep, cfg = CONFIG }) {
  const [a, b] = await Promise.all([
    checkHealth({ fetchImpl, sleep, cfg }),
    checkPage({ fetchImpl, sleep, cfg }),
  ]);
  const c = checkFreshness(a, cfg);
  const d = checkDisk(a);
  return [a, b, c, d];
}

/**
 * Un passage complet. Rend { exitCode, results, sent: [{ text, silent }], stateToWrite }.
 * Chaque message n'avance l'état que s'il est parti ; au premier échec, on s'arrête (job en échec).
 */
/** Mode secours : lit le signe de vie publié par la surveillance principale (route publique /health du cockpit). */
// Chaque passage du secours se signale au cockpit (?secours=1) : le cockpit sait ainsi que le
// secours tourne, et prévient Yasir s'il ne passe plus. Lecture seule, rien d'autre.
export function urlSecours(base) {
  try {
    const u = new URL(base);
    u.searchParams.set('secours', '1');
    return u.toString();
  } catch {
    return base;
  }
}

export async function checkPrincipal({ fetchImpl, env, nowMs, cfg = CONFIG }) {
  try {
    const res = await fetchWithTimeout(fetchImpl, urlSecours(env.PRINCIPAL_HEALTH_URL), { headers: { 'cache-control': 'no-cache' } });
    let body = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    const s = body && body.surveillance_site;
    if (res.status !== 200) return { id: 'P', status: 'crit', value: `cockpit : HTTP ${res.status}` };
    if (!s) return { id: 'P', status: 'crit', value: 'cockpit joignable, mais sans signe de vie de la surveillance' };
    if (!s.actif) return { id: 'P', status: 'crit', value: 'surveillance désactivée dans le cockpit' };
    const t = Date.parse(s.dernier_passage);
    if (!Number.isFinite(t)) return { id: 'P', status: 'crit', value: 'aucun passage récent' };
    const age = nowMs - t;
    if (age > cfg.principalStaleMs) return { id: 'P', status: 'crit', value: `dernier passage il y a ${fmtDuration(age)} (${fmtUtc(t)})` };
    return { id: 'P', status: 'ok', value: `dernier passage ${fmtUtc(t)}`, health: body };
  } catch (e) {
    return { id: 'P', status: 'crit', value: `cockpit injoignable (${errText(e)})` };
  }
}

// ───────────────────────────── boîte d'alertes du cockpit ─────────────────────────────

/**
 * Envoi direct du cockpit en échec ? Plus aucun message pour ça (hors règle Telegram du 23.11) : seulement
 * une ligne de journal, sans description d'erreur, sans identifiant ni texte.
 */
export function checkTelegramCockpit(principal) {
  const d = principal?.health?.telegram?.direct;
  if (!d || typeof d !== 'object') return { id: 'T', status: 'skip', value: 'envoi direct du cockpit : non publié' };
  const echec = Date.parse(d.dernier_echec);
  const ok = Date.parse(d.dernier_ok);
  if (!Number.isFinite(echec) || (Number.isFinite(ok) && ok >= echec)) {
    return { id: 'T', status: 'ok', value: 'envoi direct du cockpit : sans échec en cours' };
  }
  return { id: 'T', status: 'warn', value: 'envoi direct du cockpit : échec en cours (journal seulement, aucun message)' };
}

const boiteErreur = (value) => ({ id: 'K', status: 'crit', value, kind: 'erreur', delivered: 0, failed: false });

/**
 * Relève la boîte du cockpit : jeton OIDC → GET → livraison par ce bot → acquittement.
 * Rend { id: 'K', status, kind: 'lu' | 'absent' | 'erreur' | 'skip', value, delivered, failed }.
 * Ne journalise jamais un texte d'alerte, un jeton, un corps de réponse ni un identifiant.
 */
export async function releverBoite({ fetchImpl, env, log = console.log, cfg = CONFIG }) {
  const tokenUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const tokenAuth = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!env.PRINCIPAL_HEALTH_URL || !tokenUrl || !tokenAuth) {
    return { id: 'K', status: 'skip', kind: 'skip', value: 'pas de jeton OIDC ou de cockpit : boîte non relevée', delivered: 0, failed: false };
  }
  let origin;
  let reqUrl;
  try {
    origin = new URL(env.PRINCIPAL_HEALTH_URL).origin;
    reqUrl = new URL(tokenUrl);
    reqUrl.searchParams.set('audience', cfg.boiteAudience);
  } catch {
    return boiteErreur('adresse illisible');
  }
  const jsonOf = async (res) => {
    try {
      return await res.json();
    } catch {
      return null;
    }
  };

  // 1) Jeton OIDC (signé par GitHub, de courte durée, jamais journalisé).
  let jwt;
  try {
    const res = await fetchWithTimeout(fetchImpl, reqUrl.toString(), { headers: { Authorization: `bearer ${tokenAuth}` } });
    const body = res.status === 200 ? await jsonOf(res) : null;
    if (!body || typeof body.value !== 'string' || !body.value) return boiteErreur(`jeton OIDC non fourni (HTTP ${res.status})`);
    jwt = body.value;
  } catch (e) {
    return boiteErreur(`jeton OIDC non fourni (${errText(e)})`);
  }
  const headers = { Authorization: `Bearer ${jwt}` };

  // 2) Relève.
  let data;
  try {
    const res = await fetchWithTimeout(fetchImpl, `${origin}${cfg.boitePath}`, { headers: { ...headers, 'cache-control': 'no-cache' } });
    if (res.status === 404) {
      return { id: 'K', status: 'ok', kind: 'absent', value: 'boîte absente du cockpit (HTTP 404) : fonction pas encore déployée', delivered: 0, failed: false };
    }
    if (res.status !== 200) return boiteErreur(`relève refusée ou en erreur (HTTP ${res.status})`);
    data = await jsonOf(res);
  } catch (e) {
    return boiteErreur(`cockpit injoignable (${errText(e)})`);
  }
  if (!data || typeof data.boot !== 'string' || !Array.isArray(data.messages)) return boiteErreur('réponse de la boîte illisible');

  // 3) Livraison : plus ancien d'abord, son selon `sonner`, au plus N par passage, arrêt au premier échec.
  const valides = data.messages
    .filter((m) => m && Number.isInteger(m.id) && typeof m.texte === 'string' && m.texte.length > 0)
    .sort((x, y) => x.id - y.id)
    .slice(0, cfg.boiteMaxParPassage);
  const livres = [];
  let failed = false;
  for (const m of valides) {
    try {
      await sendTelegram({ fetchImpl, token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, text: m.texte, silent: m.sonner !== true });
    } catch (e) {
      log(`ÉCHEC de l'envoi Telegram (boîte) : ${e.message}`);
      failed = true;
      break;
    }
    livres.push(m.id);
  }

  // 4) Acquittement des seuls messages partis.
  let acquittes = 0;
  let ackOk = true;
  if (livres.length) {
    try {
      const res = await fetchWithTimeout(fetchImpl, `${origin}${cfg.boiteAcquitterPath}`, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ boot: data.boot, ids: livres }),
      });
      if (res.status === 200) {
        const b = await jsonOf(res);
        acquittes = b && Number.isInteger(b.acquittes) ? b.acquittes : livres.length;
      } else {
        ackOk = false;
      }
    } catch {
      ackOk = false;
    }
  }
  log(`Boîte : ${data.messages.length} relevé(s), ${livres.length} livré(s), ${acquittes} acquitté(s)${ackOk ? '' : ' (acquittement refusé)'}`);
  if (!ackOk) return { ...boiteErreur('acquittement refusé : les messages seront relivrés'), delivered: livres.length, failed };
  return { id: 'K', status: 'ok', kind: 'lu', value: `${data.messages.length} relevé(s), ${livres.length} livré(s), ${acquittes} acquitté(s)`, delivered: livres.length, failed };
}

/** Boîte non relevée ce passage, alors que /health dit que son plus ancien message attend depuis trop longtemps. */
export function checkAncienneteBoite(box, principal, nowMs, cfg = CONFIG) {
  if (box.kind === 'lu' || box.kind === 'erreur' || box.kind === 'absent') return box;
  const t = Date.parse(principal?.health?.telegram?.boite?.plus_ancien);
  if (Number.isFinite(t) && nowMs - t > cfg.boiteAncienneteMs) {
    return { ...box, status: 'crit', kind: 'ancien', value: `un message attend dans la boîte depuis plus de ${Math.round(cfg.boiteAncienneteMs / MIN)} min` };
  }
  return box;
}

const CLES_DU_SITE = ['base', 'site', 'fraicheur', 'disque', 'disque_lecture'];

export async function runOnce({ fetchImpl, sleep = realSleep, env, prevState, nowMs = Date.now(), log = console.log, cfg = CONFIG }) {
  let results;
  let failed = false;
  let boiteLivres = 0;
  if (env.PRINCIPAL_HEALTH_URL) {
    const p = await checkPrincipal({ fetchImpl, env, nowMs, cfg });
    if (p.status === 'ok') {
      // Cockpit vivant : relever sa boîte d'alertes (livraison par ce bot), puis lire ses diagnostics.
      const box = await releverBoite({ fetchImpl, env, log, cfg });
      boiteLivres = box.delivered;
      if (box.failed) failed = true;
      const k = checkAncienneteBoite(box, p, nowMs, cfg);
      // Boîte non relevable (404, 401, 5xx, réseau, JSON) : le relais refait LUI-MÊME les contrôles A à D.
      // Dans GitHub Actions sans jeton OIDC (permission id-token absente, lancement manuel par
      // watchdog.yml) : la boîte ne peut pas être relevée, donc repli aussi — jamais le silence.
      const sansJetonSurGitHub = box.kind === 'skip' && String(env.GITHUB_ACTIONS).toLowerCase() === 'true';
      const repli = box.kind === 'erreur' || box.kind === 'absent' || sansJetonSurGitHub;
      if (k.status === 'crit') k.fallback = repli;
      results = [p, checkTelegramCockpit(p), k];
      if (repli) {
        results.push(...(await runChecks({ fetchImpl, sleep, cfg })));
      } else if (prevState && prevState.version === 2) {
        // Le cockpit fait les contrôles du site. Le secours se tait et lui passe la main
        // (ses propres incidents du site sont oubliés sans message : le cockpit a les siens).
        prevState = structuredClone(prevState);
        for (const key of CLES_DU_SITE) {
          if (prevState.incidents) delete prevState.incidents[key];
          if (prevState.pending) delete prevState.pending[key];
        }
      }
    } else {
      results = [p, ...(await runChecks({ fetchImpl, sleep, cfg }))];
    }
  } else {
    results = await runChecks({ fetchImpl, sleep, cfg });
  }
  for (const r of results) log(`[${r.id}] ${r.status.toUpperCase()} — ${r.value}`);

  const { state, messages } = planRun(prevState, results, nowMs, env, cfg);

  const sent = [];
  for (const m of messages) {
    try {
      await sendTelegram({ fetchImpl, token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, text: m.text, silent: !m.sound });
    } catch (e) {
      log(`ÉCHEC de l'envoi Telegram : ${e.message}`);
      failed = true;
      break;
    }
    m.commit(state);
    sent.push({ text: m.text, silent: !m.sound });
  }
  log(messages.length ? `Telegram : ${sent.length}/${messages.length} message(s) envoyé(s).` : 'Aucun message à envoyer.');

  if (env.HEARTBEAT_URL) {
    const ok = await pingHeartbeat(fetchImpl, env.HEARTBEAT_URL, !failed);
    state.heartbeatFails = ok ? 0 : (state.heartbeatFails ?? 0) + 1;
    log(`Contrôleur de vie : ${ok ? 'signal reçu' : 'signal refusé'}.`);
  }
  return { exitCode: failed ? 1 : 0, results, sent, boiteLivres, stateToWrite: state };
}

async function readState(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    return null; // premier passage, ou cache vide
  }
}

async function main() {
  const env = process.env;
  const file = env.WATCHDOG_STATE_FILE || '.watchdog-state/state.json';
  const prevState = await readState(file);
  console.log(prevState ? `État précédent relu (${file}).` : 'Aucun état précédent : premier passage.');
  const out = await runOnce({ fetchImpl: fetch, env, prevState });
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(out.stateToWrite, null, 2));
  process.exitCode = out.exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(`Watchdog en erreur : ${e && e.message ? e.message : 'inconnue'}`);
    process.exitCode = 1;
  });
}
