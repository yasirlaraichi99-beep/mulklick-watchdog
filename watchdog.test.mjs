// Tests du watchdog avec réponses simulées. AUCUN appel réseau réel : chaque contrôle reçoit un
// faux fetch qui répond selon l'URL et lève une erreur sur toute URL inconnue. Les appels à
// api.telegram.org sont interceptés et enregistrés, jamais émis.
//   node --test watchdog.test.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runOnce, decide, CONFIG } from './watchdog.mjs';

const T0 = Date.UTC(2026, 10, 19, 14, 0); // 19.11.2026 14:00 UTC
const MIN = 60_000;

const HEALTHY_HTML = `<html>${'<polyline data-spark="" points="0,1 2,3"></polyline>'.repeat(8)}</html>`;
const EMPTY_HTML = `<html>${'<div>Aucune valeur actuelle</div>'.repeat(8)}</html>`;
const PARTIAL_HTML = `<html>${'<polyline data-spark=""></polyline>'.repeat(6)}${'<div>Aucune valeur actuelle</div>'.repeat(2)}</html>`;

function jsonRes(status, body) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}
function textRes(status, text) {
  return { status, json: async () => JSON.parse(text), text: async () => text };
}

/**
 * Faux réseau. `site` décrit l'état simulé ; renvoie { fetchImpl, calls }.
 * calls.telegram = textes « envoyés » ; calls.health / calls.page = nombre d'appels ; calls.hosts = tous les hôtes contactés.
 */
function fakeNet(site) {
  const calls = { telegram: [], health: 0, page: 0, hosts: [] };
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    calls.hosts.push(u.hostname);
    if (u.hostname === 'api.telegram.org') {
      const body = JSON.parse(init.body);
      if (site.telegramFails) return jsonRes(401, { ok: false, description: 'Unauthorized' });
      calls.telegram.push({ chat_id: body.chat_id, text: body.text, path: u.pathname });
      return jsonRes(200, { ok: true, result: { message_id: calls.telegram.length } });
    }
    if (u.hostname === 'www.mulklick.ch' && u.pathname === '/api/health') {
      calls.health += 1;
      assert.ok(u.searchParams.get('wd'), 'paramètre anti-cache attendu sur /api/health');
      if (site.healthThrows) throw Object.assign(new Error('x'), { name: 'TimeoutError' });
      return jsonRes(site.healthStatus ?? 200, site.healthBody ?? { db_ok: true, latest_capture: '2026-11-19', age_hours: 14, response_ms: 42, disk_level: 'ok', disk_pct: 50 });
    }
    if (u.hostname === 'www.mulklick.ch' && u.pathname === '/fr/intelligence') {
      calls.page += 1;
      assert.ok(u.searchParams.get('wd'), 'paramètre anti-cache attendu sur la page');
      return textRes(site.pageStatus ?? 200, site.pageHtml ?? HEALTHY_HTML);
    }
    throw new Error(`URL inattendue dans un test : ${u.hostname}${u.pathname}`);
  };
  return { fetchImpl, calls };
}

const BASE_ENV = {
  TELEGRAM_BOT_TOKEN: 'TEST-TOKEN-NOT-REAL',
  TELEGRAM_CHAT_ID: '42',
};

async function run(site, { env = {}, prevState = null, nowMs = T0 } = {}) {
  const net = fakeNet(site);
  const sleeps = [];
  const logs = [];
  const out = await runOnce({
    fetchImpl: net.fetchImpl,
    sleep: async (ms) => { sleeps.push(ms); },
    env: { ...BASE_ENV, ...env },
    prevState,
    nowMs,
    log: (l) => logs.push(l),
  });
  const byId = Object.fromEntries(out.results.map((r) => [r.id, r]));
  return { ...out, byId, calls: net.calls, sleeps, logs };
}

