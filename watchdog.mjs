// Watchdog Mulklick — tourne sur GitHub Actions (.github/workflows/watchdog.yml), indépendamment de
// la base et de l'hébergement du site. Lecture seule : il ne fait que des GET publics et envoie les
// alertes sur Telegram. Aucune clé d'API n'est nécessaire.
// DÉPÔT PUBLIC : aucun secret ni identifiant interne dans ce code, tout passe par les secrets GitHub.
//
// Quatre contrôles :
//   A — panne      : GET /api/health → 200 et db_ok=true, 3 essais espacés de 20 s.
//   B — page       : GET /fr/intelligence → les 8 cartes nationales AFFICHENT une valeur. Deux formats lus :
//                    NOUVEAU (data-card-state="value|reserved|empty" ; site ouvert depuis le 21.11.2026 :
//                    seule « value » compte, une carte masquée ou vide donne un avertissement) ou ANCIEN
//                    (courbes data-spark / « Aucune valeur actuelle »). Le watchdog reste anonyme : aucune
//                    session, aucun cookie, aucune clé.
//   C — fraîcheur  : age_hours (rendu par /api/health) ≤ seuil.
//   D — disque     : disk_level / disk_pct (rendus par /api/health), avec projection du remplissage.
//
// RÈGLES DE COMMUNICATION (Yasir, 20.11.2026 — prioritaires sur toute autre consigne de message) :
//   - Aucun message quand tout va bien. Pas de message quotidien.
//   - URGENT (panne, données absentes, risque sous 48 h) : message AVEC son, immédiat.
//     IMPORTANT (risque prévu sous 30 jours, anomalie confirmée) : message SILENCIEUX, une seule fois.
//     INFORMATION : uniquement dans le résumé hebdomadaire silencieux du lundi (08:00 heure suisse).
//   - Regroupement : les symptômes d'une même cause donnent UN message (ex. base injoignable + page vide).
//   - Pas de répétition : un problème signalé ne redonne un message que s'il s'aggrave ou change de
//     niveau (ou après une durée configurable, désactivée par défaut). Un problème qui revient peu
//     après sa résolution est une RÉCIDIVE : un seul message silencieux. La résolution donne un
//     message silencieux de clôture, une fois le retour à la normale confirmé (1 h, 6 h après récidive).
//   - Plafond : au plus 3 messages sonores par jour hors panne en cours ; au-delà, regroupés en un
//     message silencieux qui le dit (et redonnés avec son le lendemain s'ils durent).
//   - Format : trois lignes au plus — ce qui se passe, gravité, action recommandée. Le détail est
//     dans le journal du run (onglet Actions).
//   - Preuve de vie sans message : un arrêt du watchdog de plus de 2 h est signalé à la reprise ;
//     un contrôleur de vie externe facultatif (secret HEARTBEAT_URL, ex. healthchecks.io) reçoit un
//     signal à chaque passage et alerte, lui, si le watchdog se tait ; le watchdog alerte si ce
//     contrôleur ne répond plus.
//
// État (anti-spam, incidents, résumé) : relu depuis WATCHDOG_STATE_FILE (cache Actions). Un message
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
  // Format NOUVEAU : chaque carte porte data-card-state="value" (valeur affichée), "reserved" (donnée
  // présente mais masquée) ou "empty" (aucune donnée). Depuis le site ouvert, présent = value seul ;
  // reserved et empty donnent un avertissement. À merger APRÈS le site ouvert : avant, la page porte
  // encore 5 cartes « reserved » et ce contrôle le signalerait.
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
  recurrenceWindowMs: 6 * HOUR, // un problème revenu moins de 6 h après sa clôture = récidive
  recurrenceResolveAfterOkMs: 6 * HOUR, // après une récidive, clôture seulement après 6 h normales
  downgradeAfterRuns: 3, // un niveau ne baisse qu'après 3 passages plus bas de suite
  renotifyMs: { urgent: null, important: null }, // null = jamais : répétition seulement si ça s'aggrave
  soundCapPerDay: 3, // messages sonores par jour (heure suisse), hors panne en cours
  weeklyHourZurich: 8, // résumé du lundi, à partir de 08:00 heure suisse
  runEveryMs: 10 * MIN,
  gapInfoMs: 25 * MIN, // trou entre deux passages noté pour le résumé du lundi
  gapImportantMs: 2 * HOUR, // watchdog arrêté plus de 2 h : message IMPORTANT à la reprise

  // ── Disque ──
  diskWarnPct: 65, // seuil « avertissement » calculé côté site (/api/health)
  diskUrgentPct: 90, // à 95 %, Supabase passe la base en lecture seule
  diskReadOnlyPct: 95,
  diskUrgentDays: 2, // « risque sous 48 h »
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
};

