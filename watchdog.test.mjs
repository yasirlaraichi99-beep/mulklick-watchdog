// Tests du watchdog avec réponses simulées. AUCUN appel réseau réel : chaque contrôle reçoit un
// faux fetch qui répond selon l'URL et lève une erreur sur toute URL inconnue. Les appels à
// api.telegram.org sont interceptés et enregistrés (avec leur caractère sonore ou silencieux),
// jamais émis. Le « banc d'essai » en fin de fichier simule des semaines entières, un passage
// toutes les 10 minutes, et compte les messages sonores et silencieux.
//   node --test watchdog.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce, planRun, projectDiskDays, updateDiskSteps, normalizeState, CONFIG, checkPage } from './watchdog.mjs';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 10, 19, 14, 0); // jeu. 19.11.2026 14:00 UTC (15:00 heure suisse)
const TUE_17_MIDNIGHT_CH = Date.UTC(2026, 10, 16, 23, 0); // mar. 17.11.2026 00:00 heure suisse

const HEALTHY_HTML = `<html>${'<polyline data-spark="" points="0,1 2,3"></polyline>'.repeat(8)}${' '.repeat(30_000)}</html>`;
const EMPTY_HTML = `<html>${'<div>Aucune valeur actuelle</div>'.repeat(8)}${' '.repeat(30_000)}</html>`;
const PARTIAL_HTML = `<html>${'<polyline data-spark=""></polyline>'.repeat(6)}${'<div>Aucune valeur actuelle</div>'.repeat(2)}</html>`;
const cards = (n, state) => `<article data-card-state="${state}"></article>`.repeat(n);
const PAD = ' '.repeat(30_000);
const RESERVED_HEALTHY_HTML = `<html>${cards(3, 'value')}${cards(5, 'reserved')}${PAD}</html>`;
const RESERVED_EMPTY_HTML = `<html>${cards(8, 'empty')}${'<div>Aucune valeur actuelle</div>'.repeat(8)}${PAD}</html>`;
const RESERVED_PARTIAL_HTML = `<html>${cards(3, 'value')}${cards(3, 'reserved')}${cards(2, 'empty')}${PAD}</html>`;
const MIXED_HTML = `<html>${'<article data-card-state="value"><polyline data-spark=""></polyline></article>'.repeat(3)}${cards(5, 'reserved')}${PAD}</html>`;
const HEALTH_OK = { db_ok: true, latest_capture: '2026-11-19', age_hours: 14, response_ms: 42, disk_level: 'ok', disk_pct: 50 };
const DOWN = { healthStatus: 503, healthBody: { db_ok: false, disk_level: null, disk_pct: null } };
const disk = (pct) => ({
  healthBody: { ...HEALTH_OK, disk_level: pct >= 80 ? 'critique' : pct >= 65 ? 'avertissement' : 'ok', disk_pct: pct },
});

function jsonRes(status, body) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}
function textRes(status, text) {
  return { status, json: async () => JSON.parse(text), text: async () => text };
}

/** Faux réseau. calls.telegram = [{ text, silent }] ; calls.pings = chemins du contrôleur de vie. */
function fakeNet(site) {
  const calls = { telegram: [], health: 0, page: 0, hosts: [], pings: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.hosts.push(u.hostname);
    if (u.hostname === 'api.telegram.org') {
      const body = JSON.parse(init.body);
      if (site.telegramFails) return jsonRes(401, { ok: false, description: 'Unauthorized' });
      calls.telegram.push({ chat_id: body.chat_id, text: body.text, silent: body.disable_notification === true });
      return jsonRes(200, { ok: true, result: { message_id: calls.telegram.length } });
    }
    if (u.hostname === 'hc-ping.example') {
      calls.pings.push(u.pathname);
      return jsonRes(site.heartbeatDown ? 503 : 200, 'OK');
    }
    if (u.hostname === 'www.mulklick.ch' && u.pathname === '/api/health') {
      calls.health += 1;
      assert.ok(u.searchParams.get('wd'), 'paramètre anti-cache attendu sur /api/health');
      if (site.healthThrows) throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      return jsonRes(site.healthStatus ?? 200, site.healthBody ?? HEALTH_OK);
    }
    if (u.hostname === 'www.mulklick.ch' && u.pathname === '/fr/intelligence') {
      calls.page += 1;
      assert.ok(u.searchParams.get('wd'), 'paramètre anti-cache attendu sur la page');
      return textRes(site.pageStatus ?? 200, site.pageHtml ?? HEALTHY_HTML);
    }
    if (u.hostname === 'cockpit.example' && u.pathname === '/health') {
      calls.principal = (calls.principal ?? 0) + 1;
      calls.principalSecours = u.searchParams.get('secours');
      if (site.principalThrows) throw Object.assign(new Error('x'), { name: 'TypeError' });
      return jsonRes(site.principalStatus ?? 200, site.principal ?? { status: 'ok' });
    }
    throw new Error(`URL inattendue dans un test : ${u.hostname}${u.pathname}`);
  };
  return { fetchImpl, calls };
}

const BASE_ENV = { TELEGRAM_BOT_TOKEN: 'TEST-TOKEN-NOT-REAL', TELEGRAM_CHAT_ID: '42' };
const HB_ENV = { HEARTBEAT_URL: 'https://hc-ping.example/uuid-de-test' };

/** Un passage. L'état est relu comme en vrai : sérialisé en JSON entre deux passages. */
async function run(site, { env = {}, prevState = null, nowMs = T0 } = {}) {
  const net = fakeNet(site);
  const sleeps = [];
  const logs = [];
  const out = await runOnce({
    fetchImpl: net.fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    env: { ...BASE_ENV, ...env },
    prevState: prevState === null ? null : JSON.parse(JSON.stringify(prevState)),
    nowMs,
    log: (l) => logs.push(l),
  });
  const byId = Object.fromEntries(out.results.map((r) => [r.id, r]));
  return { ...out, state: JSON.parse(JSON.stringify(out.stateToWrite)), byId, calls: net.calls, sleeps, logs };
}

/**
 * Banc d'essai : `runs` passages toutes les 10 minutes ; `site(i, t)` décrit l'état simulé ;
 * `skip(i)` saute un passage (watchdog arrêté).
 */
async function simulate({ start, runs, site = () => ({}), env = {}, prevState = null, skip = () => false }) {
  let state = prevState;
  const sent = [];
  let pings = 0;
  let failedRuns = 0;
  for (let i = 0; i < runs; i += 1) {
    if (skip(i)) continue;
    const t = start + i * 10 * MIN;
    const r = await run(site(i, t), { env, prevState: state, nowMs: t });
    state = r.state;
    if (r.exitCode !== 0) failedRuns += 1;
    pings += r.calls.pings.length;
    for (const m of r.calls.telegram) sent.push({ ...m, t, i });
  }
  return { state, sent, sound: sent.filter((m) => !m.silent), silent: sent.filter((m) => m.silent), pings, failedRuns };
}

const lines = (text) => text.split('\n').length;

// ───────────────────────────── contrôles et niveaux ─────────────────────────────

test('tout va bien : aucun message', async () => {
  const r = await run({});
  assert.equal(r.exitCode, 0);
  assert.deepEqual(['A', 'B', 'C', 'D'].map((k) => r.byId[k].status), ['ok', 'ok', 'ok', 'ok']);
  assert.equal(r.calls.telegram.length, 0);
  assert.deepEqual(r.sleeps, []);
  assert.ok(!r.calls.hosts.some((h) => h.endsWith('supabase.co')), 'aucune requête vers Supabase');
});