test('site OK : aucun message, contrôle disque OK', async () => {
  const r = await run({});
  assert.equal(r.exitCode, 0);
  assert.equal(r.byId.A.status, 'ok');
  assert.equal(r.byId.B.status, 'ok');
  assert.equal(r.byId.C.status, 'ok');
  assert.equal(r.byId.D.status, 'ok');
  assert.equal(r.calls.telegram.length, 0);
  assert.equal(r.calls.health, 1, 'un seul appel /api/health pour A, C et D');
  assert.deepEqual(r.sleeps, []);
});

test('503 : 3 essais espacés de 20 s, alerte critique A, C non mesurable', async () => {
  const r = await run({ healthStatus: 503, healthBody: { db_ok: false, latest_capture: null, age_hours: null, response_ms: 5001 } });
  assert.equal(r.calls.health, 3);
  assert.deepEqual(r.sleeps, [20_000, 20_000]);
  assert.equal(r.byId.A.status, 'crit');
  assert.match(r.byId.A.value, /HTTP 503, db_ok=false/);
  assert.equal(r.byId.C.status, 'skip');
  assert.equal(r.calls.telegram.length, 1);
  const msg = r.calls.telegram[0].text;
  assert.match(msg, /^🔴 CRITIQUE — Contrôle A/);
  assert.match(msg, /Heure : 2026-11-19 14:00 UTC/);
  assert.match(msg, /À faire : /);
  assert.equal(r.calls.telegram[0].chat_id, '42');
  assert.equal(r.exitCode, 0);
});

test('A échoue deux fois puis répond : pas d’alerte', async () => {
  let n = 0;
  const net = fakeNet({});
  const flaky = async (url, init) => {
    if (String(url).includes('/api/health') && n++ < 2) return jsonRes(502, null);
    return net.fetchImpl(url, init);
  };
  const out = await runOnce({ fetchImpl: flaky, sleep: async () => {}, env: BASE_ENV, prevState: null, nowMs: T0, log: () => {} });
  assert.equal(out.results.find((x) => x.id === 'A').status, 'ok');
  assert.equal(net.calls.telegram.length, 0);
});

test('/api/health injoignable (délai) : critique', async () => {
  const r = await run({ healthThrows: true });
  assert.equal(r.byId.A.status, 'crit');
  assert.match(r.byId.A.value, /délai dépassé/);
});

test('données absentes de la page : B critique', async () => {
  const r = await run({ pageHtml: EMPTY_HTML });
  assert.equal(r.byId.B.status, 'crit');
  assert.match(r.byId.B.value, /0\/8 cartes chiffrées, 8 « Aucune valeur actuelle »/);
  assert.equal(r.calls.page, 1, 'pas de nouvel essai pour un problème de contenu');
  assert.match(r.calls.telegram[0].text, /🔴 CRITIQUE — Contrôle B/);
});

test('données partielles : B avertissement', async () => {
  const r = await run({ pageHtml: PARTIAL_HTML });
  assert.equal(r.byId.B.status, 'warn');
  assert.match(r.calls.telegram[0].text, /^🟠 AVERTISSEMENT — Contrôle B/);
});

test('page sans aucun marqueur (structure changée) : B avertissement', async () => {
  const r = await run({ pageHtml: '<html>rien</html>' });
  assert.equal(r.byId.B.status, 'warn');
  assert.match(r.byId.B.value, /marqueurs introuvables/);
});

test('page en 500 : B critique après 3 essais', async () => {
  const r = await run({ pageStatus: 500 });
  assert.equal(r.calls.page, 3);
  assert.equal(r.byId.B.status, 'crit');
});

test('données trop anciennes : C avertissement au-delà de 120 h', async () => {
  const r = await run({ healthBody: { db_ok: true, latest_capture: '2026-11-14', age_hours: 134, response_ms: 40 } });
  assert.equal(r.byId.A.status, 'ok');
  assert.equal(r.byId.C.status, 'warn');
  assert.match(r.calls.telegram[0].text, /^🟠 AVERTISSEMENT — Contrôle C/);
  assert.match(r.calls.telegram[0].text, /âge 134 h \(seuil 120 h\)/);
  const ok = await run({ healthBody: { db_ok: true, latest_capture: '2026-11-15', age_hours: 110, response_ms: 40 } });
  assert.equal(ok.byId.C.status, 'ok', 'week-end normal (ven → lun) : pas d’alerte');
});

