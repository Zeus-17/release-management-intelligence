#!/usr/bin/env node
/*
 * Defect lifecycle tests (R-1) - RM repo, per-tool file.
 *   node agent-layer/tests/defect_lifecycle_run.js
 * Runs the tool's REAL source (extracted from rm-tool-v1.html, never a copy) in a VM and checks the rules a Release Manager relies on:
 *   - a blocker counts as open until a NAMED person confirmed the fix, or recorded the decision that closes it;
 *   - legacy defects (no status) and unknown / hand-edited statuses behave conservatively (counted);
 *   - every status change is validated, recorded in the history, and the resolver / confirmer / decision records are kept apart;
 *   - the readiness score and the open-blocker count follow the same rule.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const html = fs.readFileSync(path.resolve(ROOT, cfg.html), 'utf8').replace(/\r\n/g, '\n');
const i = html.indexOf('<!-- AGENT-LAYER:BEGIN');
const src = i === -1 ? html : html.slice(0, i);

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

const NAMES = ['DEFECT_STATUS_DEFS', 'DEFECT_STATUS_FIELDS'];
const FNS = ['_filled', 'defectStatusKey', 'defectHasDecision', 'defectHasConfirmation', 'isUnresolvedBlocker', 'isBlockerClosedByDecision', 'isBlockerAwaitingConfirmation',
  'isAcceptedReviewOverdue', 'validateDefectStatusChange', 'applyDefectStatusChange', 'defectStatusDetail', 'defectStatusLine', 'calculateReadiness'];
const ctx = vm.createContext({ console });
vm.runInContext(['const STATE = { defects: [] };'].concat(NAMES.map(declaration)).concat(FNS.map(declaration)).join('\n') +
  '\nvar __b = { STATE, DEFS: DEFECT_STATUS_DEFS, FIELDS: DEFECT_STATUS_FIELDS, ' + FNS.map((f) => f + ': ' + f).join(', ') + ' };', ctx, { filename: 'tool-real-source' });
const T = ctx.__b;

let pass = 0; const failures = [];
function ok(c, m) { if (c) pass++; else { failures.push(m); console.log('  FAIL:', m); } }
const J = (v) => JSON.stringify(v);
const KEYS = Object.keys(T.DEFS);
const GROUP = (k) => T.DEFS[k].group;

/* A. the status table itself */
ok(KEYS.length === 13, 'thirteen statuses: ' + KEYS.length);
ok(KEYS.every((k) => Array.isArray(T.FIELDS[k])), 'every status has a field list');
ok(KEYS.every((k) => ['active', 'resolved', 'closed'].includes(GROUP(k))), 'every status is in a group');
ok(GROUP('fixed_unverified') === 'active', 'a reported fix is still ACTIVE (not resolved) until a person confirms it');
ok(['deferred', 'accepted', 'wont_fix', 'duplicate', 'cannot_reproduce', 'not_a_defect'].every((k) => GROUP(k) === 'closed'), 'six decision statuses are "closed"');
ok(['deferred', 'accepted', 'wont_fix'].every((k) => T.FIELDS[k].some((f) => f.k === 'role' && f.r)), 'deferred / accepted / won\'t fix require the approver\'s ROLE');
ok(T.FIELDS.accepted.some((f) => f.k === 'date' && f.r), 'accepted requires a review-by date');
ok(KEYS.filter((k) => GROUP(k) === 'closed').every((k) => T.FIELDS[k].some((f) => f.k === 'by' && f.r)), 'every closing status requires a named person');
ok(T.FIELDS.resolved_confirmed.some((f) => f.k === 'by' && f.r), 'confirmation requires a named confirmer');

