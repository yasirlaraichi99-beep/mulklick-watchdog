// Watchdog Mulklick — tourne sur GitHub Actions (.github/workflows/watchdog.yml), indépendamment de
// la base et de l'hébergement du site. Lecture seule : il ne fait que des GET publics et envoie les
// alertes sur Telegram. Aucune clé d'API n'est nécessaire.
// DÉPÔT PUBLIC : aucun secret ni identifiant interne dans ce code, tout passe par les secrets GitHub.
//
// Quatre contrôles :
//   A — panne      : GET /api/health → 200 et db_ok=true, 3 essais espacés de 20 s.
//   B — page       : GET /fr/intelligence → les cartes nationales affichent des valeurs.
//   C — fraîcheur  : age_hours (rendu par /api/health) ≤ seuil.
//   D — disque     : disk_level (rendu par /api/health) : ≥ 65 % avertissement, ≥ 80 % critique de 18 GB.
//
// Anti-spam : l'état précédent est relu depuis WATCHDOG_STATE_FILE (restauré par le cache Actions).
// Un message au passage OK → KO, un rappel par heure tant que c'est KO, un message « rétabli » au
// retour. Si l'envoi Telegram échoue, l'état n'est PAS avancé (l'alerte repartira au run suivant)
// et le job échoue.
//
// Bilan du matin : chaque jour, au premier passage à partir de 08:00 heure suisse, un message
// « tout va bien » (heure du passage, niveau du disque, passages depuis le bilan précédent). C'est
// le signe de vie du watchdog : s'il manque un matin, le watchdog est arrêté.
//
// Aucune dépendance : Node ≥ 20 (fetch global). Le module exporte sa logique pour les tests
// (watchdog.test.mjs), qui simulent toutes les réponses réseau — aucun vrai message n'y part.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CONFIG = {
  siteBase: 'https://www.mulklick.ch',
  healthPath: '/api/health',
  pagePath: '/fr/intelligence',
  // Marqueurs relevés dans le code du site (cartes nationales de /fr/intelligence) :
  // - carte SANS donnée : « Aucune valeur actuelle », une fois par carte vide ;
  // - carte AVEC donnée : la courbe <polyline data-spark="">, rendue seulement quand la carte a un
  //   score. La page en porte 8 quand tout va bien.
  markerAbsent: 'Aucune valeur actuelle',
  markerPresent: 'data-spark=""',
  expectedCards: 8,
  healthAttempts: 3,
  retryDelayMs: 20_000,
  requestTimeoutMs: 15_000,
  // Le scraper tourne lun, mar, jeu, ven à 03:00 Europe/Zurich. Le plus long écart normal entre deux captures est ven → lun = 3 jours.
  // Seuil = cadence + 2 jours = 5 jours.
  freshnessMaxHours: 120,
  reminderMs: 55 * 60_000, // « une fois par heure » ; 5 min de marge pour le retard du cron GitHub
  // Bilan quotidien « tout va bien » : premier passage à partir de 08:00 heure suisse, une fois par
  // jour (date suisse). C'est le signe de vie du watchdog : s'il manque un matin, le watchdog est
  // arrêté. Le fuseau Europe/Zurich gère seul le passage heure d'été / heure d'hiver.
  dailyHourZurich: 8,
  expectedPassesPerDay: 144, // un passage toutes les 10 minutes
};

const LABELS = {
  A: 'Contrôle A — panne (/api/health)',
  B: 'Contrôle B — page publique (/fr/intelligence)',
  C: 'Contrôle C — fraîcheur des données',
  D: 'Contrôle D — disque de la base (Supabase)',
};

const ACTIONS = {
  A: "Ouvrir le tableau de bord Supabase (projet restreint ? en pause ?), puis les logs Vercel de /api/health.",
  B: "Ouvrir mulklick.ch/fr/intelligence ; si la base répond (contrôle A vert), relancer le cron snapshot-cards ou redéployer.",
  C: "Vérifier que le scraper (lun/mar/jeu/ven 03:00) a tourné : logs du backend et crédit du fournisseur de scraping.",
  D: "Libérer de la place dans la base (rétention des archives de scraping) ou agrandir le disque avant la restriction.",
};

const ICON = { crit: '🔴', warn: '🟠', ok: '🟢' };
const LEVEL_TXT = { crit: 'CRITIQUE', warn: 'AVERTISSEMENT' };
const SEVERITY = { ok: 0, skip: 0, warn: 1, crit: 2 };

// ───────────────────────────── utilitaires ─────────────────────────────

export const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(fetchImpl, url, init = {}, timeoutMs = CONFIG.requestTimeoutMs) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

