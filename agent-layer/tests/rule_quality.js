#!/usr/bin/env node
/*
 * RULE QUALITY (Master Plan workstream Q1/Q2) - RM repo.  PER-TOOL; not in the shared hash-lock.
 *
 *   node agent-layer/tests/rule_quality.js            print the summary
 *   node agent-layer/tests/rule_quality.js --report   also (re)write RULE-QUALITY-REPORT.md at the repo root
 *
 * Measures how well the tool's keyword rules match HUMAN INTENT, using labelled phrases (tests/rule-quality/corpus-*.json):
 *   - per rule: precision / recall / false positives / false negatives against the labelled concept;
 *   - per engine: how often the first-match-wins outcome shows the hint a person would expect;
 * for the CURRENT rules (read from the tool itself, through the real engine exports) and for the PROPOSED rule sets A and B
 * (tests/rule-quality/proposed-rules.json - NOT applied to the tool).
 *
 * This is a MEASUREMENT, not a gate: it never fails because the current rules are imperfect (that is the finding). It fails only
 * if the harness itself breaks, or if the corpus labels are invalid. Nothing here changes any engine.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { makeContext } = require('./parity_run.js');

const ROOT = path.join(__dirname, '..', '..');
const DIR = path.join(__dirname, 'rule-quality');
const load = (f) => JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'));
const WRITE_REPORT = process.argv.includes('--report');

const M = makeContext();
const E = M.E, tables = M.b.tables;
const proposals = load('proposed-rules.json');

const ENGINES = [
  { id: 'release_hint', corpus: 'corpus-release.json', table: 'RELEASE_AI_RULES', textOf: (c) => c.t.toLowerCase() + ' ', input: (c) => ({ name: c.t, notes: '', deliveryModels: [] }), ruleOf: (o) => (o.matched ? Number(o.rule.replace('release_rule_', '')) : null) },
  { id: 'defect_hint', corpus: 'corpus-defect.json', table: 'DEFECT_AI_RULES', textOf: (c) => c.t, input: (c) => ({ title: c.t }), ruleOf: (o) => (o.matched ? Number(o.rule.replace('defect_rule_', '')) : null) }
];

function pct(n, d) { return d ? Math.round((100 * n) / d) : 100; }

function evaluate(eng, corpus, patterns) {
  const rules = tables[eng.table];
  const res = { rules: [], engine: { correct: 0, total: corpus.cases.length, missed: [], falseAlarm: [], wrongHint: [] } };
  // concept level: each rule's own pattern against the labelled concept
  rules.forEach((rule, i) => {
    const re = patterns ? new RegExp(patterns[String(i)], 'i') : rule.pattern;
    const r = { index: i, concept: corpus.concepts[i], tp: 0, fp: 0, fn: 0, tn: 0, fpList: [], fnList: [] };
    corpus.cases.forEach((c) => {
      const text = eng.textOf(c), hit = re.test(text), want = c.c.includes(i);
      if (hit && want) r.tp++; else if (hit && !want) { r.fp++; r.fpList.push(c.t); } else if (!hit && want) { r.fn++; r.fnList.push(c.t); } else r.tn++;
    });
    r.precision = pct(r.tp, r.tp + r.fp); r.recall = pct(r.tp, r.tp + r.fn);
    res.rules.push(r);
  });
  // engine level: first match wins; the expected hint is the lowest-numbered applicable concept
  corpus.cases.forEach((c) => {
    const text = eng.textOf(c);
    let actual = null;
    if (patterns) { for (let i = 0; i < rules.length; i++) { if (new RegExp(patterns[String(i)], 'i').test(text)) { actual = i; break; } } }
    else { const env = E.run(eng.id, eng.input(c)); if (env.status === 'computed') actual = eng.ruleOf(env.output); }
    const expected = c.c.length ? Math.min.apply(null, c.c) : null;
    if (actual === expected) res.engine.correct++;
    else if (actual === null) res.engine.missed.push({ t: c.t, expected });
    else if (expected === null) res.engine.falseAlarm.push({ t: c.t, actual });
    else res.engine.wrongHint.push({ t: c.t, expected, actual });
  });
  return res;
}

const out = {};
for (const eng of ENGINES) {
  const corpus = load(eng.corpus);
  corpus.cases.forEach((c) => { if (!c.t || !Array.isArray(c.c)) throw new Error('bad corpus case ' + JSON.stringify(c)); });
  if (eng.id === 'defect_hint') corpus.cases.forEach((c) => { if (c.t.trim().length < 8) throw new Error('defect corpus phrase under 8 characters: ' + c.t); });
  out[eng.id] = { corpus, current: evaluate(eng, corpus, null), A: evaluate(eng, corpus, proposals[eng.id].A), B: evaluate(eng, corpus, proposals[eng.id].B) };
}

function summary(eid) {
  const o = out[eid];
  const line = (name, r) => {
    const tp = r.rules.reduce((a, x) => a + x.tp, 0), fp = r.rules.reduce((a, x) => a + x.fp, 0), fn = r.rules.reduce((a, x) => a + x.fn, 0);
    return `  ${name.padEnd(10)} engine-correct ${String(r.engine.correct).padStart(3)}/${r.engine.total} (${pct(r.engine.correct, r.engine.total)}%)  | rule-level false positives ${String(fp).padStart(3)}, false negatives ${String(fn).padStart(3)}, precision ${pct(tp, tp + fp)}%, recall ${pct(tp, tp + fn)}%`;
  };
  return `${eid} (${o.corpus.cases.length} labelled phrases)\n${line('CURRENT', o.current)}\n${line('PROPOSED A', o.A)}\n${line('PROPOSED B', o.B)}`;
}
console.log(ENGINES.map((e) => summary(e.id)).join('\n\n'));

if (WRITE_REPORT) {
  const L = ['# Rule quality report - Release Management tool', '',
    '*Generated by `agent-layer/tests/rule_quality.js` - do not edit by hand. Measurement only: **no rule in the tool has been changed**.*', '',
    '**How to read this.** Each labelled phrase says which concept(s) a release/defect manager would say it is about (labels were written by intent, without looking at the rules\' results, by Claude - they need your / a practitioner\'s review). A rule is *right* when it fires for phrases that are about its concept and stays quiet otherwise. **Engine-correct** counts phrases where the hint the tool actually shows (first match wins) is the one a person would expect (or none). **Proposed A** = whole-word matching + context guards only. **Proposed B** = A + extra vocabulary. The proposals were written by the same author as the labels, so the improvement shown is optimistic.', ''];
  for (const eng of ENGINES) {
    const o = out[eng.id];
    L.push(`## ${eng.id === 'release_hint' ? 'Release planner rules (`RELEASE_AI_RULES`)' : 'Defect triage rules (`DEFECT_AI_RULES`)'}`, '', summary(eng.id).split('\n').map((s, i) => (i ? '* ' + s.trim() : '')).filter(Boolean).join('\n'), '',
      '| # | Concept | Current precision / recall | A precision / recall | B precision / recall |', '|---|---|---|---|---|');
    o.current.rules.forEach((r, i) => L.push(`| ${i} | ${r.concept} | ${r.precision}% / ${r.recall}% (FP ${r.fp}, FN ${r.fn}) | ${o.A.rules[i].precision}% / ${o.A.rules[i].recall}% (FP ${o.A.rules[i].fp}, FN ${o.A.rules[i].fn}) | ${o.B.rules[i].precision}% / ${o.B.rules[i].recall}% (FP ${o.B.rules[i].fp}, FN ${o.B.rules[i].fn}) |`));
    L.push('', '### Current rules: where they get it wrong', '');
    o.current.rules.forEach((r) => {
      if (!r.fp && !r.fn) return;
      L.push(`**Rule ${r.index} - ${r.concept}**`);
      if (r.fpList.length) L.push('* *Fires when it should not:* ' + r.fpList.map((t) => '"' + t + '"').join('; '));
      if (r.fnList.length) L.push('* *Misses:* ' + r.fnList.map((t) => '"' + t + '"').join('; '));
      L.push('');
    });
    const e = o.current.engine;
    L.push('### Engine-level outcomes with the current rules', '', `* Wrong hint shown (an earlier rule steals it): ${e.wrongHint.length}`, `* Hint shown when none was expected: ${e.falseAlarm.length}`, `* No hint when one was expected: ${e.missed.length}`, '');
    const rules = tables[eng.table];
    const first = (patterns, text) => { for (let i = 0; i < rules.length; i++) { if ((patterns ? new RegExp(patterns[String(i)], 'i') : rules[i].pattern).test(text)) return i; } return null; };
    const rows = o.corpus.cases.map((c) => ({ t: c.t, note: c.note, expected: c.c.length ? Math.min.apply(null, c.c) : null, current: first(null, eng.textOf(c)), A: first(proposals[eng.id].A, eng.textOf(c)), B: first(proposals[eng.id].B, eng.textOf(c)) }));
    const lbl = (x) => (x === null ? 'no hint' : 'rule ' + x);
    const worseA = rows.filter((x) => x.current === x.expected && x.A !== x.expected), worseB = rows.filter((x) => x.current === x.expected && x.B !== x.expected);
    L.push('### Proposed A and B: what gets worse', '',
      worseA.length ? '* Under A, phrases that are RIGHT today but would be wrong (a recall cost of being stricter): ' + worseA.map((x) => '"' + x.t + '" (expected ' + lbl(x.expected) + ', A gives ' + lbl(x.A) + ')').join('; ') : '* Under A: nothing that is right today becomes wrong.',
      worseB.length ? '* Under B: ' + worseB.map((x) => '"' + x.t + '"').join('; ') : '* Under B: nothing that is right today becomes wrong.', '');
    const resid = rows.filter((x) => x.B !== x.expected);
    L.push('### Still wrong even under Proposed B (residual)', '', resid.length ? resid.map((x) => '* "' + x.t + '" - expected ' + lbl(x.expected) + ', B gives ' + lbl(x.B) + (x.note ? ' *(' + x.note + ')*' : '')).join('\n') : '* none', '');
  }
  L.push('## Limits of this measurement', '',
    '* Labels are one author\'s judgement; several phrases are marked `judgement` in the corpus.',
    '* The corpus is small (a few dozen phrases per rule) and written to include known substring traps, so it over-represents the hard cases: do NOT read the percentages as production accuracy.',
    '* Proposals have not been reviewed by a practitioner and are NOT applied. Any change goes through the signed-off engine-change workstream (Master Plan 7h).', '');
  fs.writeFileSync(path.join(ROOT, 'RULE-QUALITY-REPORT.md'), L.join('\n'), 'utf8');
  // machine-readable detail, including which phrases change outcome
  const detail = {};
  for (const eng of ENGINES) {
    const o = out[eng.id], rules = tables[eng.table];
    const first = (patterns, text) => { for (let i = 0; i < rules.length; i++) { if ((patterns ? new RegExp(patterns[String(i)], 'i') : rules[i].pattern).test(text)) return i; } return null; };
    detail[eng.id] = o.corpus.cases.map((c) => ({ t: c.t, expected: c.c.length ? Math.min.apply(null, c.c) : null, current: first(null, eng.textOf(c)), A: first(proposals[eng.id].A, eng.textOf(c)), B: first(proposals[eng.id].B, eng.textOf(c)) }))
      .filter((x) => x.current !== x.A || x.current !== x.B);
  }
  fs.writeFileSync(path.join(ROOT, 'RULE-QUALITY-REPORT.json'), JSON.stringify(detail, null, 1) + '\n', 'utf8');
  console.log('\nwrote RULE-QUALITY-REPORT.md and RULE-QUALITY-REPORT.json');
}