const withDisk = (disk_level, disk_pct) => ({
  healthBody: { db_ok: true, latest_capture: '2026-11-19', age_hours: 14, response_ms: 42, disk_level, disk_pct },
});

test('disque ok à 60 % : D ok, aucun message', async () => {
  const r = await run(withDisk('ok', 60));
  assert.equal(r.byId.D.status, 'ok');
  assert.equal(r.calls.telegram.length, 0);
});

test('disque avertissement à 70 % : un message Telegram', async () => {
  const r = await run(withDisk('avertissement', 70));
  assert.equal(r.byId.D.status, 'warn');
  assert.equal(r.calls.telegram.length, 1);
  assert.match(r.calls.telegram[0].text, /^🟠 AVERTISSEMENT — Contrôle D/);
  assert.match(r.calls.telegram[0].text, /≈ 70 %/);
  assert.match(r.calls.telegram[0].text, /Libérer de la place/);
});

test('disque critique à 85 % : message critique', async () => {
  const r = await run(withDisk('critique', 85));
  assert.equal(r.byId.D.status, 'crit');
  assert.equal(r.calls.telegram.length, 1);
  assert.match(r.calls.telegram[0].text, /^🔴 CRITIQUE — Contrôle D/);
});

test('200 sans champs disque : D avertissement « niveau disque absent »', async () => {
  const r = await run({ healthBody: { db_ok: true, latest_capture: '2026-11-19', age_hours: 14, response_ms: 42 } });
  assert.equal(r.byId.D.status, 'warn');
  assert.match(r.byId.D.value, /niveau disque absent/);
  const n = await run(withDisk(null, null));
  assert.equal(n.byId.D.status, 'warn');
  assert.match(n.byId.D.value, /niveau disque absent/);
  assert.match(n.calls.telegram[0].text, /^🟠 AVERTISSEMENT — Contrôle D/);
});

test('/api/health en 503 : D sauté', async () => {
  const r = await run({ healthStatus: 503, healthBody: { db_ok: false, latest_capture: null, age_hours: null, response_ms: 5001, disk_level: null, disk_pct: null } });
  assert.equal(r.byId.D.status, 'skip');
  assert.match(r.byId.D.value, /non mesurable/);
  assert.equal(r.byId.A.status, 'crit');
  assert.equal(r.byId.B.status, 'ok');
});

test('niveau disque inconnu : D avertissement', async () => {
  const r = await run(withDisk('bizarre', 50));
  assert.equal(r.byId.D.status, 'warn');
  assert.equal(r.byId.D.value, 'niveau disque inconnu : bizarre');
});

test('jamais de requête vers un hôte *.supabase.co, quel que soit le scénario', async () => {
  const scenarios = [
    {}, withDisk('avertissement', 70), withDisk('critique', 85), withDisk('bizarre', 1),
    { healthBody: { db_ok: true } },
    { healthStatus: 503, healthBody: { db_ok: false } },
    { healthThrows: true },
    { pageHtml: EMPTY_HTML },
  ];
  for (const sc of scenarios) {
    const r = await run(sc, { env: { WATCHDOG_TEST: 'true' } });
    assert.ok(r.calls.hosts.length > 0);
    assert.deepEqual(r.calls.hosts.filter((h) => h.endsWith('supabase.co')), []);
  }
});