test('panne (503) : un seul message URGENT sonore de 3 lignes, 3 essais à 20 s', async () => {
  const r = await run(DOWN);
  assert.equal(r.calls.health, 3);
  assert.deepEqual(r.sleeps, [20_000, 20_000]);
  assert.equal(r.calls.telegram.length, 1);
  const m = r.calls.telegram[0];
  assert.equal(m.silent, false, 'urgent = avec son');
  assert.equal(lines(m.text), 3);
  assert.match(m.text, /^🔴 URGENT — Base de données ou \/api\/health injoignable \(HTTP 503/);
  assert.match(m.text, /\nGravité : panne en cours.* Depuis 19\.11 14:00 UTC\./);
  assert.match(m.text, /\nAction : tableau de bord Supabase/);
});

test('échec passager de /api/health (2 essais ratés, 3e bon) : rien', async () => {
  let n = 0;
  const net = fakeNet({});
  const flaky = async (url, init) => {
    if (String(url).includes('/api/health') && n++ < 2) return jsonRes(502, null);
    return net.fetchImpl(url, init);
  };
  const out = await runOnce({ fetchImpl: flaky, sleep: async () => {}, env: BASE_ENV, prevState: null, nowMs: T0, log: () => {} });
  assert.equal(out.results[0].status, 'ok');
  assert.equal(net.calls.telegram.length, 0);
});

test('regroupement : base injoignable + page vide = UN seul message (même cause)', async () => {
  const r = await run({ ...DOWN, pageHtml: EMPTY_HTML });
  assert.equal(r.calls.telegram.length, 1);
  assert.match(r.calls.telegram[0].text, /injoignable .* ; page publique : données absentes/);
});

test('données absentes alors que la base répond : URGENT sonore', async () => {
  const r = await run({ pageHtml: EMPTY_HTML });
  assert.equal(r.calls.telegram.length, 1);
  assert.equal(r.calls.telegram[0].silent, false);
  assert.match(r.calls.telegram[0].text, /^🔴 URGENT — Page publique sans données alors que la base répond/);
});

test('cartes réservées (3 en clair + 5 masquées) : aucun message, comptage lisible', async () => {
  const r = await run({ pageHtml: RESERVED_HEALTHY_HTML });
  assert.equal(r.calls.telegram.length, 0);
  const b = await checkPage({ fetchImpl: fakeNet({ pageHtml: RESERVED_HEALTHY_HTML }).fetchImpl, sleep: async () => {} });
  assert.equal(b.status, 'ok');
  assert.match(b.value, /8\/8 cartes avec donnée \(3 en clair, 5 masquées\), 0 vides/);
});

test('cartes réservées : 8 vides → URGENT sonore', async () => {
  const r = await run({ pageHtml: RESERVED_EMPTY_HTML });
  assert.equal(r.calls.telegram.length, 1);
  assert.equal(r.calls.telegram[0].silent, false);
  assert.match(r.calls.telegram[0].text, /^🔴 URGENT — Page publique sans données/);
});

test('cartes réservées : 6 présentes + 2 vides → avertissement (données partielles)', async () => {
  const b = await checkPage({ fetchImpl: fakeNet({ pageHtml: RESERVED_PARTIAL_HTML }).fetchImpl, sleep: async () => {} });
  assert.equal(b.status, 'warn');
  assert.match(b.value, /données partielles : 6\/8 cartes avec donnée \(3 en clair, 3 masquées\), 2 vides/);
});

test('page avec data-spark ET data-card-state : une carte n’est comptée qu’une fois', async () => {
  const b = await checkPage({ fetchImpl: fakeNet({ pageHtml: MIXED_HTML }).fetchImpl, sleep: async () => {} });
  assert.equal(b.status, 'ok');
  assert.match(b.value, /8\/8 cartes avec donnée \(3 en clair, 5 masquées\)/);
});

test('page blanche ou page d’erreur servie en 200 : URGENT, pas un simple avertissement', async () => {
  const r = await run({ pageHtml: '<html><body>Application error</body></html>' });
  assert.equal(r.byId.B.status, 'crit');
  assert.equal(r.calls.telegram[0].silent, false);
  assert.match(r.calls.telegram[0].text, /page vide ou page d'erreur/);
  const changed = await run({ pageHtml: `<html>${' '.repeat(50_000)}</html>` });
  assert.equal(changed.byId.B.status, 'warn', 'page longue sans marqueur : structure modifiée');
});

test('page incomplète : IMPORTANT silencieux, seulement une fois confirmée (2 passages)', async () => {
  const r1 = await run({ pageHtml: PARTIAL_HTML });
  assert.equal(r1.calls.telegram.length, 0, 'premier constat : pas encore confirmé');
  const r2 = await run({ pageHtml: PARTIAL_HTML }, { prevState: r1.state, nowMs: T0 + 10 * MIN });
  assert.equal(r2.calls.telegram.length, 1);
  assert.equal(r2.calls.telegram[0].silent, true, 'important = silencieux');
  assert.match(r2.calls.telegram[0].text, /^🟠 IMPORTANT — Page publique incomplète/);
  assert.match(r2.calls.telegram[0].text, /Depuis 19\.11 14:00 UTC/, 'depuis le premier constat');
  const r3 = await run({ pageHtml: PARTIAL_HTML }, { prevState: r2.state, nowMs: T0 + 20 * MIN });
  assert.equal(r3.calls.telegram.length, 0, 'une seule fois');
});

test('anomalie non confirmée (un seul passage) : rien du tout', async () => {
  const r1 = await run({ pageHtml: PARTIAL_HTML });
  const r2 = await run({}, { prevState: r1.state, nowMs: T0 + 10 * MIN });
  assert.equal(r1.calls.telegram.length + r2.calls.telegram.length, 0);
});

test('données trop anciennes : IMPORTANT silencieux ; week-end normal (110 h) : rien', async () => {
  const stale = { healthBody: { ...HEALTH_OK, latest_capture: '2026-11-14', age_hours: 134 } };
  const r1 = await run(stale);
  const r2 = await run(stale, { prevState: r1.state, nowMs: T0 + 10 * MIN });
  assert.equal(r2.calls.telegram.length, 1);
  assert.equal(r2.calls.telegram[0].silent, true);
  assert.match(r2.calls.telegram[0].text, /^🟠 IMPORTANT — Données de marché trop anciennes \(dernière capture 2026-11-14, âge 134 h/);
  const weekend = await run({ healthBody: { ...HEALTH_OK, age_hours: 110 } });
  assert.equal(weekend.byId.C.status, 'ok');
  assert.equal(weekend.calls.telegram.length, 0);
});

test('disque : 70 % IMPORTANT silencieux ; 85 % et 90 % : rien (pas d’aggravation) ; 95 % (lecture seule) : UN message URGENT sonore', async () => {
  const r1 = await run(disk(70));
  assert.equal(r1.calls.telegram.length, 1);
  assert.equal(r1.calls.telegram[0].silent, true);
  assert.match(r1.calls.telegram[0].text, /^🟠 IMPORTANT — Disque de la base ≈ 70 % de 18 GB\./);
  const r2 = await run(disk(85), { prevState: r1.state, nowMs: T0 + 10 * MIN });
  assert.equal(r2.calls.telegram.length, 0, 'aucune aggravation');
  const r3 = await run(disk(90), { prevState: r2.state, nowMs: T0 + 20 * MIN });
  assert.equal(r3.calls.telegram.length, 0, '90 % : encore un risque, pas une panne');
  const r4 = await run(disk(95), { prevState: r3.state, nowMs: T0 + 30 * MIN });
  assert.equal(r4.calls.telegram.length, 1);
  assert.equal(r4.calls.telegram[0].silent, false);
  assert.match(r4.calls.telegram[0].text, /^🔴 URGENT — Disque de la base ≈ 95 %/);
  assert.match(r4.calls.telegram[0].text, /lecture seule/);
  assert.match(r4.calls.telegram[0].text, /Depuis 19\.11 14:00 UTC/, 'depuis l’ouverture de l’incident');
  const r5 = await run(disk(95), { prevState: r4.state, nowMs: T0 + 40 * MIN });
  assert.equal(r5.calls.telegram.length, 0, 'jamais de rappel');
});

test('disque : projection du remplissage sur les paliers franchis en observation (≥ 12 h)', () => {
  let steps = {};
  steps = updateDiskSteps(steps, 50, 0); // palier de départ : date d'entrée inconnue
  steps = updateDiskSteps(steps, 55, 10 * DAY);
  assert.equal(projectDiskDays(steps, 55), null, 'un seul palier franchi en observation : pas de projection');
  steps = updateDiskSteps(steps, 60, 12 * DAY); // 5 points en 2 jours
  // Prudent : valeur réelle supposée à 65 % ; 30 points à 2 j / 5 points = 12 j.
  assert.equal(Math.round(projectDiskDays(steps, 60)), 12);
  const fast = updateDiskSteps(updateDiskSteps(updateDiskSteps({}, 70, 0), 75, DAY), 80, DAY + 12 * H);
  assert.ok(projectDiskDays(fast, 80) < 2, '5 points en 12 h à 80 % → plein en moins de 48 h');
  const burst = updateDiskSteps(updateDiskSteps(updateDiskSteps({}, 60, 0), 65, DAY), 70, DAY + H);
  assert.equal(projectDiskDays(burst, 70), null, 'à-coup d’une nuit de scraping (1 h) : ignoré');
  assert.deepEqual(Object.keys(updateDiskSteps(steps, 45, 13 * DAY)), ['45'], 'nettoyage réel : on repart de zéro');
});

test('disque : remplissage rapide et soutenu (« sous 48 h ») : IMPORTANT sans son, jamais urgent tant que la base n’est pas en lecture seule', async () => {
  // 70 % au départ, 75 % à +12 h, 80 % à +24 h, un passage toutes les 10 minutes.
  const s = await simulate({ start: T0, runs: 145, site: (i) => disk(i < 72 ? 70 : i < 144 ? 75 : 80) });
  assert.equal(s.sent.length, 1, 'une seule ouverture : ni aggravation ni alerte sonore');
  assert.equal(s.sent[0].silent, true);
  assert.equal(s.state.incidents.disque.level, 'important');
  assert.match(s.state.incidents.disque.symptom, /plein \(95 %\) dans ≈ 1 j/);
});

test('disque : hystérésis, pas de yo-yo autour de 65 %', async () => {
  const s = await simulate({ start: T0, runs: 12, site: (i) => disk(i % 2 ? 60 : 65) });
  assert.equal(s.sent.length, 1, 'une ouverture, aucune clôture tant qu’on reste à ≥ 60 %');
});

test('disque : yo-yo 90 ↔ 85 % → un seul message, silencieux', async () => {
  const s = await simulate({ start: T0, runs: 36, site: (i) => disk(i % 2 ? 85 : 90) });
  assert.equal(s.sound.length, 0);
  assert.equal(s.silent.length, 1);
});

test('disque illisible pendant une alerte disque : pas de faux « s’améliore », cause distincte', async () => {
  const r1 = await run(disk(95));
  assert.equal(r1.calls.telegram[0].silent, false);
  const unreadable = { healthBody: { ...HEALTH_OK, disk_level: null, disk_pct: null } };
  const s = await simulate({ start: T0 + 10 * MIN, runs: 3, site: () => unreadable, prevState: r1.state });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].silent, true);
  assert.match(s.sent[0].text, /^🟠 IMPORTANT — Niveau du disque illisible/);
  assert.ok(s.state.incidents.disque, 'l’alerte disque reste ouverte telle quelle');
  const back = await run(disk(95), { prevState: s.state, nowMs: T0 + 40 * MIN });
  assert.equal(back.calls.telegram.filter((m) => !m.silent).length, 0, 'pas de nouvelle alerte sonore pour le même 95 %');
});

test('résolution : UN message RÉSOLU sans son après 1 h de retour à la normale, avec durée ET cause (dernier symptôme mesuré)', async () => {
  const r1 = await run(DOWN);
  const s = await simulate({ start: T0 + 10 * MIN, runs: 7, prevState: r1.state });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].i, 6, 'clos au 7e passage normal (1 h)');
  assert.equal(s.sent[0].silent, true);
  assert.equal(
    s.sent[0].text,
    '🟢 RÉSOLU — Base de données / API santé : 10 min (19.11 14:00 → 19.11 14:10 UTC).\nCause : HTTP 503, db_ok=false (3 essais à 20 s).',
  );
  assert.equal(lines(s.sent[0].text), 2);
});

