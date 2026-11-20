// BANC D'ESSAI DE LA PARTIE 7 — prise en charge des incidents.
//
// Simule, minute par minute, le système complet : le VRAI watchdog (watchdog.mjs + garde.mjs,
// un passage toutes les 5 min), un cockpit et des agents SIMULÉS selon le contrat v2
// (docs du cockpit, garde-mulklick-contrat.md), Telegram (groupe à sujets) et les réponses de
// Yasir. Aucun appel réseau réel, aucun vrai message.
//
//   node banc-garde.mjs          → rapport scénario par scénario, échecs en premier
//   node --test garde.test.mjs   → les mêmes scénarios comme tests
//
// Le cockpit simulé est un MODÈLE du contrat : le vrai backend a ses propres tests des mêmes
// scénarios (admin-backend, tests/test_garde_mulklick.py). Ce banc vérifie la boucle complète
// et, surtout, la partie qui ne dépend de personne : les délais tenus par le watchdog.

import { runOnce } from './watchdog.mjs';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const START = Date.UTC(2026, 10, 24, 9, 0); // mar. 24.11.2026 10:00 heure suisse
const CHAT = '-1009990001';
const YASIR = '42';
const TOKEN = 'TEST-TOKEN-NOT-REAL';
const COCKPIT = 'https://cockpit.example';
const COCKPIT_JETON = 'w'.repeat(40);

const HEALTH_OK = { db_ok: true, latest_capture: '2026-11-24', age_hours: 9, response_ms: 40, disk_level: 'ok', disk_pct: 50 };
const HEALTHY_HTML = `<html>${'<polyline data-spark=""></polyline>'.repeat(8)}${' '.repeat(30_000)}</html>`;
const EMPTY_HTML = `<html>${'<div>Aucune valeur actuelle</div>'.repeat(8)}${' '.repeat(30_000)}</html>`;
export const SITE = {
  ok: {},
  baseDown: { healthStatus: 503, healthBody: { db_ok: false, disk_level: null, disk_pct: null } },
  pageVide: { pageHtml: EMPTY_HTML },
  vieux: { healthBody: { ...HEALTH_OK, latest_capture: '2026-11-18', age_hours: 130 } },
  disque90: { healthBody: { ...HEALTH_OK, disk_level: 'critique', disk_pct: 90 } },
  disque90Vieux: { healthBody: { ...HEALTH_OK, disk_level: 'critique', disk_pct: 90, latest_capture: '2026-11-18', age_hours: 130 } },
};

const ENV_GARDE = {
  TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: YASIR, GARDE_ACTIVE: 'true', TELEGRAM_INCIDENTS_CHAT_ID: CHAT,
  COCKPIT_API_URL: COCKPIT, COCKPIT_WATCHDOG_TOKEN: COCKPIT_JETON, CF_ACCESS_CLIENT_ID: 'cf-id', CF_ACCESS_CLIENT_SECRET: 'cf-secret',
};
const ENV_SANS_GARDE = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: YASIR };

function hhmm(ms) {
  return new Date(ms).toISOString().slice(11, 16);
}

// ───────────────────────────── Telegram simulé ─────────────────────────────

class FakeTelegram {
  constructor() {
    this.msgs = [];
    this.topics = [];
    this.updates = [];
    this.nextMsg = 1;
    this.nextTopic = 100;
    this.nextUpdate = 1;
    this.now = 0;
  }
  handle(method, payload) {
    if (method === 'createForumTopic') {
      const id = this.nextTopic++;
      this.topics.push({ id, name: payload.name, at: this.now });
      return { message_thread_id: id, name: payload.name };
    }
    if (method === 'sendMessage') {
      const m = { id: this.nextMsg++, de: 'watchdog', chat: String(payload.chat_id), thread: payload.message_thread_id ?? null,
        text: payload.text, silent: payload.disable_notification === true, t: this.now };
      this.msgs.push(m);
      return { message_id: m.id };
    }
    if (method === 'getUpdates') return this.updates.filter((u) => u.update_id >= (payload.offset ?? 0));
    throw new Error(`méthode Telegram inattendue : ${method}`);
  }
  poster(de, thread, text, sonore, t) {
    this.msgs.push({ id: this.nextMsg++, de, chat: CHAT, thread, text, silent: !sonore, t });
  }
  reponseDeYasir(thread, t) {
    this.updates.push({ update_id: this.nextUpdate++, message: { chat: { id: CHAT }, from: { id: YASIR }, message_thread_id: thread, date: Math.floor(t / 1000), text: 'vu, je regarde' } });
  }
}