const TITLES = {
  base: 'Base de données / API santé',
  site: 'Page publique /fr/intelligence',
  fraicheur: 'Fraîcheur des données de marché',
  disque: 'Disque de la base',
  disque_lecture: 'Lecture du niveau du disque',
  relais: 'Contrôleur de vie du watchdog',
  principal: 'Surveillance principale (cockpit)',
};

const ACTIONS = {
  base: 'tableau de bord Supabase (projet restreint ? en pause ?), puis logs Vercel de /api/health.',
  site: 'ouvrir mulklick.ch/fr/intelligence ; relancer le cron snapshot-cards ou redéployer.',
  fraicheur: 'vérifier que le scraper (lun/mar/jeu/ven 03:00) a tourné : logs du backend et crédit du fournisseur de scraping.',
  disque: 'libérer de la place dans la base (rétention des archives de scraping) ou agrandir le disque avant la restriction.',
  disque_lecture: 'vérifier /api/health (champs disk_level, disk_pct) et le dernier déploiement du site.',
  relais: 'vérifier le compte du contrôleur de vie ; le watchdog, lui, continue de surveiller.',
  principal: 'Railway → service admin-backend : vérifier le dernier déploiement et ses journaux ; en attendant, ce secours fait les contrôles quand il passe.',
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

/** Date (AAAA-MM-JJ), heure, jour de semaine (1 = lundi … 7 = dimanche) et libellé à l'heure suisse. */
export function zurichNow(nowMs) {
  const f = new Intl.DateTimeFormat('fr-CH', {
    timeZone: 'Europe/Zurich',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  });
  const p = Object.fromEntries(f.formatToParts(new Date(nowMs)).map((x) => [x.type, x.value]));
  const date = `${p.year}-${p.month}-${p.day}`;
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return {
    date,
    hour: Number(p.hour),
    weekday: wd === 0 ? 7 : wd,
    label: `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`,
    short: `${p.day}.${p.month}`,
  };
}

/** Clé de semaine : date suisse du lundi dont 08:00 est le dernier passé (début de la période en cours). */
export function weekKey(nowMs, cfg = CONFIG) {
  const z = zurichNow(nowMs);
  let back = z.weekday - 1;
  if (z.weekday === 1 && z.hour < cfg.weeklyHourZurich) back = 7;
  const d = new Date(`${z.date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
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
        let hidden = 0;
        let counts;
        if (countOccurrences(html, cfg.markerCardState) > 0) {
          // Nouveau format : un seul marqueur par carte, pas de double comptage avec data-spark.
          // SITE OUVERT (21.11.2026) : seule une carte « value » (valeur affichée) compte. Une carte
          // « reserved » est une donnée masquée aux visiteurs, ce qui ne doit plus arriver.
          present = countOccurrences(html, cfg.markerCardValue);
          hidden = countOccurrences(html, cfg.markerCardReserved);
          absent = countOccurrences(html, cfg.markerCardEmpty);
          counts = `${present}/${cfg.expectedCards} cartes en clair, ${hidden} masquées, ${absent} vides`;
        } else {
          absent = countOccurrences(html, cfg.markerAbsent);
          present = countOccurrences(html, cfg.markerPresent);
          counts = `${present}/${cfg.expectedCards} cartes chiffrées, ${absent} « ${cfg.markerAbsent} »`;
        }
        // Les marqueurs dépendent du contenu, pas du réseau : inutile de réessayer.
        if (present === 0 && absent > 0) return { id: 'B', status: 'crit', value: `données absentes : ${counts}` };
        if (present === 0 && hidden === 0 && html.length < cfg.minPageBytes) {
          return { id: 'B', status: 'crit', value: `page vide ou page d'erreur (${html.length} octets, aucun marqueur)` };
        }
        if (present === 0 && hidden === 0) {
          return { id: 'B', status: 'warn', value: `marqueurs introuvables (page modifiée ?) : ${counts}` };
        }
        if (absent > 0) return { id: 'B', status: 'warn', value: `données partielles : ${counts}` };
        if (hidden > 0) return { id: 'B', status: 'warn', value: `cartes masquées aux visiteurs (le site doit être ouvert) : ${counts}` };
        if (present < cfg.expectedCards) return { id: 'B', status: 'warn', value: `cartes manquantes : ${counts}` };
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

function newPeriod(nowMs) {
  return { since: nowMs, runs: 0, incidents: [], gaps: [], startPct: null, lastPct: null, capture: null, reset: false };
}

function freshState(nowMs, cfg) {
  return {
    version: 2,
    incidents: {},
    pending: {},
    closed: {},
    pendingGap: null,
    // La période commence un intervalle avant ce premier passage, qui y est compté : le résumé
    // compare ainsi des passages faits à des passages attendus sur la même base.
    period: newPeriod(nowMs - cfg.runEveryMs),
    lastWeeklyKey: weekKey(nowMs, cfg), // la semaine en cours commence maintenant : pas de résumé immédiat
    lastRunAt: null,
    diskSteps: {},
    sound: { day: null, count: 0 },
    heartbeatFails: 0,
  };
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

/**
 * Normalise l'état relu. Un état valide est complété champ par champ ; un état illisible (ancienne
 * version, fichier tronqué) repart de zéro sans rien envoyer, et le résumé du lundi le signale.
 */
export function normalizeState(prev, nowMs, cfg = CONFIG) {
  if (prev === null || prev === undefined) return freshState(nowMs, cfg);
  if (!isObj(prev) || prev.version !== 2) {
    const s = freshState(nowMs, cfg);
    s.period.reset = !(isObj(prev) && prev.version === 1); // la v1 est une migration connue, pas une perte
    return s;
  }
  const base = freshState(nowMs, cfg);
  const s = structuredClone(prev);
  for (const k of ['incidents', 'pending', 'closed', 'diskSteps']) if (!isObj(s[k])) s[k] = {};
  if (!isObj(s.period) || typeof s.period.since !== 'number') s.period = { ...base.period, reset: true };
  s.period = { ...newPeriod(s.period.since), ...s.period };
  for (const k of ['incidents', 'gaps']) if (!Array.isArray(s.period[k])) s.period[k] = [];
  if (!isObj(s.sound)) s.sound = { day: null, count: 0 };
  if (typeof s.lastWeeklyKey !== 'string') s.lastWeeklyKey = base.lastWeeklyKey;
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
      key: 'principal', level: 'urgent', panne: false, rank: 3,
      what: `La surveillance principale (cockpit) ne tourne plus : ${p.value}.`,
      gravity: 'plus aucun contrôle toutes les 5 min ; ce secours GitHub ne passe que de temps en temps.',
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
      key: 'base', level: 'urgent', panne: true, rank: 3,
      what: `Base de données ou /api/health injoignable (${a.value})${page}.`,
      gravity: 'panne en cours, les visiteurs peuvent voir des pages sans données.',
    });
    unmeasured.add('site');
  } else if (b.status !== 'ok' && baseOpen) {
    // Même incident : la base répond de nouveau, la page n'est pas encore rafraîchie (cache ≤ 1 h).
    out.push({
      key: 'base', level: 'urgent', panne: true, rank: 3,
      what: `La base répond de nouveau, mais la page publique reste sans données (${b.value}).`,
      gravity: 'même incident, cache du site pas encore rafraîchi (jusqu’à 1 h).',
    });
    unmeasured.add('site');
  } else if (b.status === 'crit') {
    out.push({
      key: 'site', level: 'urgent', panne: true, rank: 3,
      what: `Page publique sans données alors que la base répond (${b.value}).`,
      gravity: 'données absentes de mulklick.ch.',
    });
  } else if (b.status === 'warn') {
    out.push({
      key: 'site', level: 'important', panne: false, rank: 1, confirm: true,
      what: `Page publique incomplète (${b.value}).`,
      gravity: 'anomalie confirmée, une partie des chiffres manque.',
    });
  }

  if (c.status === 'skip') unmeasured.add('fraicheur');
  else if (c.status === 'warn') {
    out.push({
      key: 'fraicheur', level: 'important', panne: false, rank: 1, confirm: true,
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
      key: 'disque_lecture', level: 'important', panne: false, rank: 1, confirm: true,
      what: `Niveau du disque illisible (${d.value}).`,
      gravity: 'anomalie confirmée, le disque n’est plus surveillé.',
    });
  } else {
    const pct = d.pct;
    const days = projectDiskDays(state.diskSteps, pct, cfg);
    let level = null;
    let rank = 0;
    if (pct >= cfg.diskUrgentPct || (days !== null && days < cfg.diskUrgentDays)) {
      level = 'urgent';
      rank = 3;
    } else if (d.level === 'critique' || (days !== null && days < cfg.diskImportantDays)) {
      level = 'important';
      rank = 2;
    } else if (d.level === 'avertissement') {
      level = 'important';
      rank = 1;
    }
    const open = state.incidents.disque;
    // Hystérésis : un incident ouvert reste ouvert tant qu'on n'est pas 5 points sous le seuil de 65 %.
    if (!level && open && pct >= cfg.diskWarnPct - cfg.diskHysteresisPct) {
      level = 'important';
      rank = 1;
    }
    if (level) {
      const proj = days !== null ? `, plein (95 %) dans ≈ ${Math.max(0, Math.round(days))} j au rythme actuel` : '';
      out.push({
        key: 'disque', level, panne: false, rank, pct,
        what: `Disque de la base ≈ ${pct} % de 18 GB${proj}.`,
        gravity:
          level === 'urgent'
            ? 'risque sous 48 h : à 95 %, Supabase bloque la base et le site perd ses données.'
            : 'risque à venir : à 95 %, Supabase bloque la base et le site perd ses données.',
      });
    }
  }

  if (state.heartbeatFails >= cfg.heartbeatFailRuns) {
    out.push({
      key: 'relais', level: 'urgent', panne: false, rank: 3,
      what: `Le contrôleur de vie du watchdog ne répond plus (${state.heartbeatFails} signaux de vie refusés).`,
      gravity: 'si le watchdog s’arrêtait maintenant, personne ne le saurait.',
    });
  }
  return { incidents: out, unmeasured };
}

