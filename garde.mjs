// LA GARDE, CÔTÉ WATCHDOG — partie 7 (prise en charge des incidents par des agents).
//
// Inerte tant que la variable de dépôt GARDE_ACTIVE n'est pas « true » (posée par Yasir quand le
// banc d'essai est réussi et la garde du cockpit allumée). Sans elle, le watchdog se comporte
// exactement comme avant (partie 6) : rien de ce module n'est appelé.
//
// Avec elle, à chaque passage :
//   1. il lit l'état des incidents suivis par le cockpit (route B) et les réponses de Yasir dans
//      les sujets Telegram (getUpdates) ;
//   2. chaque incident a SON sujet dans le groupe « Incidents Mulklick » : le watchdog le crée à
//      l'ouverture, y poste ses messages, puis signale l'incident au cockpit (route A), qui tire
//      l'agent de garde ;
//   3. il vérifie LUI-MÊME les délais (urgent : pris en charge en 5 min ; important : 30 min ;
//      diagnostic rendu 60 min / 24 h après la prise en charge). Personne n'a pris l'incident à
//      temps → URGENCE ABSOLUE, sonore, répétée toutes les 10 min jusqu'à ce que Yasir réponde
//      dans le sujet. Le contrôle ne dépend ni des agents, ni du cockpit : cockpit injoignable =
//      urgence absolue « cockpit injoignable ».
//
// Contrat des routes et des champs : docs du cockpit, « garde-mulklick-contrat.md ». Aucun jeton
// n'est journalisé ; les URL du cockpit ne sont jamais écrites dans le journal public du run.

const MIN = 60_000;
const HOUR = 60 * MIN;

export const GARDE_CFG = {
  takeMs: { urgent: 5 * MIN, important: 30 * MIN },
  concludeMs: { urgent: 60 * MIN, important: 24 * HOUR },
  absoluteRepeatMs: 10 * MIN,
  cockpitTimeoutMs: 10_000,
  // Clés que le watchdog confie au cockpit (contrat §3.A). « garde » (cockpit injoignable) ne
  // peut évidemment pas être confiée au cockpit.
  cles: ['base', 'site', 'fraicheur', 'disque', 'disque_lecture', 'relais'],
};

const ETAT_PAR_GENRE = { open: 'ouvert', recur: 'ouvert', worse: 'aggrave', better: 'ameliore', close: 'resolu' };

export function gardeActive(env) {
  return String(env.GARDE_ACTIVE ?? '').toLowerCase() === 'true';
}

function gardeConfiguree(env) {
  return Boolean(env.COCKPIT_API_URL && env.COCKPIT_WATCHDOG_TOKEN && env.CF_ACCESS_CLIENT_ID
    && env.CF_ACCESS_CLIENT_SECRET && env.TELEGRAM_INCIDENTS_CHAT_ID);
}

export function initGarde(g) {
  return {
    offset: 0, topics: {}, closedTopics: {}, acks: {}, ackSent: {}, lastAbsolute: {},
    concludeWarned: {}, unsynced: {}, ...(g && typeof g === 'object' ? g : {}),
  };
}

function fmtUtc(ms) {
  const d = new Date(ms).toISOString();
  return `${d.slice(8, 10)}.${d.slice(5, 7)} ${d.slice(11, 16)} UTC`;
}

