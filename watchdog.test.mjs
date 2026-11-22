// Tests du watchdog avec réponses simulées. AUCUN appel réseau réel : chaque contrôle reçoit un
// faux fetch qui répond selon l'URL et lève une erreur sur toute URL inconnue. Les appels à
// api.telegram.org sont interceptés et enregistrés (avec leur caractère sonore ou silencieux),
// jamais émis. Le « banc d'essai » en fin de fichier simule des semaines entières, un passage
// toutes les 10 minutes, et compte les messages sonores et silencieux.
//   node --test watchdog.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce, planRun, zurichNow, weekKey, projectDiskDays, updateDiskSteps, normalizeState, CONFIG, checkPage } from './watchdog.mjs';

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
const T0 = Date.UTC(2026, 10, 19, 14, 0); // jeu. 19.11.2026 14:00 UTC (15:00 heure suisse)
const TUE_17_MIDNIGHT_CH = Date.UTC(2026, 10, 16, 23, 0); // mar. 17.11.2026 00:00 heure suisse
const MON_23_0800_CH = Date.UTC(2026, 10, 23, 7, 0); // lun. 23.11.2026 08:00 heure suisse

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
const notWeekly = (msgs) => msgs.filter((m) => !m.text.startsWith('📋'));

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

test('disque : 70 % IMPORTANT silencieux, 85 % s’aggrave (silencieux), 90 % URGENT sonore', async () => {
  const r1 = await run(disk(70));
  assert.equal(r1.calls.telegram.length, 1);
  assert.equal(r1.calls.telegram[0].silent, true);
  assert.match(r1.calls.telegram[0].text, /^🟠 IMPORTANT — Disque de la base ≈ 70 % de 18 GB\./);
  const r2 = await run(disk(85), { prevState: r1.state, nowMs: T0 + 10 * MIN });
  assert.equal(r2.calls.telegram.length, 1);
  assert.equal(r2.calls.telegram[0].silent, true);
  assert.match(r2.calls.telegram[0].text, /^🟠 IMPORTANT — S’AGGRAVE : Disque de la base ≈ 85 %/);
  const r3 = await run(disk(90), { prevState: r2.state, nowMs: T0 + 20 * MIN });
  assert.equal(r3.calls.telegram.length, 1);
  assert.equal(r3.calls.telegram[0].silent, false);
  assert.match(r3.calls.telegram[0].text, /^🔴 URGENT — S’AGGRAVE : Disque de la base ≈ 90 %/);
  assert.match(r3.calls.telegram[0].text, /risque sous 48 h/);
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

test('disque : remplissage rapide et soutenu → URGENT avant même 90 %', async () => {
  // 70 % au départ, 75 % à +12 h, 80 % à +24 h, un passage toutes les 10 minutes.
  const s = await simulate({ start: T0, runs: 145, site: (i) => disk(i < 72 ? 70 : i < 144 ? 75 : 80) });
  assert.equal(s.sent.length, 2);
  assert.equal(s.sent[0].silent, true, 'ouverture à 70 % : important');
  assert.equal(s.sent[1].silent, false);
  assert.match(s.sent[1].text, /^🔴 URGENT — S’AGGRAVE : Disque de la base ≈ 80 % de 18 GB, plein \(95 %\) dans ≈ 1 j/);
});

test('disque : hystérésis, pas de yo-yo autour de 65 %', async () => {
  const s = await simulate({ start: T0, runs: 12, site: (i) => disk(i % 2 ? 60 : 65) });
  assert.equal(s.sent.length, 1, 'une ouverture, aucune clôture tant qu’on reste à ≥ 60 %');
});

test('disque : yo-yo 90 ↔ 85 % → une seule alerte sonore', async () => {
  const s = await simulate({ start: T0, runs: 36, site: (i) => disk(i % 2 ? 85 : 90) });
  assert.equal(s.sound.length, 1);
  assert.equal(s.silent.length, 0);
});

test('disque illisible pendant une alerte disque : pas de faux « s’améliore », cause distincte', async () => {
  const r1 = await run(disk(90));
  assert.equal(r1.calls.telegram[0].silent, false);
  const unreadable = { healthBody: { ...HEALTH_OK, disk_level: null, disk_pct: null } };
  const s = await simulate({ start: T0 + 10 * MIN, runs: 3, site: () => unreadable, prevState: r1.state });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].silent, true);
  assert.match(s.sent[0].text, /^🟠 IMPORTANT — Niveau du disque illisible/);
  assert.ok(s.state.incidents.disque, 'l’alerte disque reste ouverte telle quelle');
  const back = await run(disk(90), { prevState: s.state, nowMs: T0 + 40 * MIN });
  assert.equal(back.calls.telegram.filter((m) => !m.silent).length, 0, 'pas de nouvelle alerte sonore pour le même 90 %');
});

