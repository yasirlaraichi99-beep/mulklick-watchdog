// Banc d'essai de la partie 7, scénario par scénario (voir banc-garde.mjs).
//   node --test garde.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SCENARIOS, simuler } from './banc-garde.mjs';

for (const sc of SCENARIOS) {
  test(`PARTIE 7 — scénario ${sc.id} : ${sc.nom}`, async () => {
    const r = await simuler(sc);
    for (const [ok, quoi] of sc.verifier(r)) assert.ok(ok, quoi);
  });
}