test('résolution d’un incident IMPORTANT : même format, cause = dernier symptôme mesuré (le dernier, pas le premier)', async () => {
  const s = await simulate({
    start: T0, runs: 30,
    site: (i) => (i < 6 ? { healthBody: { ...HEALTH_OK, latest_capture: '2026-11-14', age_hours: 130 } } : i < 12 ? { healthBody: { ...HEALTH_OK, latest_capture: '2026-11-14', age_hours: 140 } } : {}),
  });
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[0].silent, true);
  assert.match(s.sent[0].text, /^🟠 IMPORTANT — Données de marché trop anciennes/);
  assert.equal(s.sent[1].silent, true);
  assert.match(s.sent[1].text, /^🟢 RÉSOLU — Fraîcheur des données de marché : 2 h \(19\.11 14:00 → 19.11 16:00 UTC\)\.\nCause : dernière capture 2026-11-14, âge 140 h/);
});

test('résolution sans symptôme enregistré : « non identifiée par la surveillance »', () => {
  const prev = {
    version: 2, incidents: { site: { level: 'important', panne: false, openedAt: T0, notifiedAt: T0, okSince: T0 + 10 * MIN } },
    pending: {}, diskSteps: {}, lastRunAt: T0 + 60 * MIN, heartbeatFails: 0,
  };
  const results = [{ id: 'A', status: 'ok', value: 'ok', health: {} }, { id: 'B', status: 'ok', value: 'ok' }, { id: 'C', status: 'ok', value: 'ok' }, { id: 'D', status: 'ok', value: 'ok', level: 'ok', pct: 50 }];
  const { messages } = planRun(prev, results, T0 + 70 * MIN, BASE_ENV);
  assert.equal(messages.length, 1);
  assert.match(messages[0].text, /\nCause : non identifiée par la surveillance\.$/);
});

test('même cause : base revenue mais page encore vide (cache) → pas de nouveau message', async () => {
  const s = await simulate({
    start: T0, runs: 12,
    site: (i) => (i === 0 ? { ...DOWN, pageHtml: EMPTY_HTML } : i < 3 ? { pageHtml: EMPTY_HTML } : {}),
  });
  assert.equal(s.sound.length, 1);
  assert.equal(s.silent.length, 1);
  assert.match(s.silent[0].text, /^🟢 RÉSOLU — Base de données/);
});

