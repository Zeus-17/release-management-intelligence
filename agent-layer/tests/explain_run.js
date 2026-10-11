#!/usr/bin/env node
/*
 * "Why this result, and what would change it" tests (W1) - RM repo, per-tool file.
 *   node agent-layer/tests/explain_run.js
 * Runs the tool's REAL source (extracted from rm-tool-v1.html) in a VM. The explanation must never disagree with the score it explains:
 *   - the parts add up to the score;
 *   - every "what if" is checked by applying the described change a SECOND way (written here, not taken from the tool) and recomputing with the real calculateReadiness;
 *   - the inputs are never changed; the saved defects are never touched;
 *   - not-assessed releases get no invented number.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const html = fs.readFileSync(path.resolve(ROOT, cfg.html), 'utf8').replace(/\r\n/g, '\n');
const i0 = html.indexOf('<!-- AGENT-LAYER:BEGIN');
const src = i0 === -1 ? html : html.slice(0, i0);

function declaration(name) {
  const lines = src.split('\n');
  const isFn = (l) => l.startsWith('function ' + name + '(');
  const isConst = (l) => l.startsWith('const ' + name + ' =') || l.startsWith('let ' + name + ' =');
  const starts = []; lines.forEach((l, k) => { if (isFn(l) || isConst(l)) starts.push(k); });
  if (starts.length !== 1) throw new Error('declaration "' + name + '" found ' + starts.length + ' times');
  const s = starts[0], fn = isFn(lines[s]);
  if (fn) { const one = lines[s]; if (/\}\s*$/.test(one) && one.split('{').length === one.split('}').length) return one; }
  for (let j = s; j < lines.length; j++) { const l = lines[j]; if (fn ? l === '}' : /^[\]}];?$/.test(l)) return lines.slice(s, j + 1).join('\n'); }
  throw new Error('no end for ' + name);
}
const NAMES = ['DEFECT_STATUS_DEFS', 'GATE_DEFS'];
const FNS = ['_filled', 'defectStatusKey', 'defectHasDecision', 'defectHasConfirmation', 'isUnresolvedBlocker', 'calculateReadiness', 'readinessBandName', 'explainReadiness'];
const ctx = vm.createContext({ console });
vm.runInContext(['const STATE = { defects: [] };'].concat(NAMES.map(declaration)).concat(FNS.map(declaration)).join('\n') + '\nvar __b = { STATE, GATE_DEFS, calculateReadiness, explainReadiness, readinessBandName, isUnresolvedBlocker };', ctx, { filename: 'tool-real-source' });
const T = ctx.__b;

let pass = 0; const failures = [];
function ok(c, m) { if (c) pass++; else { failures.push(m); if (failures.length <= 30) console.log('  FAIL:', m); } }
const J = (v) => JSON.stringify(v);
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach((k) => deepFreeze(o[k])); } return o; }

const GATE_IDS = Object.keys(T.GATE_DEFS), ENVS = ['DEV', 'SIT', 'UAT', 'PRE-PROD', 'PROD'];
const GST = ['not-started', 'pending', 'in-progress', 'passed', 'failed', 'waived'], HEALTH = ['unknown', 'healthy', 'warning', 'blocked'];

function mk(r) {
  const n = 1 + Math.floor(r() * 8);
  const gates = GATE_IDS.slice().sort(() => r() - 0.5).slice(0, n).map((id) => ({ id, status: pick(r, GST), signedBy: r() < 0.5 ? 'Someone' : '' }));
  const envPath = ENVS.slice().sort(() => r() - 0.5).slice(0, 1 + Math.floor(r() * 5));
  const environments = {}; envPath.forEach((e) => { if (r() < 0.8) environments[e] = { health: pick(r, HEALTH), version: 'v' }; });
  const defects = Array.from({ length: Math.floor(r() * 5) }, (_, k) => {
    const d = { id: 'd' + k, releaseId: 'REL', title: 'Defect ' + k, classification: pick(r, ['blocker', 'blocker', 'deferred', 'known', 'wontfix']) };
    if (r() < 0.4) { d.status = pick(r, ['open', 'fix_in_progress', 'fixed_unverified', 'resolved_confirmed', 'accepted', 'duplicate']); if (r() < 0.5) d.decision = { by: 'P', reason: 'R' }; if (r() < 0.5) d.confirmation = { by: 'S' }; }
    return d;
  });
  defects.push({ id: 'other', releaseId: 'OTHER', title: 'Not this release', classification: 'blocker' });
  return { rel: { id: 'REL', name: 'Rel', gates, envPath, environments }, defects };
}

// the described change, applied independently of the tool's own code
function applyDescribed(rel, defects, a) {
  const r = JSON.parse(JSON.stringify(rel)); let d = defects.slice();
  if (a.kind === 'pass_gate') { for (const g of r.gates) if (g.id === a.id) { g.status = 'passed'; g.signedBy = 'someone'; } }
  else if (a.kind === 'sign_gate') { for (const g of r.gates) if (g.id === a.id) g.signedBy = 'someone'; }
  else if (a.kind === 'resolve_blocker') { d = d.filter((x) => x.id !== a.id); }
  else if (a.kind === 'env_healthy') { r.environments[a.id] = Object.assign({ version: '' }, r.environments[a.id], { health: 'healthy' }); }
  else throw new Error('unknown action kind ' + a.kind);
  return { rel: r, defects: d };
}

const rd = rng(2026);
let nExplained = 0, nActions = 0, nPaths = 0;
for (let k = 0; k < 2500; k++) {
  const { rel, defects } = mk(rd);
  const real = T.calculateReadiness(rel, defects);
  deepFreeze(rel); deepFreeze(defects);
  const savedDefects = J(T.STATE.defects);
  let ex; try { ex = T.explainReadiness(rel, defects); } catch (e) { ok(false, 'case ' + k + ' threw: ' + e.message); continue; }
  ok(J(T.STATE.defects) === savedDefects, 'case ' + k + ': saved defects untouched');
  if (real.notAssessed) { ok(ex.notAssessed === true && ex.score === undefined, 'case ' + k + ': not assessed -> no number'); continue; }
  nExplained++;
  ok(ex.notAssessed === false && ex.score === real.score, 'case ' + k + ': the score equals the real score');
  const total = ex.components.reduce((s, c) => s + c.points, 0);
  ok(Math.round(total) === ex.score, 'case ' + k + ': the parts add up to the score (' + total + ' vs ' + ex.score + ')');
  ok(ex.components.every((c) => Math.abs(c.points + c.lost - c.weight) < 1e-9), 'case ' + k + ': adds + left out = weight');
  ok(ex.components.map((c) => c.weight).join() === '40,30,20,10', 'case ' + k + ': weights are the tool\'s 40/30/20/10');
  ok(ex.components[0].value === real.gates && ex.components[1].value === real.defects && ex.components[2].value === real.envs && ex.components[3].value === real.signoffs, 'case ' + k + ': each part equals the real part');
  ok(ex.band === (real.score >= 75 ? 'green' : real.score >= 50 ? 'amber' : 'red'), 'case ' + k + ': band');
  ex.actions.forEach((a) => {
    nActions++;
    const st = applyDescribed(rel, defects, a);
    const again = T.calculateReadiness(st.rel, st.defects).score;
    ok(again === a.newScore, 'case ' + k + ': "' + a.text + '" claims ' + a.newScore + ' but applying it gives ' + again);
    ok(a.delta === a.newScore - real.score && a.delta > 0, 'case ' + k + ': delta is positive and exact');
    ok(a.newBand === (a.newScore >= 75 ? 'green' : a.newScore >= 50 ? 'amber' : 'red') && a.crossesBand === (a.newBand !== ex.band), 'case ' + k + ': band claims');
  });
  ok(ex.actions.every((a, i, arr) => i === 0 || arr[i - 1].newScore >= a.newScore), 'case ' + k + ': best first');
  // completeness, enumerated independently here: the best six single changes (by resulting score) must be exactly what the tool lists
  const all = [];
  rel.gates.forEach((g) => { if (g.status !== 'passed' && g.status !== 'waived') all.push({ kind: 'pass_gate', id: g.id }); else if (g.status === 'passed' && !g.signedBy) all.push({ kind: 'sign_gate', id: g.id }); });
  const ob = defects.filter((x) => x.releaseId === 'REL' && T.isUnresolvedBlocker(x)); if (ob.length) all.push({ kind: 'resolve_blocker', id: ob[0].id });
  rel.envPath.forEach((e) => { if (!(rel.environments[e] && rel.environments[e].health === 'healthy')) all.push({ kind: 'env_healthy', id: e }); });
  const best = all.map((x) => { const st = applyDescribed(rel, defects, x); return T.calculateReadiness(st.rel, st.defects).score; }).filter((sc) => sc > real.score).sort((x, y) => y - x).slice(0, 6);
  ok(J(best) === J(ex.actions.map((x) => x.newScore)), 'case ' + k + ': the list is complete: independent best-six ' + J(best) + ' vs tool ' + J(ex.actions.map((x) => x.newScore)));
  if (real.score >= 75) ok(ex.path === null, 'case ' + k + ': green has no next band');
  else {
    nPaths++;
    const target = real.score >= 50 ? 75 : 50;
    ok(ex.path && ex.path.target === target, 'case ' + k + ': next band target');
    let st = { rel, defects }, prev = real.score;
    ex.path.steps.forEach((s) => {
      st = applyDescribed(st.rel, st.defects, s);
      const sc = T.calculateReadiness(st.rel, st.defects).score;
      ok(sc === s.scoreAfter && sc > prev, 'case ' + k + ': path step "' + s.text + '" claims ' + s.scoreAfter + ', applying gives ' + sc);
      prev = sc;
    });
    ok(ex.path.reached === (prev >= target), 'case ' + k + ': "reached" is true only if the score really got there');
    ok(ex.path.steps.length <= 8, 'case ' + k + ': at most 8 steps');
    // if the path stopped short, no single remaining change may still help (otherwise the route gave up too early)
    if (!ex.path.reached && ex.path.steps.length < 8) {
      const left = T.explainReadiness(st.rel, st.defects).actions;
      ok(left.length === 0, 'case ' + k + ': the route stopped although a change would still help');
    }
  }
}
ok(nExplained > 1500 && nActions > 2000 && nPaths > 800, 'the random cases cover enough ground (explained ' + nExplained + ', what-ifs ' + nActions + ', routes ' + nPaths + ')');

// worked examples a person can check by hand
const gates = ['dev-complete', 'sit', 'uat', 'gng'].filter((g) => GATE_IDS.includes(g));
if (gates.length === 4) {
  const rel = { id: 'REL', name: 'Worked', gates: [{ id: gates[0], status: 'passed', signedBy: 'A' }, { id: gates[1], status: 'passed', signedBy: '' }, { id: gates[2], status: 'pending', signedBy: '' }, { id: gates[3], status: 'pending', signedBy: '' }], envPath: ['DEV', 'PROD'], environments: { DEV: { health: 'healthy' }, PROD: { health: 'unknown' } } };
  const defects = [{ id: 'b1', releaseId: 'REL', title: 'Crash', classification: 'blocker' }];
  const e = T.explainReadiness(rel, defects);
  // gates 2/4 = 50%, blockers 1 -> 60, envs 1/2 = 50%, sign-offs 1 of 2 passed = 50%  ->  20 + 18 + 10 + 5 = 53
  ok(e.score === 53 && e.components.map((c) => c.value).join() === '50,60,50,50', 'worked example: 50/60/50/50 -> 53 (got ' + e.score + ' ' + e.components.map((c) => c.value).join() + ')');
  ok(e.band === 'amber' && e.path && e.path.target === 75, 'worked example: amber, aiming for 75');
  ok(e.notes.some((n) => /no recorded sign-off/.test(n)), 'worked example: the unsigned passed gate is called out');
  const resolve = e.actions.find((a) => a.kind === 'resolve_blocker');
  ok(resolve && resolve.newScore === 53 + 12, 'worked example: resolving the one blocker adds 12 (30% x (100-60))');
  const sign = e.actions.find((a) => a.kind === 'sign_gate');
  ok(sign && sign.newScore === 58, 'worked example: signing the unsigned gate takes sign-offs 50 -> 100 (+5)');
}
// a perfect release has nothing to improve; a release with no gates is not scored
const perfect = T.explainReadiness({ id: 'REL', name: 'P', gates: [{ id: GATE_IDS[0], status: 'passed', signedBy: 'A' }], envPath: ['DEV'], environments: { DEV: { health: 'healthy' } } }, []);
ok(perfect.score === 100 && perfect.actions.length === 0 && perfect.path === null && perfect.notes.length === 0, 'a perfect release: 100, nothing to improve');
ok(T.explainReadiness({ id: 'REL', gates: [], envPath: ['DEV'], environments: {} }, []).notAssessed === true, 'no gates: not assessed');
ok(T.explainReadiness({ id: 'REL', gates: [{ id: GATE_IDS[0], status: 'passed' }], envPath: [], environments: {} }, []).notAssessed === true, 'no environments: not assessed');
ok(T.explainReadiness(null, []).notAssessed === true, 'no release: not assessed');

console.log(failures.length ? 'EXPLAIN FAILED: ' + failures.length + ' failure(s), ' + pass + ' passed' : 'EXPLAIN PASS: ' + pass + ' assertions');
process.exit(failures.length ? 1 : 0);