test('anti-spam : KO → silence 10 min plus tard → rappel après 1 h → rétabli', async () => {
  const ko = { healthStatus: 503, healthBody: { db_ok: false } };
  const r1 = await run(ko, { nowMs: T0 });
  assert.equal(r1.calls.telegram.length, 1);

  const r2 = await run(ko, { prevState: r1.stateToWrite, nowMs: T0 + 10 * MIN });
  assert.equal(r2.calls.telegram.length, 0, 'pas de doublon dans l’heure');

  const r3 = await run(ko, { prevState: r2.stateToWrite, nowMs: T0 + 60 * MIN });
  assert.equal(r3.calls.telegram.length, 1);
  assert.match(r3.calls.telegram[0].text, /^🔴 RAPPEL CRITIQUE \(KO depuis 1 h\)/);

  const r4 = await run(ko, { prevState: r3.stateToWrite, nowMs: T0 + 70 * MIN });
  assert.equal(r4.calls.telegram.length, 0);

  const r5 = await run({}, { prevState: r4.stateToWrite, nowMs: T0 + 80 * MIN });
  assert.equal(r5.calls.telegram.length, 1);
  assert.match(r5.calls.telegram[0].text, /^🟢 RÉTABLI — Contrôle A/);
  assert.match(r5.calls.telegram[0].text, /Incident terminé après 1 h 20/);

  const r6 = await run({}, { prevState: r5.stateToWrite, nowMs: T0 + 90 * MIN });
  assert.equal(r6.calls.telegram.length, 0, 'rien quand tout reste OK');
});

test('aggravation avertissement → critique : message immédiat', () => {
  const w = { id: 'D', status: 'warn', value: '72 %' };
  const c = { id: 'D', status: 'crit', value: '86 %' };
  const s1 = decide(null, [w], T0);
  assert.equal(s1.messages.length, 1);
  const s2 = decide(s1.nextState, [c], T0 + 10 * MIN);
  assert.equal(s2.messages.length, 1);
  assert.match(s2.messages[0], /^🔴 CRITIQUE/);
});

test('plusieurs contrôles KO au même passage : un seul envoi Telegram groupé', async () => {
  const r = await run({ healthStatus: 503, healthBody: { db_ok: false }, pageHtml: EMPTY_HTML });
  assert.equal(r.calls.telegram.length, 1);
  assert.match(r.calls.telegram[0].text, /Contrôle A[\s\S]*Contrôle B/);
});

test('échec Telegram : job en échec, état non avancé, jeton jamais journalisé', async () => {
  const r = await run({ healthStatus: 503, healthBody: { db_ok: false }, telegramFails: true });
  assert.equal(r.exitCode, 1);
  assert.deepEqual(r.stateToWrite, { version: 1, checks: {} });
  const all = r.logs.join('\n');
  assert.match(all, /ÉCHEC de l'envoi Telegram : Telegram : HTTP 401 — Unauthorized/);
  assert.ok(!all.includes('TEST-TOKEN-NOT-REAL'), 'le jeton ne doit jamais apparaître dans les logs');
  // Au run suivant (Telegram revenu), l'alerte part bien.
  const r2 = await run({ healthStatus: 503, healthBody: { db_ok: false } }, { prevState: r.stateToWrite, nowMs: T0 + 10 * MIN });
  assert.equal(r2.calls.telegram.length, 1);
});

test('mode test : message même si tout va bien, avec le résumé des 4 contrôles', async () => {
  const r = await run({}, { env: { WATCHDOG_TEST: 'true' } });
  assert.equal(r.calls.telegram.length, 1);
  const msg = r.calls.telegram[0].text;
  assert.match(msg, /^🧪 TEST — Watchdog Mulklick/);
  assert.match(msg, /✅ Contrôle A/);
  assert.match(msg, /✅ Contrôle D/);
  const off = await run({}, { env: { WATCHDOG_TEST: 'false' } });
  assert.equal(off.calls.telegram.length, 0);
});

test('configuration : seuils documentés', () => {
  assert.equal(CONFIG.freshnessMaxHours, 120);
  assert.equal(CONFIG.healthAttempts, 3);
  assert.equal(CONFIG.retryDelayMs, 20_000);
});