test('un problème revenu APRÈS son « résolu » est un nouvel incident : ouverture normale (sonore), sans étiquette « RÉCIDIVE »', async () => {
  const s = await simulate({ start: T0, runs: 50, site: (i) => (i === 0 || i === 8 ? DOWN : {}) });
  assert.equal(s.sound.length, 2, 'chaque panne ouvre normalement avec son');
  assert.equal(s.silent.length, 2, 'un RÉSOLU par panne');
  assert.ok(s.sent.every((m) => !/RÉCIDIVE|🔁/.test(m.text)));
  assert.match(s.sound[1].text, /^🔴 URGENT — Base de données ou \/api\/health injoignable/);
  assert.match(s.silent[0].text, /^🟢 RÉSOLU/);
  assert.match(s.silent[1].text, /^🟢 RÉSOLU/);
});

test('aucun rappel, aucune aggravation, aucun regroupement : même problème qui dure 3 jours, même s’il change de gravité interne', async () => {
  const s = await simulate({
    start: T0, runs: 3 * 144,
    site: (i) => disk(i < 100 ? 65 : i < 200 ? 85 : i < 300 ? 90 : 70),
  });
  assert.equal(s.sent.length, 1, 'un seul message d’ouverture, jamais de rappel ni d’aggravation ni d’amélioration');
  assert.ok(s.sent.every((m) => !/S’AGGRAVE|S’AMÉLIORE|TOUJOURS EN COURS|REGROUPÉ|RÉCIDIVE|🔕|🔁/.test(m.text)));
  assert.equal(s.sound.length, 0);
});

test('plusieurs pannes le même jour : chacune avec son, jamais de plafond ni de message « REGROUPÉ »', () => {
  const results = [
    { id: 'A', status: 'ok', value: 'ok', health: {} },
    { id: 'B', status: 'crit', value: 'données absentes : 0/8 cartes chiffrées, 8 « Aucune valeur actuelle »' },
    { id: 'C', status: 'ok', value: 'ok' },
    { id: 'D', status: 'crit', value: 'x', level: 'critique', pct: 95 },
    { id: 'P', status: 'crit', value: 'cockpit injoignable (erreur réseau)' },
  ];
  const prev = { version: 2, lastRunAt: T0 - 10 * MIN, sound: { day: '2026-11-19', count: 99 } };
  const { messages } = planRun(prev, results, T0, { ...BASE_ENV, PRINCIPAL_HEALTH_URL: 'https://cockpit.example/health' });
  assert.equal(messages.length, 3);
  assert.deepEqual(messages.map((m) => [m.key, m.sound]).sort(), [['disque', true], ['principal', false], ['site', true]]);
  assert.ok(messages.every((m) => !/REGROUPÉ|🔕/.test(m.text)));
});

test('un seul message URGENT après un IMPORTANT : le risque devenu panne, puis plus rien', async () => {
  const s = await simulate({
    start: T0, runs: 60,
    site: (i) => (i < 10 ? disk(70) : i < 20 ? disk(95) : i < 30 ? disk(90) : disk(95)),
  });
  assert.equal(s.sent.length, 2, 'ouverture IMPORTANT puis UN message URGENT, rien ensuite (ni retombée, ni nouvelle montée)');
  assert.equal(s.sent[0].silent, true);
  assert.match(s.sent[0].text, /^🟠 IMPORTANT — Disque/);
  assert.equal(s.sent[1].silent, false);
  assert.match(s.sent[1].text, /^🔴 URGENT — Disque/);
  assert.match(s.sent[1].text, /Depuis 19\.11 14:00 UTC/);
  assert.equal(s.sent[1].i, 10);
});

test('échec Telegram : job en échec, alerte renvoyée au passage suivant avec son heure d’origine, jeton jamais journalisé', async () => {
  const r = await run({ ...DOWN, telegramFails: true });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.state.incidents, {});
  const all = r.logs.join('\n');
  assert.match(all, /ÉCHEC de l'envoi Telegram : Telegram : HTTP 401 — Unauthorized/);
  assert.ok(!all.includes('TEST-TOKEN-NOT-REAL'));
  const r2 = await run(DOWN, { prevState: r.state, nowMs: T0 + 10 * MIN });
  assert.equal(r2.calls.telegram.length, 1);
  assert.match(r2.calls.telegram[0].text, /Depuis 19\.11 14:00 UTC/);
});

test('échec Telegram au moment de confirmer une anomalie : elle part au passage suivant', async () => {
  const r1 = await run({ pageHtml: PARTIAL_HTML });
  const r2 = await run({ pageHtml: PARTIAL_HTML, telegramFails: true }, { prevState: r1.state, nowMs: T0 + 10 * MIN });
  assert.equal(r2.exitCode, 1);
  const r3 = await run({ pageHtml: PARTIAL_HTML }, { prevState: r2.state, nowMs: T0 + 20 * MIN });
  assert.equal(r3.calls.telegram.length, 1);
  assert.match(r3.calls.telegram[0].text, /^🟠 IMPORTANT — Page publique incomplète/);
});

test('plus de message de test : WATCHDOG_TEST est sans effet', async () => {
  const r = await run({}, { env: { WATCHDOG_TEST: 'true' } });
  assert.equal(r.calls.telegram.length, 0);
});

test('preuve de vie : arrêt > 2 h signalé en silencieux à la reprise (renvoyé si Telegram échoue) ; 70 min : rien', async () => {
  const r1 = await run({});
  const fail = await run({ telegramFails: true }, { prevState: r1.state, nowMs: T0 + 3 * H });
  assert.equal(fail.exitCode, 1);
  const r2 = await run({}, { prevState: fail.state, nowMs: T0 + 3 * H + 10 * MIN });
  assert.equal(r2.calls.telegram.length, 1);
  assert.equal(r2.calls.telegram[0].silent, true);
  assert.match(r2.calls.telegram[0].text, /^🟠 IMPORTANT — Le watchdog n’a pas tourné pendant 3 h \(du 19\.11 14:00 UTC au 19\.11 17:00 UTC\)/);
  const r3 = await run({}, { prevState: r2.state, nowMs: T0 + 4 * H + 20 * MIN });
  assert.equal(r3.calls.telegram.length, 0, '70 min : rien');
});

test('preuve de vie : contrôleur externe pingé à chaque passage ; muet 3 fois → IMPORTANT sans son (un risque) ; revenu → RÉSOLU', async () => {
  const ok = await run({}, { env: HB_ENV });
  assert.deepEqual(ok.calls.pings, ['/uuid-de-test']);
  const down = await simulate({ start: T0 + 10 * MIN, runs: 4, env: HB_ENV, prevState: ok.state, site: () => ({ heartbeatDown: true }) });
  assert.equal(down.sent.length, 1);
  assert.equal(down.sent[0].silent, true);
  assert.match(down.sent[0].text, /^🟠 IMPORTANT — Le contrôleur de vie du watchdog ne répond plus/);
  const back = await simulate({ start: T0 + 50 * MIN, runs: 9, env: HB_ENV, prevState: down.state });
  assert.equal(back.sent.length, 1);
  assert.match(back.sent[0].text, /^🟢 RÉSOLU — Contrôleur de vie du watchdog : .*\nCause : 4 signaux de vie refusés\./);
  const fail = await run({ ...DOWN, telegramFails: true }, { env: HB_ENV });
  assert.deepEqual(fail.calls.pings, ['/uuid-de-test/fail'], 'Telegram en panne : le contrôleur externe est prévenu');
});

