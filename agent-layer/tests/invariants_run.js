#!/usr/bin/env node
/*
 * INVARIANTS / PROPERTY TESTS (Master Plan workstream Q4a) - RM repo.  PER-TOOL; not in the shared hash-lock.
 *
 *   node agent-layer/tests/invariants_run.js [--report]
 *
 * Runs thousands of seeded random inputs through the read-only engine exports and checks properties that SHOULD always hold.
 * Two kinds of property:
 *   MUST-HOLD   properties of the export itself and of the documented design (bounds, determinism, purity, order-independence,
 *               case-insensitivity, the 4-delivery-model short-circuit...). A violation FAILS this test.
 *   FINDING     properties a user would reasonably EXPECT of the tool that the current engine does not guarantee (for example "marking a
 *               gate passed never lowers readiness"). A violation is reported with a counterexample but does not fail the test: it is
 *               a candidate for the signed-off engine-fix workstream. Nothing here changes any engine.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeContext, rng } = require('./parity_run.js');

const WRITE = process.argv.includes('--report');
const M = makeContext();
const E = M.E, tables = M.b.tables;
const J = (v) => JSON.stringify(v);
const pick = (r, a) => a[Math.floor(r() * a.length)];
const ENV_ALL = ['DEV', 'SIT', 'UAT', 'PRE-PROD', 'PROD'], GATE_IDS = ['dev-complete', 'code-review', 'sit', 'uat', 'preprod', 'gng', 'deploy', 'hypercare'];
const GATE_STATUS = ['not-started', 'pending', 'in-progress', 'passed', 'failed', 'waived'], HEALTH = ['unknown', 'healthy', 'warning', 'blocked'];
const DM_ALL = ['cloud', 'api', 'mobile', 'desktop', 'legacy', 'di2', 'cwa', 'pilot'];

let mustPass = 0; const mustFail = []; const findings = [];
function must(c, m) { if (c) mustPass++; else { mustFail.push(m); if (mustFail.length <= 20) console.log('  MUST-HOLD VIOLATED:', m); } }
function finding(id, title, ok, ctx, total) { const f = findings.find((x) => x.id === id) || (findings[findings.push({ id, title, checked: 0, violations: 0, examples: [] }) - 1]); f.checked++; if (!ok) { f.violations++; if (f.examples.length < 3) f.examples.push(ctx); } }

const rd = rng(1234);
function randReadiness() {
  const n = 1 + Math.floor(rd() * 8);
  const gates = Array.from({ length: n }, (_, i) => ({ id: GATE_IDS[i % 8], status: pick(rd, GATE_STATUS), signedBy: rd() < 0.5 ? 'S' : '' }));
  const envPath = ENV_ALL.slice().sort(() => rd() - 0.5).slice(0, 1 + Math.floor(rd() * 5));
  return { gates, defects: Array.from({ length: Math.floor(rd() * 5) }, () => ({ releaseId: 'R', classification: pick(rd, ['blocker', 'blocker', 'deferred', 'known', 'wontfix']) })),
    envPath, environments: envPath.filter(() => rd() < 0.8).map((e) => ({ env: e, health: pick(rd, HEALTH) })) };
}
const score = (i) => { const e = E.run('readiness', i); return e.status === 'computed' ? e.output : null; };
const clone = (v) => JSON.parse(JSON.stringify(v));

console.log('readiness');
for (let k = 0; k < 6000; k++) {
  const inp = randReadiness(), before = J(inp), o = score(inp);
  must(o !== null, 'valid readiness input computes: ' + before);
  if (!o) continue;
  must(J(inp) === before, 'readiness does not mutate its input');
  must(J(score(inp)) === J(o), 'readiness is deterministic');
  must(['score', 'gates', 'defects', 'envs', 'signoffs'].every((f) => Number.isInteger(o[f]) && o[f] >= 0 && o[f] <= 100), 'readiness components are integers in 0..100: ' + J(o));
  must(o.defects === ({ 0: 100, 1: 60, 2: 30 })[inp.defects.filter((d) => d.classification === 'blocker').length] || (inp.defects.filter((d) => d.classification === 'blocker').length >= 3 && o.defects === 0), 'defect component follows the documented 100/60/30/0 steps');
  const sh = clone(inp); sh.gates.reverse(); sh.defects.reverse(); sh.environments.reverse();
  must(J(score(sh)) === J(o), 'readiness does not depend on the order of gates / defects / environment entries');
  // FINDINGS (expectations a user would reasonably have)
  const more = clone(inp); more.defects.push({ releaseId: 'R', classification: 'blocker' });
  finding('F-RM-1', 'Adding a release-blocking defect never raises readiness', score(more).score <= o.score, { before: J(inp).slice(0, 160), score: o.score, after: score(more).score });
  const idx = inp.gates.findIndex((g) => g.status !== 'passed' && g.status !== 'waived');
  if (idx >= 0) {
    const passed = clone(inp); passed.gates[idx].status = 'passed';
    const p = score(passed);
    finding('F-RM-2', 'Marking a gate passed never LOWERS readiness (even when no one has signed it off yet)', p.score >= o.score, { gate: idx, before: o.score, after: p.score, gates: J(inp.gates), signoffs: o.signoffs + ' -> ' + p.signoffs });
    const signedPassed = clone(passed); signedPassed.gates[idx].signedBy = 'S';
    finding('F-RM-3', 'Marking a gate passed AND signed never lowers readiness', score(signedPassed).score >= o.score, { gate: idx, before: o.score, after: score(signedPassed).score });
  }
  const e0 = inp.environments.findIndex((e) => e.health !== 'healthy');
  if (e0 >= 0) { const h = clone(inp); h.environments[e0].health = 'healthy'; finding('F-RM-4', 'An environment becoming healthy never lowers readiness', score(h).score >= o.score, { before: o.score, after: score(h).score }); }
  if (inp.gates.length) {   // characterisation (not an expectation): a FAILED gate scores exactly like a pending one - the engine does not distinguish them
    const f1 = clone(inp), f2 = clone(inp); f1.gates[0].status = 'failed'; f2.gates[0].status = 'pending'; f1.gates[0].signedBy = f2.gates[0].signedBy = '';
    must(J(score(f1)) === J(score(f2)), 'characterised: a failed gate scores the same as a pending gate');
  }
}

console.log('release_hint / defect_hint');
const relRules = tables.RELEASE_AI_RULES;
const words = ['payment', 'login', 'database', 'urgent', 'ios', 'gdpr', 'supplier', 'canary', 'decommission', 'update', 'tidy', 'quarterly', 'the', 'a'];
for (let k = 0; k < 4000; k++) {
  const name = Array.from({ length: 1 + Math.floor(rd() * 4) }, () => pick(rd, words)).join(' ');
  const dms = rd() < 0.3 ? DM_ALL.filter(() => rd() < 0.5) : [];
  const base = E.run('release_hint', { name, notes: '', deliveryModels: dms });
  must(base.status === 'computed', 'release hint computes');
  const swap = (s) => J(E.run('release_hint', { name: s, notes: '', deliveryModels: dms }));
  must(swap(name.toUpperCase()) === J(base) && swap(name.toLowerCase()) === J(base), 'release hint is case-insensitive: ' + name);
  must(swap(name + ' quarterly tidy the') === swap(name + ' quarterly tidy the') && J(E.run('release_hint', { name: name + ' tidy the update', notes: '', deliveryModels: dms }).output.rule) === J(base.output.rule), 'appending neutral words never changes the hint: ' + name);
  if (dms.length >= 4) must(base.output.rule === 'dm_complexity', 'four or more delivery models always give the complexity hint first');
  else if (base.output.matched) must(base.output.rule === 'release_rule_' + relRules.findIndex((r) => r.pattern.test(name.toLowerCase() + ' ')), 'first matching rule wins');
  const d = E.run('defect_hint', { title: name + ' in the app' });
  must(d.status === 'computed' || d.status === 'not_assessed', 'defect hint returns a status');
}

console.log('gate_hint / risk_score');
for (let k = 0; k < 3000; k++) {
  const gateId = pick(rd, GATE_IDS), def = tables.GATE_DEFS[gateId], et = def.entryCriteria.length, xt = def.exitCriteria.length;
  const inp = { gateId, entryConfirmed: Math.floor(rd() * (et + 1)), exitConfirmed: Math.floor(rd() * (xt + 1)), blockerCount: Math.floor(rd() * 4), preProdVersion: pick(rd, ['', '1', '2']), prodVersion: pick(rd, ['', '1', '2']), deliveryModels: DM_ALL.filter(() => rd() < 0.3) };
  const o = E.run('gate_hint', inp), n = o.output.hints.length;
  const more = Object.assign({}, inp, { entryConfirmed: Math.min(et, inp.entryConfirmed + 1) });
  must(E.run('gate_hint', more).output.hints.length <= n, 'confirming another entry criterion never adds hints');
  must(o.output.hints.every((h, i, a) => a.findIndex((x) => x.kind === h.kind) === i), 'no hint appears twice');
  const full = Object.assign({}, inp, { entryConfirmed: et, exitConfirmed: xt });
  must(!E.run('gate_hint', full).output.hints.some((h) => h.kind === 'entry_unconfirmed' || h.kind === 'exit_unconfirmed'), 'with every criterion confirmed there is no "not yet confirmed" hint');
}
for (let l = 1; l <= 5; l++) for (let i = 1; i <= 5; i++) {
  const o = E.run('risk_score', { likelihood: l, impact: i }).output, t = E.run('risk_score', { likelihood: i, impact: l }).output;
  must(J(o) === J(t), 'risk score is symmetric in likelihood and impact');
  if (l < 5) must(E.run('risk_score', { likelihood: l + 1, impact: i }).output.score > o.score, 'risk score rises with likelihood');
}

console.log(`\nmust-hold: ${mustPass} passed, ${mustFail.length} violated`);
console.log('findings (expectations the current engine does not guarantee):');
findings.forEach((f) => console.log(`  ${f.id} ${f.violations ? 'VIOLATED' : 'holds'}  ${f.violations}/${f.checked}  ${f.title}` + (f.violations ? '\n      e.g. ' + J(f.examples[0]).slice(0, 300) : '')));

if (WRITE) {
  const L = ['# Invariants / property-test findings - Release Management tool', '', '*Generated by `agent-layer/tests/invariants_run.js` (seeded, reproducible). Nothing in the tool has been changed.*', '',
    '**Must-hold properties** (bounds, determinism, no mutation of input, order-independence, case-insensitivity, first-match-wins, the delivery-model short-circuit): **' + mustPass + ' checks passed, ' + mustFail.length + ' violated.**', '',
    '**Findings** - things a user would reasonably expect that the current engine does not guarantee. Each is a candidate for the signed-off engine-fix workstream (not applied):', '',
    '| ID | Expectation | Violations / cases checked | Example |', '|---|---|---|---|'];
  findings.forEach((f) => L.push(`| ${f.id} | ${f.title} | ${f.violations} / ${f.checked} | ${f.violations ? '`' + J(f.examples[0]).slice(0, 220).replace(/\|/g, '/') + '`' : '-'} |`));
  L.push('');
  fs.writeFileSync(path.join(__dirname, '..', '..', 'INVARIANT-FINDINGS.md'), L.join('\n'), 'utf8');
  console.log('wrote INVARIANT-FINDINGS.md');
}
process.exit(mustFail.length ? 1 : 0);