// ───────────────────────────── agents simulés ─────────────────────────────

const PRINCIPAL = 'agent principal (routine On-Call)';
export const AGENTS = {
  reactif: ({ prise = 2, diag = 15 } = {}) => ({ plan: (t) => [{ at: t + prise * MIN, type: 'prise' }, { at: t + diag * MIN, type: 'diag', cause: 'vraie' }] }),
  muet: () => ({ plan: () => [] }), // tiré correctement, puis plus rien (arrêté pendant l'incident)
  apiIndisponible: () => ({ apiDown: true, plan: () => [] }),
  seTrompe: () => ({ plan: (t) => [{ at: t + 2 * MIN, type: 'prise' }, { at: t + 10 * MIN, type: 'diag', cause: 'fausse', correctif: true }] }),
  jamaisConclu: () => ({ plan: (t) => [{ at: t + 2 * MIN, type: 'prise' }] }),
};

// ───────────────────────────── cockpit simulé (contrat v2) ─────────────────────────────

class FakeCockpit {
  constructor({ tg, principal, relaisActif = true, down = () => false }) {
    Object.assign(this, { tg, principal, relaisActif, down });
    this.incs = [];
    this.appels = 0;
    this.seq = 1;
  }
  delaiPrise(niveau) {
    return niveau === 'urgent' ? 5 * MIN : 30 * MIN;
  }
  handle(method, body, now) {
    this.appels += 1;
    if (this.down(now)) return null; // injoignable
    if (method === 'GET') {
      return { incidents: this.incs.filter((i) => !i.resolved_at || now - i.resolved_at < DAY).map((i) => this.vue(i, now)) };
    }
    let inc = this.incs.find((i) => i.cle === body.cle && !i.resolved_at);
    if (!inc && body.etat === 'ouvert' && body.niveau) {
      const detecte = Date.parse(body.detecte_le);
      inc = { ref: `INC-2026-${String(this.seq++).padStart(3, '0')}`, cle: body.cle, niveau: body.niveau, quoi: body.quoi,
        detecte_le: detecte, echeance: detecte + this.delaiPrise(body.niveau), etape: 'detecte', pris_en_charge_le: null,
        agent: null, diagnostique_le: null, cause: null, correctif: null, principal: null, relais: null, actions: [],
        telegram: body.telegram, acquitte_le: null, journal: [] };
      this.incs.push(inc);
      this.tirerPrincipal(inc, now);
    }
    if (inc) {
      if (body.acquitte_le) inc.acquitte_le = Date.parse(body.acquitte_le);
      if (body.niveau && (body.etat === 'aggrave' || body.etat === 'ameliore')) inc.niveau = body.niveau;
      if (body.telegram) inc.telegram = body.telegram;
      if (body.etat === 'resolu') {
        inc.etape = 'resolu';
        inc.resolved_at = now;
      }
    }
    return inc ? this.vue(inc, now) : { ok: true };
  }
  poster(inc, texte, sonore, now) {
    this.tg.poster('cockpit', inc.telegram ? inc.telegram.thread_id : null, texte, sonore, now);
  }
  tirerPrincipal(inc, now) {
    const a = this.principal;
    inc.principal = { tire_le: now, resultat: a.apiDown ? 'echec' : 'declenchee', detail: a.apiDown ? 'HTTP 529, API Claude indisponible' : null };
    inc.journal.push(`[routine] ${inc.principal.resultat}`);
    if (inc.principal.resultat === 'declenchee') inc.actions.push(...a.plan(now).map((x) => ({ ...x, agent: PRINCIPAL })));
    else this.tirerRelais(inc, now, 'tir de l’agent principal en échec');
  }
  tirerRelais(inc, now, motif) {
    if (inc.relais) return;
    inc.relais = { tire_le: now, resultat: this.relaisActif ? 'declenchee' : 'coupe', motif };
    inc.journal.push(`[relais] ${inc.relais.resultat} — ${motif}`);
    if (!this.relaisActif) return;
    // Agent relais (runbook automatique) : prise en charge, vérifications en lecture, constats — même tick.
    if (!inc.pris_en_charge_le) {
      inc.pris_en_charge_le = now;
      inc.premierAgent = 'agent relais (runbook automatique)';
    }
    inc.agent = 'agent relais (runbook automatique)';
    inc.diagnostique_le = now;
    inc.etape = 'a_yasir';
    inc.cause = `non déterminée — constats : ${motif} ; /api/health et /fr/intelligence vérifiés`;
    this.poster(inc, `🟠 Relais — ${motif}.\nConstats : santé et page publique vérifiées.\nÀ toi : vérifier le tableau de bord Supabase.`, inc.niveau === 'urgent', now);
  }
  correctifApplique(cle, now) {
    const inc = this.incs.find((i) => i.cle === cle && !i.resolved_at);
    if (inc) {
      inc.correctif_applique_le = now;
      inc.journal.push('[correctif-applique]');
    }
  }
  tick(now) {
    if (this.down(now)) return;
    for (const inc of this.incs) {
      if (inc.resolved_at) continue;
      for (const act of inc.actions) {
        if (act.fait || act.at > now || inc.relais) continue;
        act.fait = true;
        if (act.type === 'prise' && !inc.pris_en_charge_le) {
          inc.pris_en_charge_le = now;
          inc.agent = act.agent;
          inc.premierAgent = act.agent;
          inc.etape = 'pris_en_charge';
          this.poster(inc, `🟢 Pris en charge par ${act.agent}.\nJe commence par la santé, les logs et les déploiements.\nAction : aucune pour l’instant.`, false, now);
        }
        if (act.type === 'diag') {
          inc.diagnostique_le = now;
          inc.cause = act.cause;
          inc.correctif = act.correctif ? { pr: 'https://github.com/exemple/pull/1 (brouillon)', a_valider: 'la PR' } : null;
          inc.etape = act.correctif ? 'correctif_propose' : 'diagnostique';
          this.poster(inc, `Diagnostic : ${act.cause}.\nCorrectif : PR en brouillon.\nÀ valider par Yasir : la PR.`, inc.niveau === 'urgent', now);
        }
      }
      if (inc.relais) continue;
      const p = inc.principal;
      if (p && p.resultat === 'declenchee' && !inc.pris_en_charge_le && now - p.tire_le >= (inc.niveau === 'urgent' ? 3 : 15) * MIN) {
        this.tirerRelais(inc, now, 'agent principal muet depuis son tir');
      } else if (inc.pris_en_charge_le && !inc.diagnostique_le && now - inc.pris_en_charge_le >= (inc.niveau === 'urgent' ? HOUR : DAY)) {
        this.tirerRelais(inc, now, 'pris en charge mais aucun diagnostic dans le délai');
      } else if (inc.correctif_applique_le && now - inc.correctif_applique_le >= 30 * MIN) {
        this.tirerRelais(inc, now, 'diagnostic réfuté : problème toujours présent 30 min après le correctif');
      }
    }
  }
  vue(inc, now) {
    let raison = null;
    if (!inc.pris_en_charge_le) {
      if (!inc.principal) raison = 'agent principal jamais tiré';
      else if (inc.principal.resultat !== 'declenchee') raison = `tir de l’agent principal en échec (${inc.principal.detail})`;
      else raison = `agent principal tiré à ${hhmm(inc.principal.tire_le)} UTC, aucun signe depuis`;
      if (inc.relais && inc.relais.resultat === 'coupe') raison += ' ; agent relais coupé';
    }
    const iso = (v) => (v ? new Date(v).toISOString() : null);
    return {
      ref: inc.ref, cle: inc.cle, niveau: inc.niveau, etape: inc.etape, detecte_le: iso(inc.detecte_le),
      echeance_prise_en_charge: iso(inc.echeance), pris_en_charge_le: iso(inc.pris_en_charge_le), agent: inc.agent,
      diagnostique_le: iso(inc.diagnostique_le), cause: inc.cause, correctif: inc.correctif,
      agent_principal: inc.principal ? { tire_le: iso(inc.principal.tire_le), resultat: inc.principal.resultat, detail: inc.principal.detail } : null,
      agent_relais: inc.relais ? { tire_le: iso(inc.relais.tire_le), resultat: inc.relais.resultat, detail: inc.relais.motif } : { tire_le: null },
      raison_silence: raison, telegram: inc.telegram,
    };
  }
}