test('état illisible ou tronqué : complété ou repris à zéro sans planter ; anciens champs et anciennes causes écartés sans message', async () => {
  const r = await run({}, { prevState: { version: 2, incidents: null, period: 'x' } });
  assert.equal(r.exitCode, 0);
  assert.equal(r.calls.telegram.length, 0);
  assert.equal(normalizeState('corrompu').version, 2);
  const vieux = normalizeState({
    version: 2, sound: { day: 'x', count: 3 }, period: { since: 1 }, closed: { site: {} }, lastWeeklyKey: '2026-11-16',
    incidents: { telegram_cockpit: { level: 'important', openedAt: 1, okSince: 2 }, site: { level: 'important', openedAt: 1, okSince: null } },
    pending: { telegram_cockpit: { seen: 1, first: 1 } },
  });
  assert.deepEqual(Object.keys(vieux.incidents), ['site']);
  assert.deepEqual(vieux.pending, {});
  for (const k of ['sound', 'period', 'closed', 'lastWeeklyKey']) assert.ok(!(k in vieux), k);
  const res = await run({}, { prevState: { version: 2, incidents: { telegram_cockpit: { level: 'important', openedAt: 1, okSince: 2 } } } });
  assert.equal(res.calls.telegram.length, 0, 'ancien incident « telegram_cockpit » : jamais de « résolu » orphelin');
});

// ───────────────────────────── banc d'essai : bruit ─────────────────────────────

test('BANC — semaine sans incident : AUCUN message (plus de résumé du lundi : le bilan est celui du cockpit)', async () => {
  const s = await simulate({ start: TUE_17_MIDNIGHT_CH, runs: 7 * 144, env: HB_ENV });
  assert.equal(s.sent.length, 0);
  assert.equal(s.pings, 7 * 144, 'un signal de vie par passage');
  assert.equal(s.failedRuns, 0);
});

test('BANC — même semaine sans contrôleur de vie, avec 2 retards du déclencheur de 70 min : toujours aucun message', async () => {
  const s = await simulate({ start: TUE_17_MIDNIGHT_CH, runs: 7 * 144, skip: (i) => (i > 200 && i < 207) || (i > 600 && i < 607) });
  assert.equal(s.sent.length, 0);
});

