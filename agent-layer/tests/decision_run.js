#!/usr/bin/env node
/*
 * Decision record and "may be out of date" tests (N1) - RM repo, per-tool file.
 *   node agent-layer/tests/decision_run.js
 * Runs the tool's REAL source (extracted from rm-tool-v1.html) in a VM. The drift check is a prompt to look again; these tests pin down that it:
 *   - says nothing when nothing changed;
 *   - names each kind of change (checked against an oracle written independently here, over thousands of random before/after pairs);
 *   - treats a GO and a NO-GO differently (a GO is worried by things getting worse, a NO-GO by things getting better) and treats an expired decision as out of date;
 *   - never changes its inputs, the recorded decision, the release status or any score;
 *   - does not raise false alarms for decisions recorded before tracking existed.
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
  const declRe = new RegExp('^(const|let)\\s+' + name + '\\s*=');
  const isConst = (l) => declRe.test(l);
  const starts = []; lines.forEach((l, k) => { if (isFn(l) || isConst(l)) starts.push(k); });
  if (starts.length !== 1) throw new Error('declaration "' + name + '" found ' + starts.length + ' times');
  const s = starts[0], fn = isFn(lines[s]);
  if (fn) { const one = lines[s]; if (/\}\s*$/.test(one) && one.split('{').length === one.split('}').length) return one; }
  for (let j = s; j < lines.length; j++) { const l = lines[j]; if (fn ? l === '}' : (/^[\]}];?$/.test(l) || (j === s && /;\s*$/.test(l)))) return lines.slice(s, j + 1).join('\n'); }
  throw new Error('no end for ' + name);
}
const NAMES = ['DEFECT_STATUS_DEFS', 'GATE_DEFS', 'TOOL_VERSION', 'DECISION_SCORE_STEP'];
const FNS = ['_filled', 'defectStatusKey', 'defectHasDecision', 'defectHasConfirmation', 'isUnresolvedBlocker', 'isBlockerClosedByDecision', 'calculateReadiness', 'readinessBandName', 'buildDecisionSnapshot', 'decisionDrift'];
const ctx = vm.createContext({ console });
vm.runInContext(['const STATE = { defects: [] };'].concat(NAMES.map(declaration)).concat(FNS.map(declaration)).join('\n') +
  '\nvar __b = { STATE, GATE_DEFS, TOOL_VERSION, DECISION_SCORE_STEP, calculateReadiness, readinessBandName, isUnresolvedBlocker, buildDecisionSnapshot, decisionDrift };', ctx, { filename: 'tool-real-source' });
const T = ctx.__b;

let pass = 0; const failures = [];
function ok(c, m) { if (c) pass++; else { failures.push(m); if (failures.length <= 30) console.log('  FAIL:', m); } }
const J = (v) => JSON.stringify(v);
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];
const clone = (o) => JSON.parse(JSON.stringify(o));
function deepFreeze(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach((k) => deepFreeze(o[k])); } return o; }

const GATE_IDS = Object.keys(T.GATE_DEFS), ENVS = ['DEV', 'SIT', 'UAT', 'PRE-PROD', 'PROD'];
const GST = ['not-started', 'pending', 'in-progress', 'passed', 'failed', 'waived'], HEALTH = ['unknown', 'healthy', 'warning', 'blocked'];
function mk(r) {
  const n = 2 + Math.floor(r() * 6);
  const gates = GATE_IDS.slice().sort(() => r() - 0.5).slice(0, n).map((id) => ({ id, status: pick(r, GST), signedBy: r() < 0.5 ? 'S' : '' }));
  const envPath = ENVS.slice().sort(() => r() - 0.5).slice(0, 1 + Math.floor(r() * 5));
  const environments = {}; envPath.forEach((e) => { environments[e] = { health: pick(r, HEALTH), version: 'v' }; });
  const defects = Array.from({ length: Math.floor(r() * 5) }, (_, k) => ({ id: 'd' + k, releaseId: 'REL', title: 'Defect ' + k, classification: pick(r, ['blocker', 'blocker', 'known']), status: pick(r, ['open', 'fix_in_progress', 'resolved_confirmed', 'accepted']), decision: r() < 0.5 ? { by: 'P', reason: 'R' } : null, confirmation: r() < 0.5 ? { by: 'S' } : null }));
  return { rel: { id: 'REL', name: 'Rel', status: 'planning', rag: 'amber', targetDate: '2026-12-01', gates, envPath, environments }, defects };
}
function mutate(r, rel, defects) {
  const a = clone(rel), d = clone(defects); const what = [];
  const n = 1 + Math.floor(r() * 3);
  for (let i = 0; i < n; i++) {
    const k = Math.floor(r() * 7);
    if (k === 0) { const id = 'new' + Math.floor(r() * 1e6); d.push({ id, releaseId: 'REL', title: 'New ' + id, classification: 'blocker', status: 'open' }); what.push('add_blocker'); }
    else if (k === 1 && d.length) { const x = pick(r, d); x.status = 'resolved_confirmed'; x.confirmation = { by: 'Sam' }; what.push('resolve'); }
    else if (k === 2) { const g = pick(r, a.gates); g.status = pick(r, GST); what.push('gate_status'); }
    else if (k === 3) { const g = pick(r, a.gates); g.signedBy = g.signedBy ? '' : 'S'; what.push('signoff'); }
    else if (k === 4) { const e = pick(r, a.envPath); a.environments[e].health = pick(r, HEALTH); what.push('env'); }
    else if (k === 5) { a.targetDate = pick(r, ['2026-12-01', '2027-01-15', '']); what.push('target'); }
    else { d.push({ id: 'k' + Math.floor(r() * 1e6), releaseId: 'REL', title: 'Known', classification: 'known', status: 'open' }); what.push('known_added'); }
  }
  return { rel: a, defects: d, what };
}

// an independent statement of what should be reported, written without looking at the tool's code
function oracle(snapRel, snapDefs, rel, defs, decision, expiresAt, now) {
  const blk = (ds) => ds.filter((x) => x.releaseId === 'REL' && T.isUnresolvedBlocker(x)).map((x) => x.id).sort();
  const sb = blk(snapDefs), nb = blk(defs);
  const added = nb.filter((x) => !sb.includes(x)), cleared = sb.filter((x) => !nb.includes(x));
  const rs = T.calculateReadiness(snapRel, snapDefs), rn = T.calculateReadiness(rel, defs);
  const band = (s) => (s >= 75 ? 'green' : s >= 50 ? 'amber' : 'red');
  let adverse = added.length, improved = cleared.length, kinds = []; added.forEach(() => kinds.push('blocker_added')); cleared.forEach(() => kinds.push('blocker_cleared'));
  if (!rs.notAssessed && !rn.notAssessed) {
    const d = rn.score - rs.score;
    if (band(rn.score) !== band(rs.score)) { kinds.push('band'); if (d < 0) adverse++; else improved++; }
    else if (Math.abs(d) >= 10) { kinds.push('score'); if (d < 0) adverse++; else improved++; }
  }
  const done = (s) => s === 'passed' || s === 'waived';
  snapRel.gates.forEach((sg) => { const g = rel.gates.find((x) => x.id === sg.id);
    if (done(sg.status) && !done(g.status)) { kinds.push('gate_regressed'); adverse++; }
    else if (!done(sg.status) && done(g.status)) { kinds.push('gate_advanced'); improved++; }
    else if (sg.signedBy && !g.signedBy) { kinds.push('signoff_removed'); adverse++; } });
  const rank = (h) => (h === 'healthy' ? 2 : h === 'warning' ? 1 : 0);
  snapRel.envPath.forEach((e) => { const h0 = (snapRel.environments[e] || {}).health || 'unknown', h1 = (rel.environments[e] || {}).health || 'unknown';
    if (rank(h1) < rank(h0)) { kinds.push('env_worse'); adverse++; } else if (rank(h1) > rank(h0)) { kinds.push('env_better'); improved++; } });
  if ((snapRel.targetDate || '') !== (rel.targetDate || '')) kinds.push('target_moved');
  const expired = !!expiresAt && !isNaN(Date.parse(expiresAt)) && now > Date.parse(expiresAt);
  const outOfDate = expired || (decision === 'go' ? adverse > 0 : improved > 0);
  return { kinds: kinds.sort(), adverse, improved, expired, outOfDate };
}

const NOW = Date.parse('2026-10-20T12:00:00Z');
const rd = rng(11);
let nPairs = 0, nOut = 0, nQuiet = 0;
for (let k = 0; k < 4000; k++) {
  const { rel, defects } = mk(rd);
  const decision = rd() < 0.5 ? 'go' : 'nogo';
  const expiresAt = pick(rd, ['', '', '2026-10-01T09:00', '2026-12-01T09:00', 'not a date']);
  const snap = T.buildDecisionSnapshot(rel, defects);
  const m = mutate(rd, rel, defects);
  const recorded = Object.assign(clone(rel), { gngDecision: { decision, decidedBy: 'Dana', decidedAt: '2026-10-10T10:00', expiresAt, snapshot: snap } });
  const current = Object.assign(clone(m.rel), { gngDecision: recorded.gngDecision });
  const status0 = current.status, rag0 = current.rag;
  deepFreeze(current); deepFreeze(m.defects);
  const saved = J(T.STATE.defects);
  const dr = T.decisionDrift(current, m.defects, NOW);
  ok(J(T.STATE.defects) === saved && current.status === status0 && current.rag === rag0, 'case ' + k + ': nothing was changed (status / rag / saved defects)');
  const o = oracle(rel, defects, m.rel, m.defects, decision, expiresAt, NOW);
  nPairs++;
  ok(J(dr.changes.map((c) => c.kind).sort()) === J(o.kinds), 'case ' + k + ' [' + m.what + ']: the list of changes. tool ' + J(dr.changes.map((c) => c.kind).sort()) + ' oracle ' + J(o.kinds));
  ok(dr.adverse === o.adverse && dr.improved === o.improved, 'case ' + k + ': worse / better counts');
  ok(dr.expired === o.expired, 'case ' + k + ': expiry');
  ok(dr.outOfDate === o.outOfDate, 'case ' + k + ': may be out of date (' + decision + ') tool ' + dr.outOfDate + ' oracle ' + o.outOfDate);
  ok(dr.changes.every((c) => ['adverse', 'improved', 'neutral'].includes(c.effect) && typeof c.text === 'string' && c.text.length > 5), 'case ' + k + ': each change has plain wording and an effect');
  ok(J(T.decisionDrift(current, m.defects, NOW)) === J(dr), 'case ' + k + ': same input, same answer');
  if (dr.outOfDate) nOut++; else nQuiet++;
  // nothing changed at all -> quiet (apart from expiry)
  const same = T.decisionDrift(Object.assign(clone(rel), { gngDecision: recorded.gngDecision }), defects, NOW);
  ok(same.changes.length === 0 && same.adverse === 0 && same.improved === 0 && same.outOfDate === same.expired, 'case ' + k + ': no change since the decision -> no alarm' );
}
ok(nOut > 500 && nQuiet > 500 && nPairs === 4000, 'the random cases cover both outcomes (' + nOut + ' out of date / ' + nQuiet + ' quiet)');

// a few named cases a person can read
const base = mk(rng(5)); const rel0 = Object.assign(base.rel, { gates: [{ id: GATE_IDS[0], status: 'passed', signedBy: 'A' }, { id: GATE_IDS[1], status: 'passed', signedBy: 'A' }], envPath: ['DEV'], environments: { DEV: { health: 'healthy' } }, targetDate: '2026-12-01' }); const defs0 = [];
const snap0 = T.buildDecisionSnapshot(rel0, defs0);
const dec = (decision, extra) => Object.assign(clone(rel0), { gngDecision: Object.assign({ decision, decidedBy: 'Dana', decidedAt: '2026-10-10T10:00', snapshot: snap0 }, extra || {}) });
ok(snap0.version === 1 && snap0.toolVersion === T.TOOL_VERSION && snap0.readiness.score === 100 && snap0.readiness.band === 'green' && snap0.blockers.length === 0 && snap0.gates.length === 2 && snap0.envs.DEV === 'healthy', 'the snapshot holds the readiness, gates, blockers, environments and target date');
let d1 = T.decisionDrift(dec('go'), [{ id: 'b1', releaseId: 'REL', title: 'Payment crash', classification: 'blocker', status: 'open' }], NOW);
ok(d1.outOfDate && d1.changes.some((c) => c.kind === 'blocker_added' && /Payment crash/.test(c.text)) && d1.changes.some((c) => c.kind === 'score' || c.kind === 'band'), 'worked example: a new blocker after a GO is called out by name and readiness is reported');
ok(T.decisionDrift(dec('nogo'), [{ id: 'b1', releaseId: 'REL', title: 'Payment crash', classification: 'blocker', status: 'open' }], NOW).outOfDate === false, 'a NO-GO is not worried by things getting worse');
const relB = clone(rel0); relB.gates[0].status = 'pending';
ok(T.decisionDrift(Object.assign(relB, { gngDecision: dec('go').gngDecision }), defs0, NOW).changes.some((c) => c.kind === 'gate_regressed'), 'a gate that went backwards after a GO is reported');
ok(T.decisionDrift(dec('go', { expiresAt: '2026-10-19T09:00' }), defs0, NOW).expired === true && T.decisionDrift(dec('go', { expiresAt: '2026-10-19T09:00' }), defs0, NOW).outOfDate === true, 'an expired decision is out of date even if nothing else changed');
ok(T.decisionDrift(dec('go', { expiresAt: '2026-10-21T09:00' }), defs0, NOW).outOfDate === false, 'a decision before its expiry is fine');
ok(T.decisionDrift(dec('go', { expiresAt: 'whenever' }), defs0, NOW).expired === false, 'an unreadable expiry never raises an alarm');
// reads only: on UNFROZEN inputs the decision, the release and the defects are byte-for-byte the same afterwards
{
  const r1 = dec('go'), d1b = [{ id: 'b1', releaseId: 'REL', title: 'Crash', classification: 'blocker', status: 'open' }];
  const before = J([r1, d1b]); T.decisionDrift(r1, d1b, NOW); T.buildDecisionSnapshot(r1, d1b);
  ok(J([r1, d1b]) === before, 'the drift check and the snapshot change nothing in their inputs');
}
// two blockers with the SAME title are different blockers: the second one is new
{
  const sameTitle = [{ id: 'a1', releaseId: 'REL', title: 'Crash', classification: 'blocker', status: 'open' }];
  const relS = Object.assign(clone(rel0), { gngDecision: { decision: 'go', decidedBy: 'D', decidedAt: '2026-10-10', snapshot: T.buildDecisionSnapshot(rel0, sameTitle) } });
  const withSecond = sameTitle.concat([{ id: 'a2', releaseId: 'REL', title: 'Crash', classification: 'blocker', status: 'open' }]);
  ok(T.decisionDrift(relS, withSecond, NOW).changes.some((c) => c.kind === 'blocker_added'), 'a second blocker with the same title is still reported as new (blockers are told apart by identity, not by title)');
}
// decisions recorded before tracking existed: no false alarms, and they say so
const old = Object.assign(clone(rel0), { gngDecision: { decision: 'go', decidedBy: 'Old', decidedAt: '2026-01-01', rationale: 'x' } });
const dOld = T.decisionDrift(old, [{ id: 'b1', releaseId: 'REL', title: 'X', classification: 'blocker', status: 'open' }], NOW);
ok(dOld.recorded && dOld.noSnapshot && dOld.changes.length === 0 && dOld.outOfDate === false, 'a decision from before tracking: nothing to compare, no false alarm');
ok(T.decisionDrift(clone(rel0), defs0, NOW).recorded === false, 'no decision recorded: nothing to report');
// confirming it still stands starts a fresh comparison
const relC = clone(rel0); relC.gngDecision = dec('go').gngDecision;
const defsC = [{ id: 'b1', releaseId: 'REL', title: 'Payment crash', classification: 'blocker', status: 'open' }];
ok(T.decisionDrift(relC, defsC, NOW).outOfDate === true, 'before confirming: out of date');
relC.gngDecision.snapshot = T.buildDecisionSnapshot(relC, defsC);
ok(T.decisionDrift(relC, defsC, NOW).changes.length === 0 && T.decisionDrift(relC, defsC, NOW).outOfDate === false, 'after confirming it still stands the comparison starts from today');
// a release that cannot be scored
const noGates = { id: 'REL', gates: [], envPath: ['DEV'], environments: {}, gngDecision: { decision: 'go', decidedBy: 'x', snapshot: T.buildDecisionSnapshot({ id: 'REL', gates: [], envPath: ['DEV'], environments: {} }, []) } };
ok(noGates.gngDecision.snapshot.readiness === null && T.decisionDrift(noGates, [], NOW).changes.length === 0, 'not-assessed releases are snapshotted without a number and raise no false alarm');

console.log(failures.length ? 'DECISION FAILED: ' + failures.length + ' failure(s), ' + pass + ' passed' : 'DECISION PASS: ' + pass + ' assertions');
process.exit(failures.length ? 1 : 0);