// ───────────────────────────── boucle de simulation ─────────────────────────────

function jsonRes(status, body) {
  return { status, json: async () => body, text: async () => JSON.stringify(body) };
}

function reseau({ tg, cockpit, site, now }) {
  return async (url, init = {}) => {
    const u = new URL(url);
    if (u.hostname === 'api.telegram.org') {
      const method = u.pathname.split('/').pop();
      return jsonRes(200, { ok: true, result: tg.handle(method, JSON.parse(init.body || '{}')) });
    }
    if (u.origin === COCKPIT) {
      const h = init.headers || {};
      if (h.authorization !== `Bearer ${COCKPIT_JETON}` || !h['cf-access-client-id'] || !h['cf-access-client-secret']) return jsonRes(401, { detail: 'jeton_invalide' });
      if (u.pathname !== '/admin/oncall/watchdog/incidents') return jsonRes(404, { detail: 'inconnu' });
      const r = cockpit.handle(init.method || 'GET', init.body ? JSON.parse(init.body) : null, now());
      if (r === null) throw Object.assign(new Error('fetch failed'), { name: 'TypeError' });
      return jsonRes(200, r);
    }
    if (u.hostname === 'www.mulklick.ch' && u.pathname === '/api/health') {
      const s = site();
      return jsonRes(s.healthStatus ?? 200, s.healthBody ?? HEALTH_OK);
    }
    if (u.hostname === 'www.mulklick.ch' && u.pathname === '/fr/intelligence') {
      const s = site();
      const html = s.pageHtml ?? HEALTHY_HTML;
      return { status: s.pageStatus ?? 200, text: async () => html, json: async () => ({}) };
    }
    throw new Error(`URL inattendue : ${u.hostname}${u.pathname}`);
  };
}