/* B. the open-blocker rule */
ok(T.defectStatusKey({ status: 'nonsense' }) === 'open' && T.defectStatusKey({}) === 'open' && T.defectStatusKey(null) === 'open' && T.defectStatusKey({ status: 'toString' }) === 'open', 'missing / unknown / prototype-name status = open');
const blk = (o) => Object.assign({ id: 'x', classification: 'blocker' }, o);
ok(T.isUnresolvedBlocker(blk({})) === true, 'legacy blocker (no status) counts');
ok(T.isUnresolvedBlocker(blk({ status: 'open' })) === true, 'status open counts');
ok(T.isUnresolvedBlocker(blk({ status: 'nonsense' })) === true, 'unknown status counts as open (conservative)');
ok(T.isUnresolvedBlocker(blk({ status: null })) === true && T.isUnresolvedBlocker(blk({ status: 42 })) === true, 'null / numeric status counts');
ok(T.isUnresolvedBlocker(null) === false && T.isUnresolvedBlocker(undefined) === false, 'no defect, no blocker');
['deferred', 'known', 'wontfix', '', undefined].forEach((c) => ok(T.isUnresolvedBlocker({ classification: c, status: 'open' }) === false, 'classification ' + c + ' is never a blocker'));
KEYS.forEach((k) => {
  const g = GROUP(k);
  const bare = T.isUnresolvedBlocker(blk({ status: k }));
  const withDecision = T.isUnresolvedBlocker(blk({ status: k, decision: { by: 'Pat', reason: 'Because' } }));
  const withConfirm = T.isUnresolvedBlocker(blk({ status: k, confirmation: { by: 'Sam' } }));
  if (g === 'active') ok(bare && withDecision && withConfirm, k + ': active always counts even if records are present');
  if (g === 'resolved') ok(bare === true && withConfirm === false && withDecision === true, k + ': counts until a NAMED confirmer is recorded (a decision record does not count)');
  if (g === 'closed') ok(bare === true && withDecision === false && withConfirm === true, k + ': counts until a NAMED decision-maker AND reason are recorded (a confirmation does not count)');
});
ok(T.isUnresolvedBlocker(blk({ status: 'accepted', decision: { by: '  ', reason: 'x' } })) === true, 'blank approver name does not close a blocker');
ok(T.isUnresolvedBlocker(blk({ status: 'accepted', decision: { by: 'Pat', reason: '' } })) === true, 'missing reason does not close a blocker');
ok(T.isUnresolvedBlocker(blk({ status: 'resolved_confirmed', confirmation: { by: '' } })) === true, 'blank confirmer does not close a blocker');
ok(T.isUnresolvedBlocker(blk({ status: 'accepted', decision: { by: 5, reason: 5 } })) === true, 'non-text names do not close a blocker');

/* C. validation */
const d0 = () => blk({ status: 'open', statusHistory: [] });
ok(T.validateDefectStatusChange(d0(), 'nope', {}).length === 1, 'unknown target status refused');
ok(T.validateDefectStatusChange(d0(), 'open', {}).length >= 1, 'same status refused');
ok(T.validateDefectStatusChange(d0(), 'reopened', { by: 'A', note: 'x' }).length >= 1, 'Reopened refused on an active defect');
ok(T.validateDefectStatusChange(blk({ status: 'resolved_confirmed' }), 'open', {}).length >= 1, 'Open refused after resolution (use Reopened)');
ok(T.validateDefectStatusChange(blk({ status: 'resolved_confirmed' }), 'reopened', { by: 'A', note: 'came back' }).length === 0, 'Reopened allowed after resolution');
ok(T.validateDefectStatusChange(blk({ status: 'accepted' }), 'reopened', { by: 'A', note: 'risk changed' }).length === 0, 'Reopened allowed after acceptance');
KEYS.forEach((k) => {
  const required = (T.FIELDS[k] || []).filter((f) => f.r);
  if (k === 'open' || k === 'reopened') return;
  const from = GROUP(k) === 'active' ? blk({ status: 'resolved_confirmed' }) : d0();
  if (GROUP(k) === 'active' && k !== 'open') { /* active -> active from an open defect */ }
  const src = k === 'reopened' ? blk({ status: 'accepted' }) : d0();
  const filled = {}; required.forEach((f) => { filled[f.k] = f.t === 'date' ? '2026-12-31' : 'value'; });
  ok(T.validateDefectStatusChange(src, k, filled).length === 0, k + ': accepted when only the required fields are filled: ' + J(T.validateDefectStatusChange(src, k, filled)));
  required.forEach((f) => { const g = Object.assign({}, filled); g[f.k] = '   '; ok(T.validateDefectStatusChange(src, k, g).length >= 1, k + ': blank "' + f.k + '" refused'); });
});
ok(T.validateDefectStatusChange(d0(), 'accepted', { by: 'P', role: 'R', note: 'n', date: 'not-a-date' }).length >= 1, 'bad date refused');
ok(T.validateDefectStatusChange(d0(), 'accepted', { by: 'P', role: 'R', note: 'n', date: '2026-02-31x' }).length >= 1, 'malformed date refused');