function fmtDuree(ms) {
  const min = Math.max(0, Math.round(ms / MIN));
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${String(min % 60).padStart(2, '0')}` : `${h} h`;
}

function errText(e) {
  if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) return 'délai dépassé';
  return 'erreur réseau';
}

// ───────────────────────────── cockpit ─────────────────────────────

/** Appel au cockpit. Rend { ok, json } ou { ok:false, err } — l'erreur ne contient ni URL ni jeton. */
export async function cockpit({ fetchImpl, env, method, path, body }) {
  const url = `${String(env.COCKPIT_API_URL).replace(/\/$/, '')}${path}`;
  let res;
  try {
    res = await fetchImpl(url, {
      method,
      headers: {
        authorization: `Bearer ${env.COCKPIT_WATCHDOG_TOKEN}`,
        'cf-access-client-id': env.CF_ACCESS_CLIENT_ID,
        'cf-access-client-secret': env.CF_ACCESS_CLIENT_SECRET,
        'content-type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(GARDE_CFG.cockpitTimeoutMs),
    });
  } catch (e) {
    return { ok: false, err: errText(e) };
  }
  let json = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  if (res.status !== 200) return { ok: false, err: `HTTP ${res.status}${json && json.detail ? ` ${String(json.detail).slice(0, 60)}` : ''}` };
  return { ok: true, json };
}

// ───────────────────────────── avant les contrôles ─────────────────────────────

/**
 * Lit l'état du cockpit et les réponses de Yasir. Rend { garde, list, err, resultat } ;
 * `resultat` est le contrôle « G » ajouté aux résultats du passage.
 */
export async function gardeAvant({ fetchImpl, env, prevGarde, tg, log = () => {} }) {
  const garde = initGarde(prevGarde ? structuredClone(prevGarde) : null);
  if (!gardeConfiguree(env)) {
    return { garde, list: null, err: 'configuration incomplète', resultat: { id: 'G', status: 'warn', value: 'configuration de la garde incomplète' } };
  }
  // Réponses de Yasir dans les sujets d'incident (accusés de réception).
  try {
    const updates = await tg.api('getUpdates', { offset: garde.offset, timeout: 0, allowed_updates: ['message'] });
    const parTopic = Object.fromEntries(Object.entries(garde.topics).map(([k, t]) => [String(t.threadId), k]));
    for (const u of updates || []) {
      garde.offset = Math.max(garde.offset, (u.update_id ?? 0) + 1);
      const m = u.message;
      if (!m || String(m.chat?.id) !== String(env.TELEGRAM_INCIDENTS_CHAT_ID)) continue;
      if (String(m.from?.id) !== String(env.TELEGRAM_CHAT_ID)) continue; // seul Yasir acquitte
      const key = parTopic[String(m.message_thread_id)];
      if (key) garde.acks[key] = (m.date ?? 0) * 1000;
    }
  } catch (e) {
    log(`Garde : réponses Telegram illisibles (${e.message}).`);
  }
  const r = await cockpit({ fetchImpl, env, method: 'GET', path: '/admin/oncall/watchdog/incidents' });
  if (!r.ok || !r.json || !Array.isArray(r.json.incidents)) {
    const err = r.err ?? 'réponse illisible';
    return { garde, list: null, err, resultat: { id: 'G', status: 'warn', value: `cockpit : ${err}` } };
  }
  return { garde, list: r.json.incidents, err: null, resultat: { id: 'G', status: 'ok', value: `${r.json.incidents.length} incident(s) suivi(s) par le cockpit` } };
}

// ───────────────────────────── fils Telegram ─────────────────────────────

/** Où envoyer un message : le sujet de son incident (créé au besoin), sinon le sujet général. */
export async function destination({ tg, env, garde, m, nowMs }) {
  const chatId = env.TELEGRAM_INCIDENTS_CHAT_ID;
  if (!m.inc || !m.kind || !GARDE_CFG.cles.concat('garde').includes(m.key)) return { chatId, threadId: null };
  let topic = garde.topics[m.key];
  if (!topic && m.kind === 'recur' && garde.closedTopics[m.key]) {
    topic = garde.closedTopics[m.key]; // une récidive reprend le fil de l'incident d'origine
    garde.topics[m.key] = topic;
    delete garde.closedTopics[m.key];
  }
  if (!topic) {
    const icone = m.inc.level === 'urgent' ? '🔴' : '🟠';
    const nom = `${icone} ${String(m.inc.what).replace(/\s+/g, ' ').slice(0, 90)} — ${fmtUtc(m.since ?? nowMs)}`.slice(0, 128);
    const r = await tg.api('createForumTopic', { chat_id: chatId, name: nom });
    topic = { threadId: r.message_thread_id, createdAt: nowMs };
    garde.topics[m.key] = topic;
  }
  return { chatId, threadId: topic.threadId };
}

/** Après l'envoi d'un message d'incident : le signaler au cockpit (route A). Échec = rattrapé au passage suivant. */
export async function signaler({ fetchImpl, env, garde, m, dest, messageId, log = () => {} }) {
  const etat = ETAT_PAR_GENRE[m.kind];
  if (!etat || !GARDE_CFG.cles.includes(m.key)) return;
  const corps = {
    cle: m.key,
    niveau: m.inc.level,
    etat,
    quoi: String(m.inc.what).slice(0, 300),
    gravite: String(m.inc.gravity ?? '').slice(0, 300),
    action: String(m.action ?? '').slice(0, 300),
    detecte_le: new Date(m.since).toISOString(),
    telegram: { chat_id: String(dest.chatId), thread_id: dest.threadId, message_id: messageId },
  };
  if (garde.acks[m.key]) corps.acquitte_le = new Date(garde.acks[m.key]).toISOString();
  // Le dernier signal complet est gardé : un accusé de réception ultérieur le renvoie tel quel
  // (le cockpit exige niveau, quoi et detecte_le à chaque signal).
  if (m.kind !== 'close') garde.corps = { ...(garde.corps || {}), [m.key]: { ...corps, etat: 'ouvert' } };
  const r = await cockpit({ fetchImpl, env, method: 'POST', path: '/admin/oncall/watchdog/incidents', body: corps });
  if (r.ok) delete garde.unsynced[m.key];
  else {
    garde.unsynced[m.key] = corps;
    log(`Garde : signal « ${m.key} » non reçu par le cockpit (${r.err}), renvoyé au passage suivant.`);
  }
  if (m.kind === 'close') {
    garde.closedTopics[m.key] = garde.topics[m.key];
    delete garde.topics[m.key];
    for (const k of ['acks', 'ackSent', 'lastAbsolute', 'concludeWarned']) delete garde[k][m.key];
    if (garde.corps) delete garde.corps[m.key];
  }
}

/** Renvoie les signaux non reçus et les accusés de réception de Yasir pas encore transmis. */
export async function rattraper({ fetchImpl, env, garde, log = () => {} }) {
  for (const [key, corps] of Object.entries(garde.unsynced)) {
    const r = await cockpit({ fetchImpl, env, method: 'POST', path: '/admin/oncall/watchdog/incidents', body: corps });
    if (r.ok) delete garde.unsynced[key];
    else log(`Garde : signal « ${key} » toujours non reçu (${r.err}).`);
  }
  for (const [key, ts] of Object.entries(garde.acks)) {
    const dernier = garde.corps && garde.corps[key];
    if (garde.ackSent[key] === ts || garde.unsynced[key] || !dernier) continue;
    const r = await cockpit({ fetchImpl, env, method: 'POST', path: '/admin/oncall/watchdog/incidents', body: { ...dernier, acquitte_le: new Date(ts).toISOString() } });
    if (r.ok) garde.ackSent[key] = ts;
    else log(`Garde : réponse de Yasir sur « ${key} » non transmise au cockpit (${r.err}).`);
  }
}

// ───────────────────────────── délais ─────────────────────────────

/**
 * Les délais, vérifiés par le watchdog lui-même. Rend des messages SONORES à poster dans le sujet
 * de l'incident : { key, text, threadId, sound: true, commit(garde) }.
 * `incidents` = incidents ouverts selon le watchdog (state.incidents) ; `list` = vue du cockpit,
 * ou null si le cockpit est injoignable (`err`).
 */
export function planDelais({ garde, incidents, list, err, nowMs, cfg = GARDE_CFG }) {
  const out = [];
  for (const [key, inc] of Object.entries(incidents)) {
    if (!cfg.cles.includes(key)) continue;
    const topic = garde.topics[key];
    if (!topic) continue;
    const level = inc.level === 'urgent' ? 'urgent' : 'important';
    const obj = list ? list.find((o) => o.cle === key && o.etape !== 'resolu') : null;
    const acked = garde.acks[key] && garde.acks[key] >= inc.openedAt;

    // a) Personne n'a pris l'incident à temps → URGENCE ABSOLUE.
    let late = null;
    if (obj) {
      const echeance = Date.parse(obj.echeance_prise_en_charge);
      if (!obj.pris_en_charge_le && Number.isFinite(echeance) && nowMs > echeance) {
        const agent = obj.agent_relais && obj.agent_relais.tire_le ? 'agent relais' : 'agent principal (routine On-Call)';
        late = { depuis: echeance, agent, raison: obj.raison_silence || 'aucune raison connue' };
      }
    } else {
      const echeance = inc.openedAt + cfg.takeMs[level];
      if (nowMs > echeance) {
        const raison = list === null
          ? `cockpit injoignable (${err})`
          : garde.unsynced[key] ? 'le cockpit n’a pas enregistré l’incident' : 'incident absent du cockpit';
        late = { depuis: echeance, agent: 'agent principal (routine On-Call)', raison };
      }
    }
    if (late && !acked && (!garde.lastAbsolute[key] || nowMs - garde.lastAbsolute[key] >= cfg.absoluteRepeatMs)) {
      out.push({
        key, threadId: topic.threadId, sound: true, kind: 'absolue',
        text: [
          `🚨 URGENCE ABSOLUE — personne n’a pris l’incident « ${inc.what ?? key} », détecté le ${fmtUtc(inc.openedAt)} (délai de ${cfg.takeMs[level] / MIN} min dépassé de ${fmtDuree(nowMs - late.depuis)}).`,
          `Agent attendu : ${late.agent} — raison connue : ${late.raison}.`,
          'Action : réponds dans ce fil pour arrêter cette alerte (répétée toutes les 10 min), puis prends l’incident en main.',
        ].join('\n'),
        commit: (g) => {
          g.lastAbsolute[key] = nowMs;
        },
      });
    }

    // b) Pris en charge, mais aucun diagnostic dans le délai → un seul message, et SEULEMENT si le
    //    cockpit n'a pas déjà passé la main (relais exécuté, ou incident remis à Yasir) : c'est le
    //    filet de sécurité quand la tâche planifiée du cockpit ne fait plus son travail.
    const dejaRelaye = (obj && obj.agent_relais && obj.agent_relais.tire_le) || (obj && ['a_yasir', 'releve'].includes(obj.etape));
    if (obj && obj.pris_en_charge_le && !obj.diagnostique_le && !dejaRelaye && !garde.concludeWarned[key]) {
      const pris = Date.parse(obj.pris_en_charge_le);
      if (Number.isFinite(pris) && nowMs - pris > cfg.concludeMs[level]) {
        out.push({
          key, threadId: topic.threadId, sound: level === 'urgent', kind: 'conclusion',
          text: [
            `${level === 'urgent' ? '🔴 URGENT' : '🟠 IMPORTANT'} — pris en charge par ${obj.agent || 'un agent'} le ${fmtUtc(pris)}, pas de diagnostic depuis ${fmtDuree(nowMs - pris)}.`,
            `Gravité : le délai de conclusion (${fmtDuree(cfg.concludeMs[level])}) est dépassé ; le cockpit passe la main à l’agent relais.`,
            'Action : rien si le relais conclut ; sinon, ouvrir l’incident dans le cockpit.',
          ].join('\n'),
          commit: (g) => {
            g.concludeWarned[key] = true;
          },
        });
      }
    }
  }
  return out;
}