function fmtUtc(nowMs) {
  return new Date(nowMs).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
}

/** Date (AAAA-MM-JJ), heure et libellé « JJ.MM.AAAA HH:MM » à l'heure suisse. */
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
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: Number(p.hour),
    label: `${p.day}.${p.month}.${p.year} ${p.hour}:${p.minute}`,
  };
}

function fmtDuration(ms) {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m ? `${h} h ${String(m).padStart(2, '0')}` : `${h} h`;
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

/** A — /api/health, 3 essais espacés de 20 s. Rend aussi le JSON pour le contrôle C. */
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
        const absent = countOccurrences(html, cfg.markerAbsent);
        const present = countOccurrences(html, cfg.markerPresent);
        const counts = `${present}/${cfg.expectedCards} cartes chiffrées, ${absent} « ${cfg.markerAbsent} »`;
        // Les marqueurs dépendent du contenu, pas du réseau : inutile de réessayer.
        if (present === 0 && absent > 0) return { id: 'B', status: 'crit', value: `données absentes : ${counts}` };
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
  return { id: 'C', status: h.age_hours > cfg.freshnessMaxHours ? 'warn' : 'ok', value };
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

// ───────────────────────────── décision + messages ─────────────────────────────

function alertMessage(kind, r, nowMs, sinceMs) {
  const head =
    kind === 'reminder'
      ? `${ICON[r.status]} RAPPEL ${LEVEL_TXT[r.status]} (KO depuis ${fmtDuration(nowMs - sinceMs)}) — ${LABELS[r.id]}`
      : `${ICON[r.status]} ${LEVEL_TXT[r.status]} — ${LABELS[r.id]}`;
  return [head, `Mesuré : ${r.value}`, `Heure : ${fmtUtc(nowMs)}`, `À faire : ${ACTIONS[r.id]}`].join('\n');
}

function recoveredMessage(r, nowMs, sinceMs) {
  return [
    `${ICON.ok} RÉTABLI — ${LABELS[r.id]}`,
    `Mesuré : ${r.value}`,
    `Heure : ${fmtUtc(nowMs)}`,
    `À faire : rien. Incident terminé après ${fmtDuration(nowMs - sinceMs)}.`,
  ].join('\n');
}

/**
 * Compare les résultats à l'état précédent. Rend les messages à envoyer et l'état suivant.
 * État par contrôle : { status: 'ok'|'warn'|'crit', since, lastAlertAt }.
 */
export function decide(prevState, results, nowMs, cfg = CONFIG) {
  const prevChecks = (prevState && prevState.checks) || {};
  const checks = { ...prevChecks };
  const messages = [];
  for (const r of results) {
    const prev = prevChecks[r.id];
    const prevKo = prev && (prev.status === 'warn' || prev.status === 'crit');
    if (r.status === 'skip') continue; // contrôle non mesuré : on ne touche pas à son état
    if (r.status === 'ok') {
      if (prevKo) messages.push(recoveredMessage(r, nowMs, prev.since ?? nowMs));
      checks[r.id] = { status: 'ok', since: prevKo ? nowMs : (prev?.since ?? nowMs), lastAlertAt: null };
      continue;
    }
    // warn ou crit
    if (!prevKo) {
      messages.push(alertMessage('new', r, nowMs, nowMs));
      checks[r.id] = { status: r.status, since: nowMs, lastAlertAt: nowMs };
    } else if (SEVERITY[r.status] > SEVERITY[prev.status]) {
      // Aggravation (avertissement → critique) : c'est une information nouvelle, on prévient tout de suite.
      messages.push(alertMessage('new', r, nowMs, prev.since));
      checks[r.id] = { status: r.status, since: prev.since, lastAlertAt: nowMs };
    } else if (nowMs - (prev.lastAlertAt ?? 0) >= cfg.reminderMs) {
      messages.push(alertMessage('reminder', r, nowMs, prev.since ?? nowMs));
      checks[r.id] = { status: r.status, since: prev.since, lastAlertAt: nowMs };
    } else {
      checks[r.id] = { status: r.status, since: prev.since, lastAlertAt: prev.lastAlertAt };
    }
  }
  return { messages, nextState: { version: 1, updatedAt: nowMs, checks } };
}

export function testSummary(results, nowMs) {
  const mark = { ok: '✅', warn: '🟠', crit: '🔴', skip: '⏭️' };
  return [
    '🧪 TEST — Watchdog Mulklick (lancement manuel)',
    ...results.map((r) => `${mark[r.status]} ${LABELS[r.id]} : ${r.value}`),
    `Heure : ${fmtUtc(nowMs)}`,
    'À faire : rien, message de test. Les alertes réelles arrivent seulement en cas de problème.',
  ].join('\n');
}

/**
 * Bilan du matin : signe de vie quotidien. Toujours envoyé (même si un contrôle est en alerte),
 * avec l'heure du passage, le niveau du disque, les contrôles en alerte s'il y en a, et le nombre
 * de passages depuis le bilan précédent (≈ 144 attendus : un chiffre bas = déclencheur défaillant).
 */
export function dailySummary(results, nowMs, passes, cfg = CONFIG) {
  const z = zurichNow(nowMs);
  const ko = results.filter((r) => r.status === 'warn' || r.status === 'crit');
  const d = results.find((r) => r.id === 'D');
  const disk =
    d && d.level
      ? `${d.level}, ≈ ${d.pct} % de 18 GB`
      : d && d.status === 'skip'
        ? 'non mesuré (site injoignable)'
        : `non mesuré (${d ? d.value : 'contrôle absent'})`;
  const mark = { warn: '🟠', crit: '🔴' };
  return [
    ko.length
      ? `☀️ BILAN DU MATIN — watchdog actif, ${ko.length} contrôle${ko.length > 1 ? 's' : ''} en alerte`
      : '☀️ BILAN DU MATIN — tout va bien',
    `Dernier passage : ${z.label} (heure suisse)`,
    `Disque : ${disk}`,
    ...ko.map((r) => `${mark[r.status]} ${LABELS[r.id]} : ${r.value}`),
    `Passages depuis le bilan précédent : ${passes} (≈ ${cfg.expectedPassesPerDay} attendus par jour)`,
    'Si ce bilan manque un matin, le watchdog est arrêté : vérifier cron-job.org, puis l’onglet Actions de mulklick-watchdog.',
  ].join('\n');
}

// ───────────────────────────── Telegram ─────────────────────────────

export async function sendTelegram({ fetchImpl, token, chatId, text }) {
  if (!token || !chatId) throw new Error('Telegram : TELEGRAM_BOT_TOKEN ou TELEGRAM_CHAT_ID absent');
  let res;
  try {
    res = await fetchWithTimeout(fetchImpl, `https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, disable_web_page_preview: true }),
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

// ───────────────────────────── orchestration ─────────────────────────────

export async function runChecks({ fetchImpl, sleep, env, cfg = CONFIG }) {
  const [a, b] = await Promise.all([
    checkHealth({ fetchImpl, sleep, cfg }),
    checkPage({ fetchImpl, sleep, cfg }),
  ]);
  const c = checkFreshness(a, cfg);
  const d = checkDisk(a);
  return [a, b, c, d];
}

/**
 * Un passage complet. Rend { exitCode, results, sent, stateToWrite }.
 * L'état n'avance que si tous les messages sont partis.
 */
export async function runOnce({ fetchImpl, sleep = realSleep, env, prevState, nowMs = Date.now(), log = console.log, cfg = CONFIG }) {
  const results = await runChecks({ fetchImpl, sleep, env, cfg });
  for (const r of results) log(`[${r.id}] ${r.status.toUpperCase()} — ${r.value}`);

  const { messages, nextState } = decide(prevState, results, nowMs, cfg);
  const testMode = String(env.WATCHDOG_TEST).toLowerCase() === 'true';
  const outgoing = [...messages];
  if (testMode) outgoing.push(testSummary(results, nowMs));

  // Bilan du matin : une fois par date suisse, au premier passage à partir de 08:00.
  const z = zurichNow(nowMs);
  const passes = (prevState?.passesSinceDaily ?? 0) + 1;
  const dailyDue = z.hour >= cfg.dailyHourZurich && prevState?.lastDailyDate !== z.date;
  if (dailyDue) outgoing.push(dailySummary(results, nowMs, passes, cfg));
  nextState.lastDailyDate = dailyDue ? z.date : (prevState?.lastDailyDate ?? null);
  nextState.passesSinceDaily = dailyDue ? 0 : passes;

  if (!outgoing.length) {
    log('Aucun message à envoyer.');
    return { exitCode: 0, results, sent: [], stateToWrite: nextState };
  }
  const text = outgoing.join('\n\n');
  try {
    await sendTelegram({ fetchImpl, token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID, text });
  } catch (e) {
    log(`ÉCHEC de l'envoi Telegram : ${e.message}`);
    // L'état précédent est conservé : la transition sera re-détectée et renvoyée au run suivant.
    return { exitCode: 1, results, sent: [], stateToWrite: prevState ?? { version: 1, checks: {} } };
  }
  log(`Telegram : ${outgoing.length} message(s) envoyé(s) en un seul envoi.`);
  return { exitCode: 0, results, sent: outgoing, stateToWrite: nextState };
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