test('BANC — panne de 2 h : 1 sonore (ouverture) + 1 silencieux (clôture)', async () => {
  const s = await simulate({ start: T0, runs: 30, site: (i) => (i >= 3 && i < 15 ? { ...DOWN, pageHtml: EMPTY_HTML } : {}) });
  assert.equal(s.sound.length, 1);
  assert.equal(s.silent.length, 1);
  assert.match(s.silent[0].text, /^🟢 RÉSOLU — .* : 2 h \(/);
});

test('BANC — panne de 14 h : aucune répétition, 1 sonore + 1 silencieux', async () => {
  const s = await simulate({ start: T0, runs: 100, site: (i) => (i >= 2 && i < 86 ? DOWN : {}) });
  assert.equal(s.sound.length, 1);
  assert.equal(s.silent.length, 1);
  assert.match(s.silent[0].text, /^🟢 RÉSOLU — .* : 14 h \(/);
});

test('BANC — panne en yo-yo pendant 3 h (KO/OK à chaque passage) : 1 sonore + 1 silencieux', async () => {
  const s = await simulate({ start: T0, runs: 24, site: (i) => (i < 18 && i % 2 === 0 ? DOWN : {}) });
  assert.equal(s.sound.length, 1);
  assert.equal(s.silent.length, 1);
});

test('BANC — yo-yo KO, OK, OK pendant 24 h : 1 sonore + 1 silencieux (et non 48 + 48)', async () => {
  const s = await simulate({ start: T0, runs: 144 + 7, site: (i) => (i < 144 && i % 3 === 0 ? DOWN : {}) });
  assert.equal(s.sound.length, 1);
  assert.equal(s.silent.length, 1);
});

test('BANC — yo-yo page vide un passage sur trois pendant 24 h : 1 sonore + 1 silencieux', async () => {
  const s = await simulate({ start: T0, runs: 144 + 7, site: (i) => (i < 144 && i % 3 === 0 ? { pageHtml: EMPTY_HTML } : {}) });
  assert.equal(s.sound.length, 1);
  assert.equal(s.silent.length, 1);
});

test('BANC — anomalie importante en yo-yo (2 mauvais, 2 bons) pendant 24 h : 2 silencieux (et non 72)', async () => {
  const s = await simulate({ start: T0, runs: 144 + 7, site: (i) => (i < 144 && i % 4 < 2 ? { pageHtml: PARTIAL_HTML } : {}) });
  assert.equal(s.sound.length, 0);
  assert.equal(s.silent.length, 2);
});

test('BANC — scraper en retard 3 jours puis reparti : 0 sonore, 2 silencieux (ouverture + RÉSOLU)', async () => {
  const s = await simulate({
    start: T0, runs: 4 * 144,
    site: (i) => ({ healthBody: { ...HEALTH_OK, age_hours: i < 3 * 144 ? 130 + i / 6 : 10 } }),
  });
  assert.equal(s.sound.length, 0);
  assert.equal(s.silent.length, 2);
});

test('BANC — à-coup d’une nuit de scraping (60 → 70 % en 1 h) puis plat : 0 sonore, 1 silencieux', async () => {
  // Jeudi 19.11 : 65 % à 03:30, 70 % à 04:30 (heure suisse), puis plus rien pendant la semaine.
  const s = await simulate({
    start: TUE_17_MIDNIGHT_CH, runs: 7 * 144,
    site: (i) => disk(i < 2 * 144 + 21 ? 60 : i < 2 * 144 + 27 ? 65 : 70),
  });
  assert.equal(s.sound.length, 0);
  assert.equal(s.silent.length, 1);
  assert.match(s.silent[0].text, /^🟠 IMPORTANT — Disque de la base ≈ 65 % de 18 GB\./);
});

test('BANC — disque qui monte de 50 à 92 % en 3 semaines : AUCUN message sonore, 1 seul silencieux', async () => {
  const runs = 21 * 144;
  const mont = (top) => (i) => {
    const exact = 50 + ((top - 50) * i) / runs;
    const pct = Math.floor(exact / 5) * 5;
    const lvl = exact >= 80 ? 'critique' : exact >= 65 ? 'avertissement' : 'ok';
    return { healthBody: { ...HEALTH_OK, disk_level: lvl, disk_pct: pct } };
  };
  const s = await simulate({ start: TUE_17_MIDNIGHT_CH, runs, site: mont(92) });
  assert.equal(s.sound.length, 0, 'même « sous 48 h » : un risque, pas une panne');
  assert.equal(s.silent.length, 1);
});

test('BANC — disque qui atteint 95 % (lecture seule) : 1 silencieux (risque) puis 1 sonore (panne), rien d’autre', async () => {
  const runs = 21 * 144;
  const s = await simulate({
    start: TUE_17_MIDNIGHT_CH, runs,
    site: (i) => {
      const exact = 50 + (46 * i) / runs;
      const pct = Math.floor(exact / 5) * 5;
      const lvl = exact >= 80 ? 'critique' : exact >= 65 ? 'avertissement' : 'ok';
      return { healthBody: { ...HEALTH_OK, disk_level: lvl, disk_pct: pct } };
    },
  });
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[0].silent, true);
  assert.equal(s.sent[1].silent, false);
});

test('format : tout message d’incident tient en 3 lignes au plus', async () => {
  const s = await simulate({
    start: T0, runs: 40,
    site: (i) => (i < 5 ? DOWN : i < 10 ? { pageHtml: PARTIAL_HTML } : i < 20 ? disk(90) : {}),
  });
  assert.ok(s.sent.length >= 3);
  for (const m of s.sent) assert.ok(lines(m.text) <= 3, m.text);
});

test('configuration : seuils documentés', () => {
  assert.equal(CONFIG.freshnessMaxHours, 120);
  assert.equal(CONFIG.healthAttempts, 3);
  assert.equal(CONFIG.retryDelayMs, 20_000);
  for (const k of ['soundCapPerDay', 'renotifyMs', 'weeklyHourZurich', 'recurrenceWindowMs', 'downgradeAfterRuns', 'diskUrgentPct']) {
    assert.ok(!(k in CONFIG), `${k} supprimé (règle Telegram du 23.11)`);
  }
  assert.equal(CONFIG.diskReadOnlyPct, 95);
});

// ───────────────────────────── mode secours (21.11.2026) ─────────────────────────────
// La surveillance principale tourne dans le cockpit et publie son signe de vie sur /health.
// Le workflow GitHub n'est plus que le secours : il lit ce signe de vie quand il passe.

const SECOURS_ENV = { PRINCIPAL_HEALTH_URL: 'https://cockpit.example/health' };
const vivant = (ms) => ({ status: 'ok', surveillance_site: { actif: true, dernier_passage: new Date(ms).toISOString(), passages_recents: [] } });

test('SECOURS — cockpit vivant : aucun contrôle du site, aucun message', async () => {
  const r = await run({ principal: vivant(T0 - 3 * MIN) }, { env: SECOURS_ENV });
  assert.equal(r.calls.principal, 1);
  assert.equal(r.calls.health, 0, 'le site n’est pas contrôlé ici : le cockpit le fait');
  assert.equal(r.calls.page, 0);
  assert.equal(r.calls.telegram.length, 0);
  assert.equal(r.byId.P.status, 'ok');
});

test('SECOURS — chaque passage se signale au cockpit (?secours=1)', async () => {
  const r = await run({ principal: vivant(T0 - 3 * MIN) }, { env: SECOURS_ENV });
  assert.equal(r.calls.principalSecours, '1');
  const { urlSecours } = await import('./watchdog.mjs');
  assert.equal(urlSecours('https://c.example/health?x=2'), 'https://c.example/health?x=2&secours=1');
  assert.equal(urlSecours('pas une url'), 'pas une url');
});

test('SECOURS — cockpit muet depuis 40 min : alerte IMPORTANTE sans son (la surveillance est en panne, pas le site) + le secours fait les contrôles', async () => {
  const r = await run({ principal: vivant(T0 - 40 * MIN) }, { env: SECOURS_ENV });
  assert.ok(r.calls.health >= 1, 'le secours contrôle le site lui-même');
  assert.equal(r.calls.telegram.length, 1);
  assert.equal(r.calls.telegram[0].silent, true);
  assert.match(r.calls.telegram[0].text, /^🟠 IMPORTANT — La surveillance principale \(cockpit\) ne tourne plus : dernier passage il y a 40 min/);
  assert.match(r.calls.telegram[0].text, /\nAction : Railway → service admin-backend/);
});

test('SECOURS — cockpit injoignable, ou joignable sans signe de vie : alerte', async () => {
  const a = await run({ principalThrows: true }, { env: SECOURS_ENV });
  assert.match(a.calls.telegram[0].text, /ne tourne plus : cockpit injoignable \(erreur réseau\)/);
  const b = await run({ principal: { status: 'ok' } }, { env: SECOURS_ENV });
  assert.match(b.calls.telegram[0].text, /sans signe de vie de la surveillance/);
  const c = await run({ principal: { status: 'ok', surveillance_site: { actif: false, dernier_passage: null } } }, { env: SECOURS_ENV });
  assert.match(c.calls.telegram[0].text, /surveillance désactivée dans le cockpit/);
});

test('SECOURS — cockpit arrêté ET base en panne : deux causes, deux messages (la panne seule sonne)', async () => {
  const r = await run({ ...DOWN, principal: vivant(T0 - 2 * H) }, { env: SECOURS_ENV });
  assert.equal(r.calls.telegram.length, 2);
  assert.ok(r.calls.telegram.some((m) => /^🟠 IMPORTANT — La surveillance principale/.test(m.text) && m.silent));
  assert.ok(r.calls.telegram.some((m) => /^🔴 URGENT — Base de données ou \/api\/health injoignable/.test(m.text) && !m.silent));
});

test('SECOURS — le cockpit revient : passation silencieuse, RÉSOLU silencieux 1 h plus tard', async () => {
  const mort = await run({ ...DOWN, principal: vivant(T0 - 2 * H) }, { env: SECOURS_ENV });
  assert.equal(mort.calls.telegram.length, 2);
  const retour = await run({ ...DOWN, principal: vivant(T0 + 3 * H - MIN) }, { env: SECOURS_ENV, prevState: mort.state, nowMs: T0 + 3 * H });
  assert.equal(retour.calls.telegram.length, 0, 'cockpit vivant : la base en panne est son affaire, pas de doublon');
  assert.equal(retour.state.incidents.base, undefined, 'incident du site rendu au cockpit');
  const plusTard = await run({ principal: vivant(T0 + 5 * H - MIN) }, { env: SECOURS_ENV, prevState: retour.state, nowMs: T0 + 5 * H });
  assert.equal(plusTard.calls.telegram.length, 1);
  assert.equal(plusTard.calls.telegram[0].silent, true);
  assert.match(plusTard.calls.telegram[0].text, /^🟢 RÉSOLU — Surveillance principale \(cockpit\) : .*\nCause : dernier passage il y a 2 h/);
});

test('SECOURS — ni bilan du lundi ni message « n’a pas tourné » (le secours passe rarement, c’est normal)', async () => {
  const r1 = await run({ principal: vivant(T0 - MIN) }, { env: SECOURS_ENV, nowMs: T0 });
  const lundi = Date.UTC(2026, 10, 23, 7, 0); // lundi 08:00 heure suisse, 3 jours plus tard
  const r2 = await run({ principal: vivant(lundi - MIN) }, { env: SECOURS_ENV, prevState: r1.state, nowMs: lundi });
  assert.equal(r2.calls.telegram.length, 0);
});

// ───────────────────────────── boîte d'alertes du cockpit (relève OIDC) ─────────────────────────────

const OIDC_ENV = {
  ...SECOURS_ENV,
  ACTIONS_ID_TOKEN_REQUEST_URL: 'https://oidc.example/token?api-version=2.0',
  ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'REQUEST-TOKEN-SECRET',
};
const JWT = 'JWT.SECRET.VALUE';
const bx = (id, texte, sonner = false) => ({ id, cree_le: '2026-11-22T18:05:00Z', sonner, texte });
const boiteOk = (messages) => ({ status: 200, body: { boot: 'a1b2c3d4', en_attente: messages.length, messages } });

/** Faux réseau avec jeton OIDC et boîte du cockpit. `o` : { boite, ack, tokenStatus, site }. */
async function runBoite(o = {}, { env = OIDC_ENV, prevState = null, nowMs = T0 } = {}) {
  const base = fakeNet({ principal: vivant(nowMs - MIN), ...(o.site ?? {}) });
  const seen = { tokenUrl: null, tokenAuth: null, boiteAuth: null, acks: [], order: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'oidc.example') {
      seen.tokenUrl = url;
      seen.tokenAuth = init.headers?.Authorization;
      if (o.tokenStatus && o.tokenStatus !== 200) return jsonRes(o.tokenStatus, {});
      return jsonRes(200, { value: JWT });
    }
    if (u.hostname === 'cockpit.example' && u.pathname === '/health/boite') {
      seen.boiteAuth = init.headers?.Authorization;
      seen.order.push('releve');
      const b = o.boite ?? boiteOk([]);
      if (b.throws) throw Object.assign(new Error('x'), { name: 'TypeError' });
      if (b.badJson) return { status: b.status ?? 200, json: async () => { throw new Error('bad'); } };
      return jsonRes(b.status, b.body ?? {});
    }
    if (u.hostname === 'cockpit.example' && u.pathname === '/health/boite/acquitter') {
      assert.equal(init.method, 'POST');
      assert.equal(init.headers.Authorization, `Bearer ${JWT}`);
      const body = JSON.parse(init.body);
      seen.acks.push(body);
      seen.order.push('ack');
      return jsonRes(o.ack?.status ?? 200, { acquittes: body.ids.length });
    }
    return base.fetchImpl(url, init);
  };
  const logs = [];
  const out = await runOnce({
    fetchImpl, sleep: async () => {}, env: { ...BASE_ENV, ...env },
    prevState: prevState === null ? null : JSON.parse(JSON.stringify(prevState)), nowMs, log: (l) => logs.push(l),
  });
  return { ...out, state: JSON.parse(JSON.stringify(out.stateToWrite)), calls: base.calls, seen, logs };
}

