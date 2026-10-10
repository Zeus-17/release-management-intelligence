#!/usr/bin/env node
/*
 * RULE QUALITY (Master Plan workstream Q) - RM repo.  PER-TOOL; not in the shared hash-lock.
 *
 *   node agent-layer/tests/rule_quality.js            print the summary
 *   node agent-layer/tests/rule_quality.js --report   also (re)write RULE-QUALITY-REPORT.md / .json at the repo root
 *
 * Measures how well the tool's keyword rules match HUMAN INTENT, using labelled phrases (tests/rule-quality/corpus-*.json):
 *   BEFORE  the original rules (tests/rule-quality/previous-rules.json - captured from the tool before the 2026-10-10 change set)
 *   NOW     the rules the tool has today, read through the real engine exports (includes the negation guard)
 *   A / B   the two proposal sets that were evaluated before adoption (B was adopted; kept for reference)
 * Per rule: precision / recall / false positives / false negatives. Per engine: how often the first-match-wins outcome is the hint a person would expect.
 * A MEASUREMENT, not a gate: it fails only if the harness or the corpus is broken. The corpus and the adopted rules share an author, so NOW is optimistic.
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
const proposals = load('proposed-rules.json'), previous = load('previous-rules.json');

const ENGINES = [
  { id: 'release_hint', corpus: 'corpus-release.json', table: 'RELEASE_AI_RULES', textOf: (c) => c.t.toLowerCase() + ' ', input: (c) => ({ name: c.t, notes: '', deliveryModels: [] }), ruleOf: (o) => (o.matched ? Number(o.rule.replace('release_rule_', '')) : null) },
  { id: 'defect_hint', corpus: 'corpus-defect.json', table: 'DEFECT_AI_RULES', textOf: (c) => c.t, input: (c) => ({ title: c.t }), ruleOf: (o) => (o.matched ? Number(o.rule.replace('defect_rule_', '')) : null) }
];
const pct = (n, d) => (d ? Math.round((100 * n) / d) : 100);

function evaluate(eng, corpus, patterns) {
  const rules = tables[eng.table];
  const res = { rules: [], engine: { correct: 0, total: corpus.cases.length, missed: [], falseAlarm: [], wrongHint: [] } };
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
  res.picks = corpus.cases.map((c) => {
    const text = eng.textOf(c);
    if (patterns) { for (let i = 0; i < rules.length; i++) { if (new RegExp(patterns[String(i)], 'i').test(text)) return i; } return null; }
    const env = E.run(eng.id, eng.input(c)); return env.status === 'computed' ? eng.ruleOf(env.output) : null;
  });
  corpus.cases.forEach((c, k) => {
    const actual = res.picks[k], expected = c.c.length ? Math.min.apply(null, c.c) : null;
    if (actual === expected) res.engine.correct++;
    else if (actual === null) res.engine.missed.push({ t: c.t, expected, note: c.note });
    else if (expected === null) res.engine.falseAlarm.push({ t: c.t, actual, note: c.note });
    else res.engine.wrongHint.push({ t: c.t, expected, actual, note: c.note });
  });
  return res;
}

const out = {};
for (const eng of ENGINES) {
  const corpus = load(eng.corpus);
  corpus.cases.forEach((c) => { if (!c.t || !Array.isArray(c.c)) throw new Error('bad corpus case ' + JSON.stringify(c)); });
  if (eng.id === 'defect_hint') corpus.cases.forEach((c) => { if (c.t.trim().length < 8) throw new Error('defect corpus phrase under 8 characters: ' + c.t); });
  out[eng.id] = { corpus, before: evaluate(eng, corpus, previous[eng.id]), now: evaluate(eng, corpus, null), A: evaluate(eng, corpus, proposals[eng.id].A), B: evaluate(eng, corpus, proposals[eng.id].B) };
}

function summary(eid) {
  const o = out[eid];
  const line = (name, r) => {
    const tp = r.rules.reduce((a, x) => a + x.tp, 0), fp = r.rules.reduce((a, x) => a + x.fp, 0), fn = r.rules.reduce((a, x) => a + x.fn, 0);
    return `  ${name.padEnd(12)} engine-correct ${String(r.engine.correct).padStart(3)}/${r.engine.total} (${pct(r.engine.correct, r.engine.total)}%)  | rule-level false positives ${String(fp).padStart(3)}, false negatives ${String(fn).padStart(3)}, precision ${pct(tp, tp + fp)}%, recall ${pct(tp, tp + fn)}%`;
  };
  return `${eid} (${o.corpus.cases.length} labelled phrases)\n${line('BEFORE', o.before)}\n${line('NOW (adopted)', o.now)}\n${line('ref: A', o.A)}\n${line('ref: B', o.B)}`;
}
console.log(ENGINES.map((e) => summary(e.id)).join('\n\n'));

if (WRITE_REPORT) {
  const lbl = (x) => (x === null || x === undefined ? 'no hint' : 'rule ' + x);
  const L = ['# Rule quality report - Release Management tool', '',
    '*Generated by `agent-layer/tests/rule_quality.js` - do not edit by hand.*', '',
    '**Status (2026-10-10): the whole-word + vocabulary rule set (proposal B) and the negation guard were ADOPTED into the tool (decisions Q-1, Q-2, Q-3, approved by James). "BEFORE" is the original rules, "NOW" is what the tool does today.**', '',
    '**How to read this.** Each labelled phrase says which concept(s) a release / defect manager would say it is about (labels were written by intent, without looking at the rules\' results, by Claude - they still need a practitioner\'s review). A rule is *right* when it fires for phrases about its concept and stays quiet otherwise. **Engine-correct** counts phrases where the hint actually shown (first match wins) is the one a person would expect (or none). The corpus and the adopted rules were written by the same author, so NOW is optimistic, and the corpus deliberately over-represents hard cases - do not read the percentages as production accuracy.', ''];
  for (const eng of ENGINES) {
    const o = out[eng.id];
    L.push(`## ${eng.id === 'release_hint' ? 'Release planner rules (`RELEASE_AI_RULES`)' : 'Defect triage rules (`DEFECT_AI_RULES`)'}`, '', '```', summary(eng.id), '```', '',
      '| # | Concept | BEFORE precision / recall | NOW precision / recall |', '|---|---|---|---|');
    o.before.rules.forEach((r, i) => L.push(`| ${i} | ${r.concept} | ${r.precision}% / ${r.recall}% (FP ${r.fp}, FN ${r.fn}) | ${o.now.rules[i].precision}% / ${o.now.rules[i].recall}% (FP ${o.now.rules[i].fp}, FN ${o.now.rules[i].fn}) |`));
    L.push('', '### How the original rules went wrong (fixed by the adopted set unless listed under "still wrong now")', '');
    o.before.rules.forEach((r) => {
      if (!r.fp && !r.fn) return;
      L.push(`**Rule ${r.index} - ${r.concept}**`);
      if (r.fpList.length) L.push('* *Fired when it should not:* ' + r.fpList.map((t) => '"' + t + '"').join('; '));
      if (r.fnList.length) L.push('* *Missed:* ' + r.fnList.map((t) => '"' + t + '"').join('; '));
      L.push('');
    });
    const corpusCases = o.corpus.cases;
    const worse = corpusCases.map((c, k) => ({ c, b: o.before.picks[k], n: o.now.picks[k], expected: c.c.length ? Math.min.apply(null, c.c) : null })).filter((x) => x.b === x.expected && x.n !== x.expected);
    L.push('### What got worse (right before, wrong now)', '', worse.length ? worse.map((x) => `* "${x.c.t}" - expected ${lbl(x.expected)}, now ${lbl(x.n)}`).join('\n') : '* nothing that was right before is wrong now.', '');
    const resid = corpusCases.map((c, k) => ({ c, n: o.now.picks[k], expected: c.c.length ? Math.min.apply(null, c.c) : null })).filter((x) => x.n !== x.expected);
    L.push('### Still wrong now (residual - known limits, not hidden)', '', resid.length ? resid.map((x) => `* "${x.c.t}" - expected ${lbl(x.expected)}, now ${lbl(x.n)}${x.c.note ? ' *(' + x.c.note + ')*' : ''}`).join('\n') : '* none', '');
  }
  L.push('## Limits of this measurement', '',
    '* Labels are one author\'s judgement; several phrases are marked with a note in the corpus.',
    '* The corpus is small (a few dozen phrases per rule) and written to include known substring traps; NOW was tuned by the author who wrote the corpus.',
    '* Substring and keyword matching can never be a classifier: the hints are prompts for a human, and the tool now says so on every hint ("a keyword match, not an assessment").', '');
  fs.writeFileSync(path.join(ROOT, 'RULE-QUALITY-REPORT.md'), L.join('\n'), 'utf8');
  fs.writeFileSync(path.join(ROOT, 'RULE-QUALITY-REPORT.json'), JSON.stringify(Object.fromEntries(ENGINES.map((e) => [e.id, out[e.id].corpus.cases.map((c, k) => ({ t: c.t, expected: c.c.length ? Math.min.apply(null, c.c) : null, before: out[e.id].before.picks[k], now: out[e.id].now.picks[k] }))])), null, 1) + '\n', 'utf8');
  console.log('\nwrote RULE-QUALITY-REPORT.md and RULE-QUALITY-REPORT.json');
}