/* D. a whole life: report -> fix -> verify -> reopen -> accept */
const d = blk({ id: 'life', title: 'Payment page crash', status: 'open', statusHistory: [{ at: '2026-01-01T00:00:00Z', from: '', to: 'open', note: 'Logged' }] });
const step = (to, f, label) => { const r = T.applyDefectStatusChange(d, to, f, '2026-01-0' + (d.statusHistory.length + 1) + 'T10:00:00Z'); ok(r.ok, label + ' ok: ' + J(r)); return r; };
step('fix_identified', { by: 'Dana', role: 'Engineering lead', ref: 'PROJ-1' }, 'identified');
ok(T.isUnresolvedBlocker(d), 'still counted after fix identified');
step('fix_in_progress', { by: 'Dana', date: '2026-02-01' }, 'in progress');
step('blocked', { note: 'Waiting for supplier API key' }, 'blocked');
ok(T.isUnresolvedBlocker(d), 'still counted while blocked');
step('fix_in_progress', { by: 'Dana' }, 'back to in progress');
step('fixed_unverified', { by: 'Dana', role: 'Engineering lead', ref: 'PR-42' }, 'fix reported');
ok(T.isUnresolvedBlocker(d) && T.isBlockerAwaitingConfirmation(d) && !T.isBlockerClosedByDecision(d), 'a reported fix is STILL COUNTED and flagged as awaiting confirmation');
ok(d.resolver && d.resolver.by === 'Dana' && d.resolver.ref === 'PR-42' && d.confirmation === null && d.decision === null, 'resolver recorded; no confirmation, no decision');
step('resolved_confirmed', { by: 'Ravi', role: 'Release Manager', env: 'UAT', ref: 'Test run 7' }, 'confirmed');
ok(!T.isUnresolvedBlocker(d), 'confirmed by a named person: no longer counted');
ok(d.decision === null, 'a confirmation never carries an old decision');
ok(d.confirmation.by === 'Ravi' && d.confirmation.env === 'UAT' && d.resolver.by === 'Dana', 'confirmer and resolver are separate people / records');
step('reopened', { by: 'Ravi', note: 'Crash seen again in PRE-PROD' }, 'reopened');
ok(T.isUnresolvedBlocker(d) && d.confirmation === null, 'reopened: counted again and the old confirmation is cleared');
step('accepted', { by: 'Mira', role: 'Product owner', note: 'Rare path; workaround documented', workaround: 'Retry the payment', date: '2026-03-01' }, 'accepted');
ok(!T.isUnresolvedBlocker(d) && T.isBlockerClosedByDecision(d), 'accepted with a named decision-maker: not counted, but flagged as CLOSED BY DECISION');
ok(d.confirmation === null, 'a decision record never carries an old confirmation');
ok(d.decision.by === 'Mira' && d.decision.reviewBy === '2026-03-01' && d.decision.workaround === 'Retry the payment', 'decision record complete');
ok(T.isAcceptedReviewOverdue(d, '2026-03-02') === true && T.isAcceptedReviewOverdue(d, '2026-03-01') === false && T.isAcceptedReviewOverdue(d, '2026-02-01') === false, 'review overdue only AFTER the review-by date');
ok(T.isAcceptedReviewOverdue(blk({ status: 'deferred', decision: { reviewBy: '2020-01-01' } }), '2026-01-01') === false, 'overdue applies to Accepted only');
ok(T.isAcceptedReviewOverdue(blk({ status: 'accepted', decision: { reviewBy: 'garbage' } }), '2026-01-01') === false, 'unreadable review date is not "overdue" (shown elsewhere as missing)');
ok(d.statusHistory.length === 9 && d.statusHistory[0].note === 'Logged' && d.statusHistory[d.statusHistory.length - 1].to === 'accepted', 'history is append-only: ' + d.statusHistory.length);
ok(d.statusHistory.every((h, k, a) => k === 0 || h.from === a[k - 1].to), 'every history entry starts where the previous one ended');
ok(/Accepted/.test(T.defectStatusLine(d)) && /Mira \(Product owner\)/.test(T.defectStatusLine(d)) && /review by 2026-03-01/.test(T.defectStatusLine(d)), 'status line names the decision-maker and review date: ' + T.defectStatusLine(d));