/** Exécute un scénario ; rend les mesures brutes. */
export async function simuler(sc) {
  const tg = new FakeTelegram();
  let t = START;
  const cockpit = new FakeCockpit({ tg, principal: sc.principal, relaisActif: sc.relaisActif !== false, down: sc.cockpitDown || (() => false) });
  let state = null;
  let premiereAbsolue = null;
  const env = sc.garde === false ? ENV_SANS_GARDE : ENV_GARDE;
  for (let m = 0; m <= sc.dureeMin; m += 1) {
    t = START + m * MIN;
    tg.now = t;
    if (sc.correctifAppliqueMin !== undefined && m === sc.correctifAppliqueMin) cockpit.correctifApplique(sc.correctifCle, t);
    // Yasir répond dans le fil N minutes après la première urgence absolue.
    if (premiereAbsolue !== null && sc.yasirRepondApresMin !== undefined && t === premiereAbsolue.t + sc.yasirRepondApresMin * MIN) {
      tg.reponseDeYasir(premiereAbsolue.thread, t);
    }
    cockpit.tick(t);
    if (m % 5 === 0) {
      const site = sc.site(m);
      const out = await runOnce({
        fetchImpl: reseau({ tg, cockpit, site: () => site, now: () => t }), sleep: async () => {}, env,
        prevState: state === null ? null : JSON.parse(JSON.stringify(state)), nowMs: t, log: () => {},
      });
      state = JSON.parse(JSON.stringify(out.stateToWrite));
      if (out.exitCode !== 0) throw new Error(`passage en échec à +${m} min`);
      if (premiereAbsolue === null) {
        const a = tg.msgs.find((x) => x.text.startsWith('🚨'));
        if (a) premiereAbsolue = a;
      }
    }
  }
  return { tg, cockpit, state, premiereAbsolue };
}