// ───────────────────────────── messages (3 lignes au plus) ─────────────────────────────

function incidentText(kind, inc, nowMs, since) {
  const head = {
    open: `${ICON[inc.level]} ${LEVEL[inc.level]} — ${inc.what}`,
    worse: `${ICON[inc.level]} ${LEVEL[inc.level]} — S’AGGRAVE : ${inc.what}`,
    better: `🟠 ${LEVEL[inc.level]} — S’AMÉLIORE : ${inc.what}`,
    recur: `🔁 ${LEVEL[inc.level]} — RÉCIDIVE : ${inc.what}`,
    remind: `${ICON[inc.level]} ${LEVEL[inc.level]} — TOUJOURS EN COURS depuis ${fmtDuration(nowMs - since)} : ${inc.what}`,
  }[kind];
  const gravity =
    kind === 'recur'
      ? `même problème, revenu moins de 6 h après sa résolution ; plus de message avant 6 h de retour à la normale. Premier constat ${fmtUtc(since)}.`
      : `${inc.gravity} Depuis ${fmtUtc(since)}.`;
  return [head, `Gravité : ${gravity}`, `Action : ${ACTIONS[inc.key]}`].join('\n');
}

function closeText(key, okSince, openedAt) {
  return [
    `🟢 RÉSOLU — ${TITLES[key]} : revenu à la normale le ${fmtUtc(okSince)}, après ${fmtDuration(okSince - openedAt)}.`,
    'Action : aucune.',
  ].join('\n');
}

