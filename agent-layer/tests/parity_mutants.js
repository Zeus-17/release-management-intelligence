#!/usr/bin/env node
/*
 * Mutation check for the engine parity test (RM repo; per-tool file).
 *   node agent-layer/tests/parity_mutants.js
 * Applies small deliberate faults to a COPY of engine-exports.js (one at a time) and requires tests/parity_run.js to FAIL for each.
 * A surviving mutant means the parity test has a blind spot. Run after any change to engine-exports.js or the parity test.
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const SRC = path.join(__dirname, '..', 'engine-exports.js');
const TEST = path.join(__dirname, 'parity_run.js');
const original = fs.readFileSync(SRC, 'utf8');

// [name, exact text to find, replacement]  (the first occurrence is replaced)
const MUTANTS = [
  ['readiness: gates weight 0.4 -> 0.3', 'gatesPct * 0.4', 'gatesPct * 0.3'],
  ['readiness: sign-off weight 0.1 -> 0.2', 'signoffPct * 0.1', 'signoffPct * 0.2'],
  ['readiness: one blocker 60 -> 61', 'blockers === 1 ? 60', 'blockers === 1 ? 61'],
  ['readiness: waived no longer counts as done', "g.status === 'passed' || g.status === 'waived'", "g.status === 'passed'"],
  ['readiness: environment percentage floors instead of rounds', 'Math.round((healthy / envs.length) * 100)', 'Math.floor((healthy / envs.length) * 100)'],
  ['readiness: unsigned passed gate counts as signed', "g.signedBy && g.status === 'passed'", 'g.signedBy'],
  ['risk: high band 15 -> 16', 'score >= 15', 'score >= 16'],
  ['risk: medium band 8 -> 9', 'score >= 8', 'score >= 9'],
  ['release: complexity threshold 4 -> 5', 'dms.length >= 4', 'dms.length >= 5'],
  ['release: notes no longer scanned', "var text = name + ' ' + notes;", 'var text = name;'],
  ['release: negation guard bypassed', "var scan = table('stripNegatedTerms')(text);", 'var scan = text;'],
  ['release: matched text dropped', 'if (mt) out.matched_text = mt;', ''],
  ['defect: matched text dropped', 'if (mtd) o.matched_text = mtd;', ''],
  ['release: complexity check not first (rules win)', 'if (dms.length >= 4) {', 'if (false && dms.length >= 4) {'],
  ['defect: 8-character minimum 8 -> 7', 'title.trim().length < 8', 'title.trim().length < 7'],
  ['defect: rules scanned in reverse order', 'for (var i = 0; i < rules.length; i++) {\n      if (rules[i].pattern.test(title)) {', 'for (var i = rules.length - 1; i >= 0; i--) {\n      if (rules[i].pattern.test(title)) {'],
  ['defect: suggested classification dropped', 'if (rules[i].cls) o.suggested_classification = rules[i].cls;', ''],
  ['gate: entry criteria off-by-one (<=)', 'entryChecked < entryTotal', 'entryChecked <= entryTotal'],
  ['gate: exit hint wording changed', 'exit criteria not yet confirmed', 'exit criteria are not yet confirmed'],
  ['gate: blocker hint wording changed', 'Go/No-Go must be NO-GO', 'Go/No-Go should be NO-GO'],
  ['gate: version mismatch inverted', 'input.preProdVersion !== input.prodVersion', 'input.preProdVersion === input.prodVersion'],
  ['gate: mobile check inverted', "indexOf('mobile') !== -1", "indexOf('mobile') === -1"],
  ['envelope: complete always true', 'complete: !(caveats && caveats.length)', 'complete: true'],
  ['envelope: output schema check skipped', "errs = al.validate.against('outputs', engine, envelope);", 'errs = null;'],
  ['safety: decision_record no longer refused in run()', "if (engine === 'decision_record') return unavailable(engine, 'human_decision_only');\n    if (!Object", 'if (!Object'],
  ['safety: input schema check skipped', "errs = al.validate.against('inputs', engine, input);", 'errs = [];'],
  ['safety: legacy zero-gates artefact allowed through', "if (!input.gates || !input.gates.length) missing.push({ field: 'gates', reason_code: 'gates_missing' });", '']
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'parity-mut-'));
let killed = 0; const survivors = [];
for (const [name, from, to] of MUTANTS) {
  const idx = original.indexOf(from);
  if (idx === -1) { console.log('  ?? mutant target not found: ' + name); survivors.push(name + ' (target missing)'); continue; }
  const mutated = original.slice(0, idx) + to + original.slice(idx + from.length);
  const file = path.join(tmp, 'engine-exports.mut.js');
  fs.writeFileSync(file, mutated);
  const r = spawnSync(process.execPath, [TEST, '--quiet'], { env: Object.assign({}, process.env, { PARITY_EXPORTS_SRC: file }), encoding: 'utf8' });
  if (r.status !== 0) { killed++; console.log('  killed   ' + name); }
  else { survivors.push(name); console.log('  SURVIVED ' + name); }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log('\nmutants: ' + killed + '/' + MUTANTS.length + ' killed' + (survivors.length ? '; SURVIVORS: ' + survivors.join(' | ') : ''));
process.exit(survivors.length ? 1 : 0);