// ───────────────────────────── scénarios ─────────────────────────────

const dansLeDelai = (i) => i.pris_en_charge_le !== null && i.pris_en_charge_le - i.detecte_le <= (i.niveau === 'urgent' ? 5 : 30) * MIN;
const absolues = (r) => r.tg.msgs.filter((x) => x.text.startsWith('🚨'));
const sonores = (r) => r.tg.msgs.filter((x) => !x.silent);

export const SCENARIOS = [
  {
    id: 1, nom: 'Incident urgent, agent principal réactif',
    site: (m) => (m >= 10 && m < 50 ? SITE.baseDown : SITE.ok), dureeMin: 140, principal: AGENTS.reactif(),
    verifier: (r) => {
      const [i] = r.cockpit.incs;
      return [[!!i, 'incident ouvert au cockpit'], [i && dansLeDelai(i), 'pris en charge en moins de 5 min'],
        [i && i.agent === PRINCIPAL, 'par l’agent principal'], [absolues(r).length === 0, 'aucune urgence absolue'],
        [i && i.etape === 'resolu', 'résolu par le watchdog après retour à la normale']];
    },
  },
  {
    id: 2, nom: 'Incident important, agent réactif',
    site: (m) => (m >= 10 && m < 190 ? SITE.vieux : SITE.ok), dureeMin: 280, principal: AGENTS.reactif({ prise: 10, diag: 60 }),
    verifier: (r) => {
      const [i] = r.cockpit.incs;
      return [[i && i.niveau === 'important', 'incident important'], [i && dansLeDelai(i), 'pris en charge en moins de 30 min'],
        [absolues(r).length === 0, 'aucune urgence absolue'], [sonores(r).length === 0, 'aucun message sonore (important = silencieux)']];
    },
  },
  {
    id: 3, nom: 'Agent principal arrêté pendant l’incident',
    site: (m) => (m >= 10 && m < 70 ? SITE.baseDown : SITE.ok), dureeMin: 160, principal: AGENTS.muet(),
    verifier: (r) => {
      const [i] = r.cockpit.incs;
      return [[i && i.relais && i.relais.resultat === 'declenchee', 'relais tiré'], [i && dansLeDelai(i), 'pris en charge en moins de 5 min (par le relais)'],
        [i && /relais/.test(i.agent || ''), 'responsable : agent relais'], [absolues(r).length === 0, 'aucune urgence absolue']];
    },
  },
  {
    id: 4, nom: 'API Claude indisponible',
    site: (m) => (m >= 10 && m < 70 ? SITE.baseDown : SITE.ok), dureeMin: 160, principal: AGENTS.apiIndisponible(),
    verifier: (r) => {
      const [i] = r.cockpit.incs;
      return [[i && i.principal.resultat === 'echec', 'échec du tir dit tout de suite'], [i && i.relais && i.relais.tire_le === i.principal.tire_le, 'relais tiré immédiatement'],
        [i && dansLeDelai(i), 'pris en charge en moins de 5 min'], [i && i.etape === 'resolu', 'résolu ensuite'], [absolues(r).length === 0, 'aucune urgence absolue']];
    },
  },
  {
    id: 5, nom: 'Deux incidents simultanés',
    site: (m) => (m >= 10 && m < 130 ? SITE.disque90Vieux : SITE.ok), dureeMin: 220, principal: AGENTS.reactif({ prise: 2, diag: 20 }),
    verifier: (r) => {
      const incs = r.cockpit.incs;
      const threads = new Set(incs.map((i) => i.telegram && i.telegram.thread_id));
      return [[incs.length === 2, 'deux incidents au cockpit'], [threads.size === 2, 'deux fils Telegram distincts'],
        [incs.every(dansLeDelai), 'chacun pris en charge dans son délai'], [absolues(r).length === 0, 'aucune urgence absolue']];
    },
  },
  {
    id: 6, nom: 'Agent qui se trompe de cause',
    site: (m) => (m >= 10 && m < 160 ? SITE.pageVide : SITE.ok), dureeMin: 250, principal: AGENTS.seTrompe(),
    correctifAppliqueMin: 30, correctifCle: 'site',
    verifier: (r) => {
      const [i] = r.cockpit.incs;
      const resoluAvant = r.tg.msgs.some((x) => x.text.startsWith('🟢 RÉSOLU') && x.t < START + 160 * MIN);
      return [[i && dansLeDelai(i), 'pris en charge en moins de 5 min'], [!resoluAvant, 'jamais « résolu » tant que le problème persiste'],
        [i && i.relais && /réfuté/.test(i.relais.motif), 'relais tiré avec le diagnostic réfuté'], [i && i.etape === 'resolu', 'résolu quand le problème disparaît vraiment'],
        [absolues(r).length === 0, 'aucune urgence absolue']];
    },
  },
  {
    id: 7, nom: 'Incident pris en charge mais jamais conclu',
    site: (m) => (m >= 10 && m < 190 ? SITE.baseDown : SITE.ok), dureeMin: 280, principal: AGENTS.jamaisConclu(),
    verifier: (r) => {
      const [i] = r.cockpit.incs;
      // Le dépassement est annoncé UNE fois : par le relais du cockpit s'il conclut, sinon par le watchdog.
      const depassement = r.tg.msgs.filter((x) => /pas de diagnostic depuis|aucun diagnostic dans le délai/.test(x.text));
      return [[i && dansLeDelai(i), 'pris en charge en moins de 5 min'], [depassement.length === 1, 'dépassement du délai de conclusion annoncé une seule fois'],
        [i && i.relais && /aucun diagnostic/.test(i.relais.motif), 'relais tiré'], [absolues(r).length === 0, 'aucune urgence absolue']];
    },
  },
  {
    id: '7b', nom: 'Jamais conclu, relais coupé : le watchdog prévient seul',
    site: (m) => (m >= 10 && m < 190 ? SITE.baseDown : SITE.ok), dureeMin: 280, principal: AGENTS.jamaisConclu(), relaisActif: false,
    verifier: (r) => {
      const [i] = r.cockpit.incs;
      const parLeWatchdog = r.tg.msgs.filter((x) => x.de === 'watchdog' && /pas de diagnostic depuis/.test(x.text));
      return [[i && dansLeDelai(i), 'pris en charge en moins de 5 min'], [parLeWatchdog.length === 1, 'le watchdog annonce le dépassement une seule fois'],
        [parLeWatchdog[0] && !parLeWatchdog[0].silent, 'sonore (incident urgent)'], [absolues(r).length === 0, 'aucune urgence absolue (l’incident a bien été pris)']];
    },
  },
  {
    id: 8, nom: 'Tous les agents coupés volontairement', attendUrgenceAbsolue: true,
    site: (m) => (m >= 10 && m < 130 ? SITE.baseDown : SITE.ok), dureeMin: 220, principal: AGENTS.muet(), relaisActif: false, yasirRepondApresMin: 25,
    verifier: (r) => {
      const abs = absolues(r);
      const apresReponse = r.premiereAbsolue ? abs.filter((x) => x.t > r.premiereAbsolue.t + 25 * MIN) : [];
      const ecarts = abs.slice(1).map((x, k) => x.t - abs[k].t);
      return [[abs.length >= 2, `urgence absolue émise (${abs.length} fois)`], [abs.every((x) => !x.silent), 'toujours sonore'],
        [ecarts.every((d) => d === 10 * MIN), 'répétée toutes les 10 min'], [apresReponse.length === 0, 'arrêtée dès la réponse de Yasir dans le fil'],
        [abs[0] && /agent relais coupé/.test(abs[0].text), 'nomme l’agent et la raison connue du silence']];
    },
  },
  {
    id: 9, nom: 'Cockpit injoignable pendant un incident', attendUrgenceAbsolue: true,
    site: (m) => (m >= 10 && m < 70 ? SITE.baseDown : SITE.ok), dureeMin: 160, principal: AGENTS.reactif(), cockpitDown: () => true, yasirRepondApresMin: 15,
    verifier: (r) => {
      const abs = absolues(r);
      const garde = r.tg.msgs.filter((x) => /garde du cockpit est injoignable/.test(x.text));
      return [[abs.length >= 1, `urgence absolue émise (${abs.length} fois)`], [abs[0] && /cockpit injoignable/.test(abs[0].text), 'raison : cockpit injoignable'],
        [garde.length === 1 && garde[0].silent, 'garde injoignable signalée une fois, en silencieux']];
    },
  },
  {
    id: 10, nom: 'Garde éteinte (GARDE_ACTIVE absent)', garde: false,
    site: (m) => (m >= 10 && m < 50 ? SITE.baseDown : SITE.ok), dureeMin: 140, principal: AGENTS.reactif(),
    verifier: (r) => [[r.cockpit.appels === 0, 'aucun appel au cockpit'], [r.tg.msgs.every((x) => x.chat === YASIR), 'messages dans la conversation privée, comme aujourd’hui'],
      [r.tg.topics.length === 0, 'aucun sujet créé'], [absolues(r).length === 0, 'aucune urgence absolue'], [r.tg.msgs.length === 2, 'partie 6 inchangée : ouverture + clôture']],
  },
];