function gapText(fromMs, toMs) {
  return [
    `🟠 IMPORTANT — Le watchdog n’a pas tourné pendant ${fmtDuration(toMs - fromMs)} (du ${fmtUtc(fromMs)} au ${fmtUtc(toMs)}).`,
    'Gravité : rien n’a été surveillé pendant ce temps ; il tourne de nouveau.',
    'Action : vérifier l’historique de cron-job.org et l’onglet Actions de mulklick-watchdog.',
  ].join('\n');
}

function weeklyText(state, nowMs, env, cfg) {
  const p = state.period;
  const from = zurichNow(p.since + cfg.runEveryMs).short; // premier passage de la période
  const to = zurichNow(nowMs).short;
  const inc = p.incidents.length
    ? `${p.incidents.length} incident${p.incidents.length > 1 ? 's' : ''} (${[...new Set(p.incidents)].join(', ')})`
    : 'aucun incident';
  const expected = Math.max(1, Math.round((nowMs - p.since) / cfg.runEveryMs));
  const gaps = p.gaps.length ? `, ${p.gaps.length} interruption${p.gaps.length > 1 ? 's' : ''}` : '';
  const reset = p.reset ? ', état réinitialisé (cache perdu)' : '';
  const pct = p.lastPct;
  const trend = pct === null ? '' : p.startPct === null || pct === p.startPct ? ' (stable)' : ` (${pct > p.startPct ? '+' : ''}${pct - p.startPct} pts)`;
  const disk = pct === null ? 'disque non mesuré' : `disque ≈ ${pct} % de 18 GB${trend}`;
  const capture = p.capture ? `dernière capture ${p.capture}` : 'capture non mesurée';
  const open = Object.keys(state.incidents);
  const actions = [];
  if (open.length) actions.push(`incident(s) encore ouvert(s) : ${open.map((k) => TITLES[k]).join(', ')}`);
  if (!env.HEARTBEAT_URL) actions.push('contrôleur de vie externe non configuré');
  return [
    `📋 Semaine du ${from} au ${to} : ${inc}.`,
    `Surveillance : ${p.runs} passages sur ≈ ${expected}${gaps}${reset} · ${disk} · ${capture}.`,
    `Action : ${actions.length ? actions.join(' ; ') : 'aucune'}.`,
  ].join('\n');
}