test('BOÎTE — jeton OIDC demandé avec l’audience, livraison du plus ancien au plus récent, son selon `sonner`, puis acquittement', async () => {
  const r = await runBoite({ boite: boiteOk([bx(8, 'deuxième', false), bx(7, 'premier', true)]) });
  assert.match(r.seen.tokenUrl, /^https:\/\/oidc\.example\/token\?api-version=2\.0&audience=mulklick-cockpit-boite$/);
  assert.equal(r.seen.tokenAuth, 'bearer REQUEST-TOKEN-SECRET');
  assert.equal(r.seen.boiteAuth, `Bearer ${JWT}`);
  assert.deepEqual(r.calls.telegram.map((m) => [m.text, m.silent]), [['premier', false], ['deuxième', true]]);
  assert.deepEqual(r.seen.acks, [{ boot: 'a1b2c3d4', ids: [7, 8] }]);
  assert.deepEqual(r.seen.order, ['releve', 'ack']);
  assert.equal(r.exitCode, 0);
  assert.ok(r.logs.includes('Boîte : 2 relevé(s), 2 livré(s), 2 acquitté(s)'));
  assert.equal(r.calls.health + r.calls.page, 0, 'boîte relevée : aucun contrôle du site par le relais');
});

test('BOÎTE — au plus 5 messages par passage, le reste attend', async () => {
  const msgs = [1, 2, 3, 4, 5, 6, 7].map((i) => bx(i, `m${i}`, true));
  const r = await runBoite({ boite: boiteOk(msgs) });
  assert.equal(r.calls.telegram.length, 5);
  assert.deepEqual(r.seen.acks[0].ids, [1, 2, 3, 4, 5]);
  assert.ok(r.logs.includes('Boîte : 7 relevé(s), 5 livré(s), 5 acquitté(s)'));
});

test('BOÎTE — échec d’envoi en cours de route : on s’arrête, seuls les messages partis sont acquittés, le job échoue', async () => {
  const base = fakeNet({ principal: vivant(T0 - MIN) });
  let sends = 0;
  const acks = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'oidc.example') return jsonRes(200, { value: JWT });
    if (u.pathname === '/health/boite') return jsonRes(200, { boot: 'b', en_attente: 3, messages: [bx(1, 'a'), bx(2, 'b'), bx(3, 'c')] });
    if (u.pathname === '/health/boite/acquitter') { acks.push(JSON.parse(init.body)); return jsonRes(200, { acquittes: 1 }); }
    if (u.hostname === 'api.telegram.org') {
      sends += 1;
      if (sends === 2) return jsonRes(500, { ok: false, description: 'Internal' });
    }
    return base.fetchImpl(url, init);
  };
  const out = await runOnce({ fetchImpl, sleep: async () => {}, env: { ...BASE_ENV, ...OIDC_ENV }, prevState: null, nowMs: T0, log: () => {} });
  assert.equal(sends, 2, 'arrêt au premier échec');
  assert.deepEqual(acks, [{ boot: 'b', ids: [1] }]);
  assert.equal(out.exitCode, 1);
});

test('BOÎTE — 404 (fonction pas encore déployée) : aucun incident, les contrôles A à D sont faits par le relais', async () => {
  const r = await runBoite({ boite: { status: 404, body: {} } });
  assert.equal(r.calls.health, 1);
  assert.equal(r.calls.page, 1);
  assert.deepEqual(r.calls.telegram, []);
  assert.equal(r.state.incidents.boite, undefined);
  assert.equal(r.state.pending.boite, undefined);
  // …et un site en panne est alors annoncé par ce bot, avec son.
  const down = await runBoite({ boite: { status: 404, body: {} }, site: DOWN });
  assert.equal(down.calls.telegram.length, 1);
  assert.equal(down.calls.telegram[0].silent, false);
  assert.match(down.calls.telegram[0].text, /Base de données ou \/api\/health injoignable/);
  assert.equal(down.exitCode, 0);
});

for (const [nom, boite] of [
  ['401', { status: 401, body: { detail: 'refuse' } }],
  ['500', { status: 500, body: {} }],
  ['réseau', { throws: true }],
  ['JSON illisible', { status: 200, badJson: true }],
  ['forme inattendue', { status: 200, body: { boot: 'x' } }],
]) {
  test(`BOÎTE — ${nom} : incident « boîte » (confirmé sur 2 passages, silencieux, une fois) et contrôles A à D par le relais`, async () => {
    const r1 = await runBoite({ boite }, { nowMs: T0 });
    assert.equal(r1.calls.health, 1, 'contrôles du site faits');
    assert.equal(r1.calls.telegram.length, 0, 'première constatation : pas encore de message');
    const r2 = await runBoite({ boite }, { prevState: r1.state, nowMs: T0 + 10 * MIN });
    assert.equal(r2.calls.telegram.length, 1);
    assert.equal(r2.calls.telegram[0].silent, true);
    assert.match(r2.calls.telegram[0].text, /^🟠 IMPORTANT — Les alertes du cockpit ne te parviennent plus/);
    assert.match(r2.calls.telegram[0].text, /le relais refait lui-même les contrôles du site/);
    assert.ok(lines(r2.calls.telegram[0].text) <= 3);
    const r3 = await runBoite({ boite }, { prevState: r2.state, nowMs: T0 + 20 * MIN });
    assert.equal(r3.calls.telegram.length, 0, 'une seule fois');
    // Boîte de nouveau lisible : clôture silencieuse après 1 h.
    const ok = await runBoite({ boite: boiteOk([]) }, { prevState: r3.state, nowMs: T0 + 30 * MIN });
    assert.equal(ok.calls.telegram.length, 0);
    const clos = await runBoite({ boite: boiteOk([]) }, { prevState: ok.state, nowMs: T0 + 100 * MIN });
    assert.equal(clos.calls.telegram.length, 1);
    assert.match(clos.calls.telegram[0].text, /^🟢 RÉSOLU — Boîte d’alertes du cockpit : .*\nCause : /);
  });
}