/* E. refused changes change nothing */
const before = J(d);
const bad = T.applyDefectStatusChange(d, 'wont_fix', { by: 'X' }, '2026-01-30T00:00:00Z');
ok(!bad.ok && bad.errors.length >= 1 && J(d) === before, 'a refused change leaves the defect untouched');

/* F. duplicate / decision wording */
const dup = blk({ status: 'open' });
ok(T.applyDefectStatusChange(dup, 'duplicate', { by: 'Lee', ref: 'PROJ-9' }, '2026-01-01T00:00:00Z').ok && /Duplicate of PROJ-9/.test(dup.decision.reason) && !T.isUnresolvedBlocker(dup), 'duplicate keeps "Duplicate of <ref>" as the reason');
const cr = blk({ status: 'open' });
ok(T.applyDefectStatusChange(cr, 'cannot_reproduce', { by: 'Lee', note: 'Tried 10 times on SIT' }, '2026-01-01T00:00:00Z').ok && !T.isUnresolvedBlocker(cr) && T.isBlockerClosedByDecision(cr), 'cannot reproduce needs what was tried; closes with a named decision');
const nonblk = { id: 'nb', classification: 'known', status: 'open' };
ok(T.applyDefectStatusChange(nonblk, 'accepted', { by: 'P', role: 'R', note: 'n', date: '2026-05-01' }, '2026-01-01T00:00:00Z').ok && !T.isBlockerClosedByDecision(nonblk), 'a non-blocker can be closed but is never reported as a closed BLOCKER');

/* G. the numbers follow the rule */
function readiness(defs) {
  T.STATE.defects = defs.map((x, k) => Object.assign({ id: 'r' + k, releaseId: 'REL' }, x));
  return T.calculateReadiness({ id: 'REL', gates: [{ id: 'dev-complete', status: 'passed', signedBy: 'A' }], envPath: ['DEV'], environments: { DEV: { health: 'healthy' } } });
}
ok(readiness([{ classification: 'blocker' }]).defects === 60, 'one open blocker -> defect component 60');
ok(readiness([{ classification: 'blocker', status: 'resolved_confirmed', confirmation: { by: 'Ravi' } }]).defects === 100, 'a confirmed-resolved blocker no longer lowers the score');
ok(readiness([{ classification: 'blocker', status: 'fixed_unverified' }]).defects === 60, 'a reported-but-unconfirmed fix still lowers the score');
ok(readiness([{ classification: 'blocker', status: 'accepted', decision: { by: 'Mira', reason: 'ok' } }]).defects === 100, 'a blocker closed by a named decision no longer lowers the score');
ok(readiness([{ classification: 'blocker', status: 'accepted' }]).defects === 60, 'accepted WITHOUT a named decision still lowers the score');
ok(readiness([{ classification: 'blocker' }, { classification: 'blocker' }, { classification: 'blocker', status: 'resolved_confirmed', confirmation: { by: 'R' } }]).defects === 30, 'two open + one confirmed -> component 30');
T.STATE.defects = [];

console.log(failures.length ? 'LIFECYCLE FAILED: ' + failures.length + ' failure(s), ' + pass + ' passed' : 'LIFECYCLE PASS: ' + pass + ' assertions');
process.exit(failures.length ? 1 : 0);