export function testSummary(results, nowMs) {
  const mark = { ok: '✅', warn: '🟠', crit: '🔴', skip: '⏭️' };
  return [
    `🧪 TEST — Watchdog Mulklick (lancement manuel, ${fmtUtc(nowMs)})`,
    ...results.map((r) => `${mark[r.status]} ${r.id} : ${r.value}`),
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
  const s = normalizeState(prevState, nowMs, cfg);
  const z = zurichNow(nowMs);
  const msgs = [];
  const by = Object.fromEntries(results.map((r) => [r.id, r]));

  // En mode secours, ni messages d'arrêt (ce workflow passe rarement, c'est attendu) ni résumé du
  // lundi : la surveillance principale du cockpit s'en charge.
  const secours = Boolean(env.PRINCIPAL_HEALTH_URL);

  // 1) Preuve de vie : le watchdog s'est-il arrêté ? (une alerte non partie est gardée et renvoyée)
  if (!secours && s.lastRunAt !== null) {
    const gap = nowMs - s.lastRunAt;
    if (gap > cfg.gapImportantMs && !s.pendingGap) s.pendingGap = { from: s.lastRunAt, to: nowMs };
    else if (gap > cfg.gapInfoMs) s.period.gaps.push(gap); // information : résumé du lundi seulement
  }
  if (s.pendingGap) {
    const g = s.pendingGap;
    msgs.push({
      text: gapText(g.from, g.to), sound: false, panne: false, key: 'gap',
      commit: (st) => {
        st.period.gaps.push(g.to - g.from);
        st.pendingGap = null;
      },
    });
  }
  s.lastRunAt = nowMs;
  s.period.runs += 1;
  for (const [k, c] of Object.entries(s.closed)) if (nowMs - c.at > cfg.recurrenceWindowMs) delete s.closed[k];

  // 2) Mesures pour le résumé et la projection du disque.
  if (by.D && typeof by.D.pct === 'number') {
    s.diskSteps = updateDiskSteps(s.diskSteps, by.D.pct, nowMs);
    if (s.period.startPct === null) s.period.startPct = by.D.pct;
    s.period.lastPct = by.D.pct;
  }
  if (by.C && by.C.capture) s.period.capture = by.C.capture;

  // 3) Incidents.
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
      const closed = s.closed[inc.key];
      const recur = closed && inc.rank <= closed.rank;
      const record = {
        level: inc.level, rank: inc.rank, panne: inc.panne, openedAt: recur ? closed.openedAt : pend.first,
        notifiedAt: nowMs, okSince: null, lowerRuns: 0, recurrences: recur ? (closed.recurrences ?? 0) + 1 : 0,
        mutedByCap: false, pct: inc.pct,
      };
      msgs.push({
        text: incidentText(recur ? 'recur' : 'open', inc, nowMs, pend.first),
        sound: !recur && inc.level === 'urgent', panne: inc.panne, key: inc.key,
        commit: (st) => {
          st.incidents[inc.key] = { ...record };
          delete st.pending[inc.key];
          delete st.closed[inc.key];
          st.period.incidents.push(TITLES[inc.key]);
        },
      });
      continue;
    }
    prev.okSince = null;
    prev.panne = inc.panne;
    if (inc.pct !== undefined) prev.pct = inc.pct;
    if (inc.rank > prev.rank) {
      prev.lowerRuns = 0;
      msgs.push({
        text: incidentText('worse', inc, nowMs, prev.openedAt), sound: inc.level === 'urgent', panne: inc.panne, key: inc.key,
        commit: (st) => Object.assign(st.incidents[inc.key], { level: inc.level, rank: inc.rank, notifiedAt: nowMs, mutedByCap: false }),
      });
    } else if (inc.rank < prev.rank) {
      // Baisse confirmée seulement après plusieurs passages (pas de yo-yo autour d'un seuil).
      prev.lowerRuns = (prev.lowerRuns ?? 0) + 1;
      if (prev.lowerRuns >= cfg.downgradeAfterRuns) {
        if (inc.level !== prev.level) {
          msgs.push({
            text: incidentText('better', inc, nowMs, prev.openedAt), sound: false, panne: inc.panne, key: inc.key,
            commit: (st) => Object.assign(st.incidents[inc.key], { level: inc.level, rank: inc.rank, notifiedAt: nowMs, lowerRuns: 0, mutedByCap: false }),
          });
        } else {
          prev.rank = inc.rank; // même niveau, palier plus bas : rien à dire
          prev.lowerRuns = 0;
        }
      }
    } else {
      prev.lowerRuns = 0;
      const every = cfg.renotifyMs[inc.level];
      const capReplay = prev.mutedByCap && inc.level === 'urgent' && prev.mutedDay !== z.date;
      if (capReplay || (every && nowMs - prev.notifiedAt >= every)) {
        msgs.push({
          text: incidentText('remind', inc, nowMs, prev.openedAt), sound: inc.level === 'urgent', panne: inc.panne, key: inc.key,
          commit: (st) => Object.assign(st.incidents[inc.key], { notifiedAt: nowMs, mutedByCap: false }),
        });
      }
    }
  }
  for (const key of Object.keys(s.pending)) if (!current.has(key) && !unmeasured.has(key)) delete s.pending[key];

  // 4) Clôtures (silencieuses) après un retour à la normale continu (1 h, 6 h après une récidive).
  for (const [key, prev] of Object.entries(s.incidents)) {
    if (current.has(key) || unmeasured.has(key)) continue;
    if (prev.okSince === null || prev.okSince === undefined) prev.okSince = nowMs;
    prev.lowerRuns = 0;
    const need = prev.recurrences ? cfg.recurrenceResolveAfterOkMs : cfg.resolveAfterOkMs;
    if (nowMs - prev.okSince >= need) {
      const { okSince, openedAt, rank, recurrences } = prev;
      msgs.push({
        text: closeText(key, okSince, openedAt), sound: false, panne: false, key,
        commit: (st) => {
          delete st.incidents[key];
          st.closed[key] = { at: nowMs, openedAt, rank, recurrences: recurrences ?? 0 };
        },
      });
    }
  }

  // 5) Résumé hebdomadaire silencieux (lundi à partir de 08:00 heure suisse).
  const wk = weekKey(nowMs, cfg);
  if (secours) s.lastWeeklyKey = wk;
  else if (s.lastWeeklyKey !== wk) {
    msgs.push({
      text: weeklyText(s, nowMs, env, cfg), sound: false, panne: false, key: 'weekly',
      commit: (st) => {
        st.lastWeeklyKey = wk;
        const fresh = newPeriod(nowMs);
        // Un incident ouvert à ce même passage compte dans la semaine qui commence.
        fresh.incidents = Object.entries(st.incidents).filter(([, i]) => i.openedAt === nowMs).map(([k]) => TITLES[k]);
        st.period = fresh;
      },
    });
  }

  // 6) Plafond : au plus N messages sonores par jour hors panne ; au-delà, regroupés en silencieux.
  const used = s.sound.day === z.date ? s.sound.count : 0;
  let planned = 0;
  const over = [];
  const kept = [];
  for (const m of msgs) {
    if (m.sound && !m.panne) {
      if (used + planned >= cfg.soundCapPerDay) {
        over.push(m);
        continue;
      }
      planned += 1;
      const inner = m.commit;
      m.commit = (st) => {
        inner(st);
        st.sound = st.sound.day === z.date ? { day: z.date, count: st.sound.count + 1 } : { day: z.date, count: 1 };
      };
    }
    kept.push(m);
  }
  if (over.length) {
    const n = over.length;
    kept.push({
      text: [
        `🔕 REGROUPÉ — ${n} alerte${n > 1 ? 's' : ''} urgente${n > 1 ? 's' : ''} sans son (plafond de ${cfg.soundCapPerDay} alertes sonores par jour atteint) : ${over.map((m) => TITLES[m.key]).join(' ; ')}.`,
        'Gravité : urgente ; redonnée avec son demain si elle dure.',
        'Action : voir le détail dans le journal du run (onglet Actions de mulklick-watchdog).',
      ].join('\n'),
      sound: false,
      panne: false,
      key: 'grouped',
      commit: (st) =>
        over.forEach((m) => {
          m.commit(st);
          if (st.incidents[m.key]) Object.assign(st.incidents[m.key], { mutedByCap: true, mutedDay: z.date });
        }),
    });
  }
  // Ordre d'envoi : sonores d'abord.
  kept.sort((x, y) => Number(y.sound) - Number(x.sound));
  return { state: s, messages: kept };
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
export async function checkPrincipal({ fetchImpl, env, nowMs, cfg = CONFIG }) {
  try {
    const res = await fetchWithTimeout(fetchImpl, env.PRINCIPAL_HEALTH_URL, { headers: { 'cache-control': 'no-cache' } });
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
    return { id: 'P', status: 'ok', value: `dernier passage ${fmtUtc(t)}` };
  } catch (e) {
    return { id: 'P', status: 'crit', value: `cockpit injoignable (${errText(e)})` };
  }
}

const CLES_DU_SITE = ['base', 'site', 'fraicheur', 'disque', 'disque_lecture'];

export async function runOnce({ fetchImpl, sleep = realSleep, env, prevState, nowMs = Date.now(), log = console.log, cfg = CONFIG }) {
  let results;
  if (env.PRINCIPAL_HEALTH_URL) {
    const p = await checkPrincipal({ fetchImpl, env, nowMs, cfg });
    if (p.status === 'ok') {
      // Cockpit vivant : il fait les contrôles du site. Le secours se tait et lui passe la main
      // (ses propres incidents du site sont oubliés sans message : le cockpit a les siens).
      results = [p];
      if (prevState && prevState.version === 2) {
        prevState = structuredClone(prevState);
        for (const k of CLES_DU_SITE) {
          if (prevState.incidents) delete prevState.incidents[k];
          if (prevState.pending) delete prevState.pending[k];
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
  if (String(env.WATCHDOG_TEST).toLowerCase() === 'true') {
    messages.push({ text: testSummary(results, nowMs), sound: false, panne: false, key: 'test', commit: () => {} });
  }

  const sent = [];
  let failed = false;
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
  return { exitCode: failed ? 1 : 0, results, sent, stateToWrite: state };
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