/** Exécute tout le banc ; rend une ligne par scénario, échecs en premier. */
export async function executerBanc() {
  const lignes = [];
  for (const sc of SCENARIOS) {
    let verifs;
    let mesures = {};
    try {
      const r = await simuler(sc);
      verifs = sc.verifier(r).map(([ok, quoi]) => ({ ok: Boolean(ok), quoi }));
      mesures = {
        incidents: r.cockpit.incs.length,
        prisEnCharge: r.cockpit.incs.map((i) => (i.pris_en_charge_le ? `${Math.round((i.pris_en_charge_le - i.detecte_le) / MIN)} min (${i.premierAgent})` : 'jamais')),
        absolues: absolues(r).length,
        sonores: sonores(r).length,
        silencieux: r.tg.msgs.length - sonores(r).length,
      };
    } catch (e) {
      verifs = [{ ok: false, quoi: `erreur d’exécution : ${e.message}` }];
    }
    lignes.push({ id: sc.id, nom: sc.nom, ok: verifs.every((v) => v.ok), verifs, mesures, attendUrgenceAbsolue: Boolean(sc.attendUrgenceAbsolue) });
  }
  lignes.sort((a, b) => Number(a.ok) - Number(b.ok) || a.id - b.id);
  return lignes;
}

export function rapport(lignes) {
  const ok = lignes.filter((l) => l.ok).length;
  const out = [`# Banc d’essai partie 7 — ${ok}/${lignes.length} scénarios réussis (échecs en premier)`, ''];
  out.push('| # | Scénario | Résultat | Prise en charge | Urgences absolues | Sonores / silencieux |', '|---|---|---|---|---|---|');
  for (const l of lignes) {
    const m = l.mesures;
    out.push(`| ${l.id} | ${l.nom} | ${l.ok ? '✅ réussi' : '❌ ÉCHEC'} | ${(m.prisEnCharge || []).join(' ; ') || '—'} | ${m.absolues ?? '—'}${l.attendUrgenceAbsolue ? ' (attendu)' : ''} | ${m.sonores ?? '—'} / ${m.silencieux ?? '—'} |`);
  }
  out.push('', '## Détail des vérifications');
  for (const l of lignes) {
    out.push('', `**${l.id}. ${l.nom}** — ${l.ok ? 'réussi' : 'ÉCHEC'}`);
    for (const v of l.verifs) out.push(`- ${v.ok ? '✅' : '❌'} ${v.quoi}`);
  }
  const horsAttendu = lignes.filter((l) => !l.attendUrgenceAbsolue && (l.mesures.absolues ?? 0) > 0);
  out.push('', `Objectif mesuré : urgences absolues hors scénarios « agents coupés / cockpit injoignable » = ${horsAttendu.length} (attendu : 0).`);
  return out.join('\n');
}

if (process.argv[1] && import.meta.url === new URL(`file:///${process.argv[1].replace(/\\/g, '/')}`).href) {
  executerBanc().then((l) => {
    console.log(rapport(l));
    process.exitCode = l.every((x) => x.ok) ? 0 : 1;
  });
}