test('BOÎTE — jeton OIDC refusé par GitHub : même repli', async () => {
  const r = await runBoite({ tokenStatus: 403 });
  assert.equal(r.calls.health, 1);
  assert.equal(r.seen.boiteAuth, null);
  assert.ok(r.state.pending.boite);
});

test('BOÎTE — acquittement refusé : incident (les messages seraient relivrés en double), pas d’arrêt', async () => {
  const r = await runBoite({ boite: boiteOk([bx(1, 'a')]), ack: { status: 401 } });
  assert.equal(r.calls.telegram.length, 1);
  assert.ok(r.state.pending.boite);
  assert.ok(r.logs.includes('Boîte : 1 relevé(s), 1 livré(s), 0 acquitté(s) (acquittement refusé)'));
});

test('BOÎTE — cockpit arrêté : comportement historique, aucun appel à la boîte, pas de doublon « boîte »', async () => {
  const r = await runBoite({ site: { principal: vivant(T0 - 2 * H) } });
  assert.equal(r.seen.tokenUrl, null);
  assert.equal(r.seen.boiteAuth, null);
  assert.equal(r.calls.telegram.length, 1);
  assert.match(r.calls.telegram[0].text, /surveillance principale/);
  assert.equal(r.state.pending.boite, undefined);
});

test('BOÎTE — sans PRINCIPAL_HEALTH_URL ou sans variables OIDC : mode historique, aucune relève', async () => {
  const sansOidc = await runBoite({}, { env: SECOURS_ENV });
  assert.equal(sansOidc.seen.tokenUrl, null);
  assert.equal(sansOidc.calls.health + sansOidc.calls.page, 0, 'cockpit vivant : le secours se tait');
  assert.deepEqual(sansOidc.calls.telegram, []);
  const sansUrl = await runBoite({}, { env: { ACTIONS_ID_TOKEN_REQUEST_URL: OIDC_ENV.ACTIONS_ID_TOKEN_REQUEST_URL, ACTIONS_ID_TOKEN_REQUEST_TOKEN: 'x' } });
  assert.equal(sansUrl.seen.tokenUrl, null);
});

test('BOÎTE — dans GitHub Actions sans jeton OIDC : pas d’incident, mais les contrôles A à D sont faits (jamais le silence)', async () => {
  const r = await runBoite({}, { env: { ...SECOURS_ENV, GITHUB_ACTIONS: 'true' } });
  assert.equal(r.seen.tokenUrl, null);
  assert.equal(r.calls.health, 1);
  assert.equal(r.calls.page, 1);
  assert.deepEqual(r.calls.telegram, []);
  assert.equal(r.state.incidents.boite, undefined);
  const down = await runBoite({ site: DOWN }, { env: { ...SECOURS_ENV, GITHUB_ACTIONS: 'true' } });
  assert.equal(down.calls.telegram.length, 1);
  assert.equal(down.calls.telegram[0].silent, false);
});

const direct = (d, plusAncien = null, now = T0) => ({ ...vivant(now - MIN), telegram: { direct: d, boite: { active: true, en_attente: 0, plus_ancien: plusAncien } } });

test('TELEGRAM COCKPIT — l’échec du bot direct du cockpit ne produit plus aucun message (ni ouverture, ni résolu) : une ligne de journal sans texte sensible', async () => {
  const echec = new Date(T0 - 40 * MIN).toISOString();
  const d = { configure: true, dernier_ok: new Date(T0 - 3 * H).toISOString(), dernier_echec: echec, dernier_echec_detail: 'HTTP 403 — Forbidden: bot was blocked by the user bot123456:AAA-bbb_CCC' };
  const r1 = await runBoite({ site: { principal: direct(d) } });
  assert.equal(r1.calls.telegram.length, 0);
  assert.equal(r1.state.incidents.telegram_cockpit, undefined);
  assert.equal(r1.state.pending.telegram_cockpit, undefined);
  const ligne = r1.logs.find((l) => l.startsWith('[T]'));
  assert.match(ligne, /^\[T\] WARN — envoi direct du cockpit : échec en cours/);
  const all = r1.logs.join('\n') + JSON.stringify(r1.results.map(({ health, ...x }) => x));
  assert.ok(!all.includes('Forbidden') && !all.includes('bot123456'), 'ni description d’erreur ni jeton dans le journal');
  const r2 = await runBoite({ site: { principal: direct(d, null, T0 + 10 * MIN) } }, { prevState: r1.state, nowMs: T0 + 10 * MIN });
  assert.equal(r2.calls.telegram.length, 0);
  const bon = { ...d, dernier_ok: new Date(T0 + 15 * MIN).toISOString() };
  const r3 = await runBoite({ site: { principal: direct(bon, null, T0 + 90 * MIN) } }, { prevState: r2.state, nowMs: T0 + 90 * MIN });
  assert.equal(r3.calls.telegram.length, 0, 'pas de « résolu » non plus');
  const calme = await runBoite({ site: { principal: direct({ configure: true, dernier_ok: null, dernier_echec: null }) } });
  assert.equal(calme.calls.telegram.length, 0);
});

test('BOÎTE — plus ancien message du cockpit de plus de 30 min alors que le relais n’a rien relevé : incident « boîte »', async () => {
  const sain = { configure: true, dernier_ok: new Date(T0).toISOString(), dernier_echec: null };
  const ancien = (min) => direct(sain, new Date(T0 - min * MIN).toISOString());
  // Sans jeton OIDC (lancement local ou manuel) : rien n’est relevé, mais /health dit que la boîte stagne.
  const r1 = await runBoite({ site: { principal: ancien(45) } }, { env: SECOURS_ENV, nowMs: T0 });
  const r2 = await runBoite({ site: { principal: ancien(55) } }, { env: SECOURS_ENV, prevState: r1.state, nowMs: T0 + 10 * MIN });
  assert.equal(r2.calls.telegram.length, 1);
  assert.match(r2.calls.telegram[0].text, /^🟠 IMPORTANT — Les alertes du cockpit ne te parviennent plus/);
  assert.equal(r2.calls.health + r2.calls.page, 0, 'pas de repli : la boîte n’a pas été tentée');
  // Récent (10 min) : rien.
  const r3 = await runBoite({ site: { principal: ancien(10) } }, { env: SECOURS_ENV });
  assert.equal(r3.state.pending.boite, undefined);
});

test('BOÎTE — journaux publics : ni jeton, ni texte d’alerte, ni corps de réponse', async () => {
  const secret = 'TEXTE-ALERTE-CONFIDENTIEL';
  const cas = [
    await runBoite({ boite: boiteOk([bx(1, secret, true)]) }),
    await runBoite({ boite: { status: 500, body: { detail: secret } } }),
    await runBoite({ boite: { status: 200, badJson: true } }),
    await runBoite({ boite: boiteOk([bx(1, secret)]), ack: { status: 401 } }),
  ];
  for (const r of cas) {
    const all = r.logs.join('\n') + JSON.stringify(r.results.map(({ health, ...x }) => x));
    for (const interdit of [secret, JWT, 'REQUEST-TOKEN-SECRET', BASE_ENV.TELEGRAM_BOT_TOKEN, 'a1b2c3d4']) {
      assert.ok(!all.includes(interdit), `fuite dans le journal : ${interdit}`);
    }
  }
});