test('résolution : message silencieux après 1 h de retour à la normale', async () => {
  const r1 = await run(DOWN);
  const s = await simulate({ start: T0 + 10 * MIN, runs: 7, prevState: r1.state });
  assert.equal(s.sent.length, 1);
  assert.equal(s.sent[0].i, 6, 'clos au 7e passage normal (1 h)');
  assert.equal(s.sent[0].silent, true);
  assert.match(s.sent[0].text, /^🟢 RÉSOLU — Base de données \/ API santé : revenu à la normale le 19\.11 14:10 UTC, après 10 min\./);
  assert.ok(lines(s.sent[0].text) <= 3);
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

test('récidive : un problème revenu < 6 h après sa clôture → un seul message silencieux', async () => {
  const s = await simulate({ start: T0, runs: 50, site: (i) => (i === 0 || i === 8 ? DOWN : {}) });
  assert.equal(s.sound.length, 1, 'seule la première panne sonne');
  assert.equal(s.silent.length, 3, 'clôture, récidive, clôture finale');
  assert.match(s.silent[1].text, /^🔁 URGENT — RÉCIDIVE : Base de données/);
  assert.equal(s.silent[2].i, 45, 'après une récidive, clôture après 6 h normales');
});

test('plafond : au-delà de 3 alertes sonores/jour hors panne → regroupé en silencieux (3 lignes), redonné avec son le lendemain', async () => {
  const day = zurichNow(T0).date;
  const prev = { version: 2, sound: { day, count: 3 }, lastWeeklyKey: weekKey(T0), lastRunAt: T0 - 10 * MIN, period: { since: T0 - H } };
  const results = [
    { id: 'A', status: 'ok', value: 'ok', health: {} },
    { id: 'B', status: 'ok', value: 'ok' },
    { id: 'C', status: 'ok', value: 'ok' },
    { id: 'D', status: 'crit', value: 'x', level: 'critique', pct: 90 },
  ];
  const { messages } = planRun(prev, results, T0, BASE_ENV);
  assert.equal(messages.length, 1);
  assert.equal(messages[0].sound, false);
  assert.ok(lines(messages[0].text) <= 3);
  assert.match(messages[0].text, /^🔕 REGROUPÉ — 1 alerte urgente sans son \(plafond de 3 alertes sonores par jour atteint\) : Disque de la base\./);
  // Une panne en cours n'est jamais plafonnée.
  const down = [{ id: 'A', status: 'crit', value: 'HTTP 503' }, { id: 'B', status: 'ok', value: 'ok' }, { id: 'C', status: 'skip', value: '-' }, { id: 'D', status: 'skip', value: '-' }];
  assert.equal(planRun(prev, down, T0, BASE_ENV).messages[0].sound, true);
  // En vrai : envoi regroupé, puis le lendemain l'alerte encore ouverte repart AVEC son.
  const st = normalizeState(prev, T0);
  const p1 = planRun(st, results, T0, BASE_ENV);
  p1.messages.forEach((m) => m.commit(p1.state));
  assert.equal(p1.state.incidents.disque.mutedByCap, true);
  const p2 = planRun(JSON.parse(JSON.stringify(p1.state)), results, T0 + 10 * MIN, BASE_ENV);
  assert.equal(p2.messages.length, 0, 'pas de répétition le même jour');
  const nextDay = { ...JSON.parse(JSON.stringify(p1.state)), lastRunAt: T0 + DAY - 10 * MIN }; // le watchdog a tourné entre-temps
  const p3 = planRun(nextDay, results, T0 + DAY, BASE_ENV);
  assert.equal(p3.messages.length, 1);
  assert.equal(p3.messages[0].sound, true);
  assert.match(p3.messages[0].text, /^🔴 URGENT — TOUJOURS EN COURS/);
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

test('mode test : résumé silencieux des 4 contrôles', async () => {
  const r = await run({}, { env: { WATCHDOG_TEST: 'true' } });
  assert.equal(r.calls.telegram.length, 1);
  assert.equal(r.calls.telegram[0].silent, true);
  assert.match(r.calls.telegram[0].text, /^🧪 TEST — Watchdog Mulklick/);
  assert.match(r.calls.telegram[0].text, /✅ D : ≈ 50 %/);
});

test('preuve de vie : arrêt > 2 h signalé en silencieux à la reprise (renvoyé si Telegram échoue) ; 70 min : résumé seulement', async () => {
  const r1 = await run({});
  const fail = await run({ telegramFails: true }, { prevState: r1.state, nowMs: T0 + 3 * H });
  assert.equal(fail.exitCode, 1);
  const r2 = await run({}, { prevState: fail.state, nowMs: T0 + 3 * H + 10 * MIN });
  assert.equal(r2.calls.telegram.length, 1);
  assert.equal(r2.calls.telegram[0].silent, true);
  assert.match(r2.calls.telegram[0].text, /^🟠 IMPORTANT — Le watchdog n’a pas tourné pendant 3 h \(du 19\.11 14:00 UTC au 19\.11 17:00 UTC\)/);
  const r3 = await run({}, { prevState: r2.state, nowMs: T0 + 4 * H + 20 * MIN });
  assert.equal(r3.calls.telegram.length, 0, '70 min : information seulement');
  assert.equal(r3.state.period.gaps.length, 2);
});

test('preuve de vie : contrôleur externe pingé à chaque passage ; muet 3 fois → URGENT ; revenu → clôture', async () => {
  const ok = await run({}, { env: HB_ENV });
  assert.deepEqual(ok.calls.pings, ['/uuid-de-test']);
  const down = await simulate({ start: T0 + 10 * MIN, runs: 4, env: HB_ENV, prevState: ok.state, site: () => ({ heartbeatDown: true }) });
  assert.equal(down.sent.length, 1);
  assert.equal(down.sent[0].silent, false);
  assert.match(down.sent[0].text, /^🔴 URGENT — Le contrôleur de vie du watchdog ne répond plus/);
  const back = await simulate({ start: T0 + 50 * MIN, runs: 9, env: HB_ENV, prevState: down.state });
  assert.equal(back.sent.length, 1);
  assert.match(back.sent[0].text, /^🟢 RÉSOLU — Contrôleur de vie du watchdog/);
  const fail = await run({ ...DOWN, telegramFails: true }, { env: HB_ENV });
  assert.deepEqual(fail.calls.pings, ['/uuid-de-test/fail'], 'Telegram en panne : le contrôleur externe est prévenu');
});

test('état illisible ou tronqué : complété ou repris à zéro sans planter', async () => {
  const r = await run({}, { prevState: { version: 2, incidents: null, period: 'x' } });
  assert.equal(r.exitCode, 0);
  assert.equal(r.calls.telegram.length, 0);
  assert.equal(normalizeState({ version: 1, checks: {} }, T0).period.reset, false, 'ancienne version : migration connue');
  assert.equal(normalizeState('corrompu', T0).period.reset, true);
});

test('heure suisse et clé de semaine', () => {
  assert.deepEqual(zurichNow(MON_23_0800_CH), { date: '2026-11-23', hour: 8, weekday: 1, label: '23.11.2026 08:00', short: '23.11' });
  assert.equal(zurichNow(Date.UTC(2026, 6, 6, 6, 0)).hour, 8, 'heure d’été : 06:00 UTC = 08:00');
  assert.equal(weekKey(MON_23_0800_CH - MIN), '2026-11-16', 'lundi 07:59 : encore la semaine précédente');
  assert.equal(weekKey(MON_23_0800_CH), '2026-11-23');
});

// ───────────────────────────── banc d'essai : bruit ─────────────────────────────

test('BANC — semaine sans incident : 0 message sonore, 1 seul silencieux (résumé du lundi)', async () => {
  const s = await simulate({ start: TUE_17_MIDNIGHT_CH, runs: 7 * 144, env: HB_ENV });
  assert.equal(s.sound.length, 0);
  assert.equal(s.silent.length, 1);
  const w = s.silent[0];
  assert.equal(new Date(w.t).toISOString(), '2026-11-23T07:00:00.000Z', 'lundi 08:00 heure suisse');
  assert.equal(lines(w.text), 3);
  // Du mardi 00:00 au lundi 08:00 inclus : 6 j 8 h = 912 intervalles, 913 passages.
  assert.match(w.text, /^📋 Semaine du 17\.11 au 23\.11 : aucun incident\.\nSurveillance : 913 passages sur ≈ 913 · disque ≈ 50 % de 18 GB \(stable\) · dernière capture 2026-11-19\.\nAction : aucune\.$/);
  assert.equal(s.pings, 7 * 144, 'un signal de vie par passage');
  assert.equal(s.failedRuns, 0);
});

test('BANC — même semaine sans contrôleur de vie configuré : toujours 1 seul message, qui le rappelle', async () => {
  const s = await simulate({ start: TUE_17_MIDNIGHT_CH, runs: 7 * 144 });
  assert.equal(s.sound.length, 0);
  assert.equal(s.silent.length, 1);
  assert.match(s.silent[0].text, /Action : contrôleur de vie externe non configuré\./);
});

test('BANC — semaine sans incident avec 2 retards du déclencheur de 70 min : toujours 0 sonore, 1 silencieux', async () => {
  const s = await simulate({ start: TUE_17_MIDNIGHT_CH, runs: 7 * 144, skip: (i) => (i > 200 && i < 207) || (i > 600 && i < 607) });
  assert.equal(s.sound.length, 0);
  assert.equal(s.silent.length, 1);
  assert.match(s.silent[0].text, /, 2 interruptions ·/);
});

test('BANC — panne de 2 h : 1 sonore (ouverture) + 1 silencieux (clôture)', async () => {
  const s = await simulate({ start: T0, runs: 30, site: (i) => (i >= 3 && i < 15 ? { ...DOWN, pageHtml: EMPTY_HTML } : {}) });
  assert.equal(s.sound.length, 1);
  assert.equal(s.silent.length, 1);
  assert.match(s.silent[0].text, /après 2 h/);
});

test('BANC — panne de 14 h : aucune répétition, 1 sonore + 1 silencieux', async () => {
  const s = await simulate({ start: T0, runs: 100, site: (i) => (i >= 2 && i < 86 ? DOWN : {}) });
  assert.equal(s.sound.length, 1);
  assert.equal(s.silent.length, 1);
  assert.match(s.silent[0].text, /après 14 h/);
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

test('BANC — scraper en retard 3 jours puis reparti : 0 sonore, 2 silencieux (signalement + clôture)', async () => {
  const s = await simulate({
    start: T0, runs: 4 * 144,
    site: (i) => ({ healthBody: { ...HEALTH_OK, age_hours: i < 3 * 144 ? 130 + i / 6 : 10 } }),
  });
  assert.equal(s.sound.length, 0);
  assert.equal(notWeekly(s.silent).length, 2);
});

test('BANC — à-coup d’une nuit de scraping (60 → 70 % en 1 h) puis plat : 0 sonore, 1 silencieux hors résumé', async () => {
  // Jeudi 19.11 : 65 % à 03:30, 70 % à 04:30 (heure suisse), puis plus rien pendant la semaine.
  const s = await simulate({
    start: TUE_17_MIDNIGHT_CH, runs: 7 * 144,
    site: (i) => disk(i < 2 * 144 + 21 ? 60 : i < 2 * 144 + 27 ? 65 : 70),
  });
  assert.equal(s.sound.length, 0);
  assert.equal(notWeekly(s.silent).length, 1);
  assert.match(notWeekly(s.silent)[0].text, /^🟠 IMPORTANT — Disque de la base ≈ 65 % de 18 GB\./);
});

test('BANC — disque qui monte de 50 à 92 % en 3 semaines : 1 seul sonore, 3 silencieux au plus hors résumés', async () => {
  const runs = 21 * 144;
  const s = await simulate({
    start: TUE_17_MIDNIGHT_CH, runs,
    site: (i) => {
      const exact = 50 + (42 * i) / runs;
      const pct = Math.floor(exact / 5) * 5;
      const lvl = exact >= 80 ? 'critique' : exact >= 65 ? 'avertissement' : 'ok';
      return { healthBody: { ...HEALTH_OK, disk_level: lvl, disk_pct: pct } };
    },
  });
  assert.equal(s.sound.length, 1, 'une seule alerte sonore : le risque sous 48 h');
  const nw = notWeekly(s.silent);
  assert.ok(nw.length >= 1 && nw.length <= 3, `silencieux hors résumés : ${nw.length}`);
  assert.equal(s.silent.length - nw.length, 3, 'un résumé par lundi');
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
  assert.equal(CONFIG.soundCapPerDay, 3);
  assert.deepEqual(CONFIG.renotifyMs, { urgent: null, important: null });
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

test('SECOURS — cockpit muet depuis 40 min : alerte URGENTE sonore + le secours fait les contrôles', async () => {
  const r = await run({ principal: vivant(T0 - 40 * MIN) }, { env: SECOURS_ENV });
  assert.ok(r.calls.health >= 1, 'le secours contrôle le site lui-même');
  assert.equal(r.calls.telegram.length, 1);
  assert.equal(r.calls.telegram[0].silent, false);
  assert.match(r.calls.telegram[0].text, /^🔴 URGENT — La surveillance principale \(cockpit\) ne tourne plus : dernier passage il y a 40 min/);
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

test('SECOURS — cockpit arrêté ET base en panne : deux causes, deux messages sonores', async () => {
  const r = await run({ ...DOWN, principal: vivant(T0 - 2 * H) }, { env: SECOURS_ENV });
  assert.equal(r.calls.telegram.length, 2);
  assert.ok(r.calls.telegram.every((m) => !m.silent));
  assert.ok(r.calls.telegram.some((m) => /surveillance principale/.test(m.text)));
  assert.ok(r.calls.telegram.some((m) => /Base de données ou \/api\/health injoignable/.test(m.text)));
});

test('SECOURS — le cockpit revient : passation silencieuse, clôture silencieuse 1 h plus tard', async () => {
  const mort = await run({ ...DOWN, principal: vivant(T0 - 2 * H) }, { env: SECOURS_ENV });
  assert.equal(mort.calls.telegram.length, 2);
  const retour = await run({ ...DOWN, principal: vivant(T0 + 3 * H - MIN) }, { env: SECOURS_ENV, prevState: mort.state, nowMs: T0 + 3 * H });
  assert.equal(retour.calls.telegram.length, 0, 'cockpit vivant : la base en panne est son affaire, pas de doublon');
  assert.equal(retour.state.incidents.base, undefined, 'incident du site rendu au cockpit');
  const plusTard = await run({ principal: vivant(T0 + 5 * H - MIN) }, { env: SECOURS_ENV, prevState: retour.state, nowMs: T0 + 5 * H });
  assert.equal(plusTard.calls.telegram.length, 1);
  assert.equal(plusTard.calls.telegram[0].silent, true);
  assert.match(plusTard.calls.telegram[0].text, /^🟢 RÉSOLU — Surveillance principale \(cockpit\)/);
});

test('SECOURS — ni résumé du lundi ni message « n’a pas tourné » (le secours passe rarement, c’est normal)', async () => {
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
    assert.match(clos.calls.telegram[0].text, /^🟢 RÉSOLU — Boîte d’alertes du cockpit/);
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

const direct = (d, plusAncien = null, now = T0) => ({ ...vivant(now - MIN), telegram: { direct: d, boite: { active: true, en_attente: 0, plus_ancien: plusAncien } } });

test('TELEGRAM COCKPIT — échec plus récent que le dernier succès : un message silencieux avec le détail, une fois, clos après un succès postérieur', async () => {
  const echec = new Date(T0 - 40 * MIN).toISOString();
  const d = { configure: true, dernier_ok: new Date(T0 - 3 * H).toISOString(), dernier_echec: echec, dernier_echec_detail: 'HTTP 403 — Forbidden: bot was blocked by the user' };
  const r1 = await runBoite({ site: { principal: direct(d) } });
  assert.equal(r1.calls.telegram.length, 1);
  const m = r1.calls.telegram[0];
  assert.equal(m.silent, true);
  assert.match(m.text, /Le bot du cockpit n’arrive plus à envoyer depuis 13:20 UTC \(HTTP 403 — Forbidden: bot was blocked by the user\)/);
  assert.match(m.text, /ses alertes te parviennent quand même ici/);
  assert.ok(lines(m.text) <= 3);
  assert.ok(!r1.logs.join('\n').includes('Forbidden'), 'le détail ne va pas dans le journal public');
  const r2 = await runBoite({ site: { principal: direct(d, null, T0 + 10 * MIN) } }, { prevState: r1.state, nowMs: T0 + 10 * MIN });
  assert.equal(r2.calls.telegram.length, 0, 'une seule fois');
  const bon = { ...d, dernier_ok: new Date(T0 + 15 * MIN).toISOString() };
  const r3 = await runBoite({ site: { principal: direct(bon, null, T0 + 20 * MIN) } }, { prevState: r2.state, nowMs: T0 + 20 * MIN });
  assert.equal(r3.calls.telegram.length, 0);
  const r4 = await runBoite({ site: { principal: direct(bon, null, T0 + 90 * MIN) } }, { prevState: r3.state, nowMs: T0 + 90 * MIN });
  assert.equal(r4.calls.telegram.length, 1);
  assert.match(r4.calls.telegram[0].text, /^🟢 RÉSOLU — Envoi Telegram direct du cockpit/);
});

test('TELEGRAM COCKPIT — jamais envoyé avec succès : incident ; aucun échec : rien ; cockpit mort : rien', async () => {
  const d = { configure: true, dernier_ok: null, dernier_echec: new Date(T0 - 5 * MIN).toISOString(), dernier_echec_detail: 'non configuré' };
  const r = await runBoite({ site: { principal: direct(d) } });
  assert.equal(r.calls.telegram.length, 1);
  const calme = await runBoite({ site: { principal: direct({ configure: true, dernier_ok: null, dernier_echec: null }) } });
  assert.equal(calme.calls.telegram.length, 0);
  const mort = await runBoite({ site: { principal: { ...direct(d), surveillance_site: { actif: true, dernier_passage: new Date(T0 - 2 * H).toISOString() } } } });
  assert.ok(!mort.calls.telegram.some((m) => /bot du cockpit/.test(m.text)));
});

test('TELEGRAM COCKPIT — le détail est nettoyé d’un éventuel jeton et borné', async () => {
  const d = { configure: true, dernier_ok: null, dernier_echec: new Date(T0 - MIN).toISOString(), dernier_echec_detail: `HTTP 401 — bot123456:AAA-bbb_CCC Unauthorized ${'x'.repeat(300)}` };
  const r = await runBoite({ site: { principal: direct(d) } });
  assert.ok(!/bot123456/.test(r.calls.telegram[0].text));
  assert.ok(r.calls.telegram[0].text.length < 500);
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
