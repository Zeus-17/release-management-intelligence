#!/usr/bin/env node
/*
 * ENGINE PARITY (Master Plan Phase E) - RM repo.  PER-TOOL file (the ITSM repo has its own); not in the shared hash-lock.
 *
 *   node agent-layer/tests/parity_run.js
 *
 * Proves that agent-layer/engine-exports.js (read-only, pure) returns EXACTLY what the tool's real, DOM-driven engines produce.
 * It does this by extracting the tool's REAL source text (rule tables + engine functions, straight from the HTML) into an
 * isolated VM context with a tiny fake DOM, running the real function and the pure export on the same input, and comparing:
 *   release_hint  vs runReleaseAI()          rule, level, hint text, class, the complexity short-circuit, case, ordering
 *   defect_hint   vs runDefectAI()           rule, hint, the suggested severity/classification the legacy code WRITES, the 8-char rule
 *   readiness     vs calculateReadiness()    all five numbers, including the two legacy artefacts (zero gates, empty path -> NaN)
 *   gate_hint     vs getGateReadinessHint()  the exact HTML string
 *   risk_score    vs the documented L x I / 15 / 8 bands (the real code is inline in DOM handlers: proven in the browser harness)
 * Corpora are generated FROM the real rule tables (every keyword of every rule, every pair of rules, near-misses, substrings,
 * case variants) plus seeded random fuzz, so a changed or added rule is covered automatically.
 * Also proves: nothing is written (DOM untouched, tables frozen, STATE unchanged), decision_record is refused, a drifted tool
 * (missing table / extra rule) fails closed, and every output validates against schemas/engine-outputs.schema.json.
 *
 * Env: PARITY_EXPORTS_SRC=<file>  run against a different engine-exports.js (used by the mutation check).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const HTML_PATH = path.resolve(ROOT, cfg.html);
const EXPORTS_PATH = process.env.PARITY_EXPORTS_SRC ? path.resolve(process.env.PARITY_EXPORTS_SRC) : path.join(ROOT, 'engine-exports.js');
const QUIET = process.argv.includes('--quiet');
const EMBEDDED = process.argv.includes('--embedded');   // test the compacted block exactly as shipped in the tool HTML

let pass = 0; const failures = [];
function ok(c, m) { if (c) pass++; else { failures.push(m); if (failures.length <= 40 && !QUIET) console.log('  FAIL:', m); } }
const log = (...a) => { if (!QUIET) console.log(...a); };
const J = (v) => JSON.stringify(v);

/* ---------------------------------------------------------------------------------------------- source extraction */

/** Text of the tool BEFORE the embedded agent-layer block (so we only ever read the tool's own code). */
function toolSource() {
  const html = fs.readFileSync(HTML_PATH, 'utf8').replace(/\r\n/g, '\n');
  const i = html.indexOf('<!-- AGENT-LAYER:BEGIN');
  return i === -1 ? html : html.slice(0, i);
}

/** Pull one top-level declaration (column 0) out of the tool: `function NAME(...) {...}` or `const NAME = [...]/{...};`. */
function declaration(src, name) {
  const lines = src.split('\n');
  const isFn = (l) => l.startsWith('function ' + name + '(');
  const isConst = (l) => l.startsWith('const ' + name + ' =') || l.startsWith('let ' + name + ' =');
  const starts = [];
  lines.forEach((l, i) => { if (isFn(l) || isConst(l)) starts.push(i); });
  if (starts.length !== 1) throw new Error('declaration "' + name + '" found ' + starts.length + ' times in the tool (expected exactly 1)');
  const s = starts[0];
  const fn = isFn(lines[s]);
  for (let j = s; j < lines.length; j++) {
    const l = lines[j];
    if (fn ? l === '}' : /^[\]}];?$/.test(l) || (j === s && /;\s*$/.test(l))) return lines.slice(s, j + 1).join('\n');
  }
  throw new Error('could not find the end of "' + name + '"');
}

/* ---------------------------------------------------------------------------------------------- fake DOM + VM context */

function makeDom() {
  const els = {};
  const dom = { guard: false, reads: 0, el, document: null };
  function el(id) {
    if (!els[id]) {
      let cn = '';
      const classList = {
        contains: (c) => cn.split(/\s+/).includes(c),
        add: (c) => { if (!cn.split(/\s+/).includes(c)) cn = (cn + ' ' + c).trim(); },
        remove: (c) => { cn = cn.split(/\s+/).filter((x) => x && x !== c).join(' '); }
      };
      els[id] = { id, value: '', innerHTML: '', textContent: '', get className() { return cn; }, set className(v) { cn = String(v); }, classList };
    }
    return els[id];
  }
  dom.document = { getElementById(id) { dom.reads++; if (dom.guard) throw new Error('pure export touched the DOM: ' + id); return el(id); } };
  return dom;
}

function freezeDeep(o) { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.keys(o).forEach((k) => freezeDeep(o[k])); } return o; }

function makeContext(opts) {
  opts = opts || {};
  const dom = makeDom();
  const ctx = vm.createContext({ console, document: dom.document });
  const src = toolSource();
  const names = ['RELEASE_AI_RULES', 'DEFECT_AI_RULES'].concat(opts.omitGateDefs ? [] : ['GATE_DEFS']);
  const fns = ['runReleaseAI', 'runDefectAI', 'getGateReadinessHint', 'calculateReadiness'];
  const parts = ['const STATE = { selectedDMs: [], defects: [] };', 'let _lastReleaseAIRule = null;']
    .concat(names.map((n) => declaration(src, n))).concat(fns.map((n) => declaration(src, n)));
  parts.push('var __bridge = { STATE: STATE, last: function () { return _lastReleaseAIRule; }, runReleaseAI: runReleaseAI, runDefectAI: runDefectAI, ' +
    'calculateReadiness: calculateReadiness, getGateReadinessHint: getGateReadinessHint, tables: { RELEASE_AI_RULES: RELEASE_AI_RULES, DEFECT_AI_RULES: DEFECT_AI_RULES' +
    (opts.omitGateDefs ? '' : ', GATE_DEFS: GATE_DEFS') + ' } };');
  vm.runInContext(parts.join('\n'), ctx, { filename: 'tool-real-source' });
  if (opts.freezeTables !== false) Object.keys(ctx.__bridge.tables).forEach((k) => freezeDeep(ctx.__bridge.tables[k]));
  // agent layer + the module under test, in the same context (so the exports see the tool's tables by name)
  if (EMBEDDED) {
    // test the module exactly as SHIPPED: the compacted <script id="agent-layer"> block from the tool HTML, with its own bootstrap
    const html = fs.readFileSync(HTML_PATH, 'utf8');
    const m = html.match(/<script id="agent-layer">([\s\S]*?)<\/script>\s*<!-- AGENT-LAYER:END -->/);
    if (!m) throw new Error('no embedded agent-layer block in the tool HTML');
    const store = {};
    ctx.localStorage = { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); }, removeItem: (k) => { delete store[k]; } };
    ctx.self = ctx; ctx.window = ctx;
    vm.runInContext(m[1], ctx, { filename: 'embedded-agent-layer.js' });
    return { ctx, dom, b: ctx.__bridge, E: ctx.AgentEngine, AL: ctx.AgentLayer };
  }
  if (!opts.skipAgentLayer) {
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'validation.js'), 'utf8'), ctx, { filename: 'validation.js' });
    const sc = (f) => JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'schemas', f), 'utf8'));
    vm.runInContext('AgentLayer.configure(' + J({ tool: cfg.tool, paymentLabel: cfg.paymentLabel, schemas: { inputs: sc('engine-inputs.schema.json'), drafts: sc('agent-drafts.schema.json'), outputs: sc('engine-outputs.schema.json'), policy: sc('unresolved-policy.json') } }) + ');', ctx);
  }
  vm.runInContext(fs.readFileSync(EXPORTS_PATH, 'utf8'), ctx, { filename: 'engine-exports.js' });
  return { ctx, dom, b: ctx.__bridge, E: ctx.AgentEngine, AL: ctx.AgentLayer };
}

/* ---------------------------------------------------------------------------------------------- deterministic randomness + corpora */

function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const pick = (r, a) => a[Math.floor(r() * a.length)];

/** Plain-text samples for one alternation token of a rule regex (handles escapes, '.' and '.?'). */
function tokenSamples(tok) {
  const base = tok.replace(/\\\//g, '/').replace(/\\(.)/g, '$1');
  const v = new Set();
  if (base.includes('.?')) { v.add(base.replace(/\.\?/g, '')); v.add(base.replace(/\.\?/g, ' ')); v.add(base.replace(/\.\?/g, '-')); }
  else if (base.includes('.')) { v.add(base.replace(/\./g, ' ')); v.add(base.replace(/\./g, '-')); }
  else v.add(base);
  return [...v];
}
function ruleTokens(rules) {
  return rules.map((r) => r.pattern.source.split('|').map(tokenSamples).reduce((a, b) => a.concat(b), []));
}

const ENV_ALL = ['DEV', 'SIT', 'UAT', 'PRE-PROD', 'PROD'];
const GATE_IDS = ['dev-complete', 'code-review', 'sit', 'uat', 'preprod', 'gng', 'deploy', 'hypercare'];
const GATE_STATUS = ['not-started', 'pending', 'in-progress', 'passed', 'failed', 'waived'];
const HEALTH = ['unknown', 'healthy', 'warning', 'blocked'];
const DM_ALL = ['cloud', 'api', 'mobile', 'desktop', 'legacy', 'di2', 'cwa', 'pilot'];
const FILLER = ['the', 'update', 'for', 'service', 'release', 'fix', 'a', 'tidy', 'quarterly', 'new', 'of', 'to', 'v2', 'team', 'housekeeping', 'config'];

/* ---------------------------------------------------------------------------------------------- the tests */

function releaseText(name, notes) { return { name, notes }; }

function runAll() {
  const T0 = Date.now();
  const M = makeContext();
  const { b, dom, E } = M;
  const relRules = b.tables.RELEASE_AI_RULES, defRules = b.tables.DEFECT_AI_RULES;
  const relTok = ruleTokens(relRules), defTok = ruleTokens(defRules);

  log('A. the module and the tool agree on shape');
  ok(E && E.tool === 'rm', 'AgentEngine is loaded for the rm tool');
  ok(E.ready().ok, 'every table the exports depend on is present: ' + J(E.ready()));
  ok(relRules.length === 9 && defRules.length === 8, 'rule counts match the schema enums (9 release, 8 defect) - got ' + relRules.length + '/' + defRules.length + '; a new rule needs a schema update');
  ok(J(E.engines().sort()) === J(['defect_hint', 'gate_hint', 'readiness', 'release_hint', 'risk_score']), 'exported engines');

  // ------------------------------------------------------------------------------------------ B. release_hint parity
  log('B. release_hint == runReleaseAI()');
  function realRelease(f) {
    dom.el('rel-name').value = f.name; dom.el('rel-notes').value = f.notes;
    b.STATE.selectedDMs = f.dms || [];
    const hint = dom.el('rel-ai-hint'); hint.className = 'ai-hint'; dom.el('rel-ai-hint-text').innerHTML = '';
    b.runReleaseAI();
    return { shown: hint.classList.contains('show'), cls: hint.className.replace(/\s+/g, ' ').trim(), html: dom.el('rel-ai-hint-text').innerHTML };
  }
  function checkRelease(f, label) {
    const real = realRelease(f);
    dom.guard = true; let env; try { env = E.run('release_hint', { name: f.name, notes: f.notes, deliveryModels: f.dms || [] }); } finally { dom.guard = false; }
    // The legacy engine will happily scan an empty name + notes; the agent path refuses (policy: a missing name is NOT an all-clear).
    if (!f.name) { ok(env.status !== 'computed', label + ' empty name never yields a computed answer: ' + J(env)); return; }
    const exp = real.shown
      ? (env.status === 'computed' && env.output.matched)
      : (env.status === 'computed' && !env.output.matched);
    if (!exp) { ok(false, label + ' matched-state differs: real=' + J(real) + ' export=' + J(env)); return; }
    if (real.shown) {
      const lvl = env.output.level === 'danger' ? 'danger' : env.output.level === 'warn' ? 'warn' : '';
      const cls = ('ai-hint ' + lvl + ' show').replace(/\s+/g, ' ').trim();
      ok(real.cls === cls, label + ' class real=' + real.cls + ' export=' + cls);
      ok(real.html === '<div class="ai-hint-label">⬡ Intelligence</div>' + env.output.hint_html, label + ' hint html differs');
      const idx = env.output.rule === 'dm_complexity' ? -1 : Number(env.output.rule.replace('release_rule_', ''));
      ok(b.last() === (idx >= 0 ? relRules[idx] : b.last()) || idx === -1, label + ' rule index mismatch');
    }
  }
  const relCases = [];
  const rr = rng(20261010);
  relTok.forEach((toks, i) => toks.forEach((t) => {
    [t, t.toUpperCase(), 'x ' + t + ' y', 'pre' + t + 'post', t.slice(0, -1), ' ' + t].forEach((s) => relCases.push({ name: s, notes: '' }, { name: 'Release', notes: s }));
    relCases.push({ name: 'Release ' + t, notes: 'notes ' + t, dms: [] });
  }));
  for (let i = 0; i < relTok.length; i++) for (let j = 0; j < relTok.length; j++) relCases.push({ name: pick(rr, relTok[i]) + ' ' + pick(rr, relTok[j]), notes: '' }); // first-match-wins ordering
  for (let n = 0; n <= 8; n++) { const dms = DM_ALL.slice(0, n); relCases.push({ name: 'Quarterly housekeeping', notes: '', dms }, { name: 'Payment platform release', notes: '', dms }, { name: 'Docs', notes: 'login', dms }); }
  for (let k = 0; k < 2500; k++) {
    const words = []; const len = 1 + Math.floor(rr() * 6);
    for (let w = 0; w < len; w++) words.push(rr() < 0.35 ? pick(rr, pick(rr, relTok)) : pick(rr, FILLER));
    const dms = rr() < 0.3 ? DM_ALL.filter(() => rr() < 0.45) : [];
    relCases.push({ name: words.slice(0, Math.ceil(len / 2)).join(' '), notes: words.slice(Math.ceil(len / 2)).join(' '), dms });
  }
  relCases.push({ name: 'x', notes: '' }, { name: 'Webhook update', notes: 'Stripe webhook listener update' }, { name: '', notes: 'checkout flow changes' }, { name: 'PAYMENT', notes: '' });
  relCases.forEach((f, i) => checkRelease(f, 'release#' + i + ' ' + J(f).slice(0, 80)));
  log('   ' + relCases.length + ' release cases');

  // ------------------------------------------------------------------------------------------ C. defect_hint parity
  log('C. defect_hint == runDefectAI()');
  function realDefect(title) {
    dom.el('def-title').value = title; dom.el('def-sev').value = 'low'; dom.el('def-class').value = 'known';
    const hint = dom.el('def-ai-hint'); hint.className = 'ai-hint'; dom.el('def-ai-hint-text').innerHTML = '';
    b.runDefectAI();
    return { shown: hint.classList.contains('show'), cls: hint.className.replace(/\s+/g, ' ').trim(), html: dom.el('def-ai-hint-text').innerHTML, sev: dom.el('def-sev').value, kls: dom.el('def-class').value };
  }
  function checkDefect(title, label) {
    const real = realDefect(title);
    dom.guard = true; let env; try { env = E.run('defect_hint', { title }); } finally { dom.guard = false; }
    const short = title.trim().length < 8;
    if (short) { ok(!real.shown && env.status === 'not_assessed' && env.missing[0].reason_code === 'title_too_short' && real.sev === 'low' && real.kls === 'known', label + ' short title: real shows nothing, export is not_assessed ' + J(env)); return; }
    if (!real.shown) { ok(env.status === 'computed' && !env.output.matched && real.sev === 'low' && real.kls === 'known', label + ' no match ' + J(env)); return; }
    ok(env.status === 'computed' && env.output.matched, label + ' should match: ' + J(env));
    if (env.status !== 'computed') return;
    ok(real.sev === env.output.suggested_severity && real.kls === env.output.suggested_classification, label + ' suggestion real=' + real.sev + '/' + real.kls + ' export=' + env.output.suggested_severity + '/' + env.output.suggested_classification);
    ok(real.html === '<div class="ai-hint-label">⬡ Intelligence</div>' + env.output.hint_html, label + ' hint html differs');
    ok(real.cls === ('ai-hint ' + (defRules[Number(env.output.rule.replace('defect_rule_', ''))].sev === 'critical' ? 'danger' : 'warn') + ' show'), label + ' class ' + real.cls);
  }
  const defCases = [];
  defTok.forEach((toks) => toks.forEach((t) => ['Crash ' + t, t + ' in the module', 'Issue: ' + t.toUpperCase(), 'xx' + t + 'yy extra', t, 'The ' + t.slice(0, -1) + ' thing'].forEach((s) => defCases.push(s))));
  for (let i = 0; i < defTok.length; i++) for (let j = 0; j < defTok.length; j++) defCases.push(pick(rr, defTok[i]) + ' and ' + pick(rr, defTok[j]));
  for (let n = 0; n <= 10; n++) { defCases.push('a'.repeat(n)); defCases.push(' '.repeat(n) + 'crash'); defCases.push('crash' + ' '.repeat(n)); defCases.push('payment'.slice(0, Math.min(7, n))); }
  ['Application crash on startup', 'Card payment declined incorrectly', 'Download button misaligned', 'crash!!', 'Typo in footer label', '        ', 'Something unrelated happens here'].forEach((s) => defCases.push(s));
  for (let k = 0; k < 2500; k++) {
    const words = []; const len = 1 + Math.floor(rr() * 6);
    for (let w = 0; w < len; w++) words.push(rr() < 0.35 ? pick(rr, pick(rr, defTok)) : pick(rr, FILLER));
    defCases.push(words.join(' '));
  }
  defCases.forEach((t, i) => checkDefect(t, 'defect#' + i + ' ' + J(t).slice(0, 60)));
  log('   ' + defCases.length + ' defect cases');

  // ------------------------------------------------------------------------------------------ D. readiness parity
  log('D. readiness == calculateReadiness()');
  function mkReadiness(r) {
    const nGates = 1 + Math.floor(r() * 8);
    const gates = Array.from({ length: nGates }, (_, i) => ({ id: GATE_IDS[i % 8], status: pick(r, GATE_STATUS), signedBy: r() < 0.5 ? 'Someone' : '' }));
    const nPath = 1 + Math.floor(r() * 5);
    const envPath = ENV_ALL.filter(() => true).sort(() => r() - 0.5).slice(0, nPath);
    const environments = envPath.filter(() => r() < 0.8).map((e) => ({ env: e, health: pick(r, HEALTH) }));
    const nDef = Math.floor(r() * 6);
    const defects = Array.from({ length: nDef }, (_, i) => ({ releaseId: 'REL-T', classification: pick(r, ['blocker', 'blocker', 'deferred', 'known', 'wontfix']) }));
    return { gates, defects, envPath, environments };
  }
  function realReadiness(inp) {
    const noise = [{ id: 'n1', releaseId: 'OTHER', classification: 'blocker' }, { id: 'n2', releaseId: 'OTHER', classification: 'blocker' }];
    b.STATE.defects = inp.defects.map((d, i) => ({ id: 'd' + i, releaseId: d.releaseId, classification: d.classification })).concat(noise);
    const envObj = {}; inp.environments.forEach((e) => { if (!(e.env in envObj)) envObj[e.env] = { health: e.health }; });
    const out = b.calculateReadiness({ id: 'REL-T', gates: inp.gates.map((g) => ({ id: g.id, status: g.status, signedBy: g.signedBy })), envPath: inp.envPath, environments: envObj });
    b.STATE.defects = [];
    return out;
  }
  function checkReadiness(inp, label) {
    const real = realReadiness(inp);
    dom.guard = true; let leg, env; try { leg = E._test.legacyReadiness(inp); env = E.run('readiness', inp); } finally { dom.guard = false; }
    const same = ['score', 'gates', 'defects', 'envs', 'signoffs'].every((k) => Object.is(real[k], leg[k]));
    ok(same, label + ' numbers real=' + J(real) + ' mirror=' + J(leg));
    if (inp.gates.length && inp.envPath.length) ok(env.status === 'computed' && ['score', 'gates', 'defects', 'envs', 'signoffs'].every((k) => env.output[k] === real[k]), label + ' envelope ' + J(env));
  }
  const rd = rng(7);
  const rdCases = [];
  for (let k = 0; k < 3000; k++) rdCases.push(mkReadiness(rd));
  [0, 2, 4].forEach((gp) => [0, 1, 2, 3].forEach((bl) => [0, 3, 5].forEach((h) => [false, true].forEach((sg) => {
    rdCases.push({ gates: Array.from({ length: 4 }, (_, i) => ({ id: GATE_IDS[i], status: i < gp ? 'passed' : 'pending', signedBy: sg && i < gp ? 'S' : '' })),
      defects: Array.from({ length: bl }, () => ({ releaseId: 'REL-T', classification: 'blocker' })), envPath: ENV_ALL, environments: ENV_ALL.map((e, i) => ({ env: e, health: i < h ? 'healthy' : 'unknown' })) });
  }))));
  rdCases.forEach((c, i) => checkReadiness(c, 'readiness#' + i));
  // legacy artefacts: the mirror reproduces them (parity), the export REFUSES them (policy)
  {
    const noGates = { gates: [], defects: [], envPath: ENV_ALL, environments: ENV_ALL.map((e) => ({ env: e, health: 'healthy' })) };
    const emptyPath = { gates: [{ id: 'sit', status: 'passed', signedBy: 'S' }], defects: [], envPath: [], environments: [] };
    checkReadiness(noGates, 'zero-gates artefact'); checkReadiness(emptyPath, 'empty-path artefact');
    const a = E.run('readiness', noGates), c = E.run('readiness', emptyPath);
    ok(a.status === 'rejected' || a.status === 'cannot_be_determined', 'zero gates is never a computed score: ' + J(a));
    ok(c.status === 'rejected' || c.status === 'cannot_be_determined', 'empty environment path is never a computed score: ' + J(c));
    ok(Number.isNaN(realReadiness(emptyPath).envs), 'sanity: the REAL engine still yields NaN for an empty path (characterised, not fixed)');
    ok(realReadiness(noGates).gates === 0 && realReadiness(noGates).signoffs === 0, 'sanity: the real engine zero-gates behaviour is as characterised');
  }
  log('   ' + rdCases.length + ' readiness cases');

  // ------------------------------------------------------------------------------------------ E. gate_hint parity
  log('E. gate_hint == getGateReadinessHint()');
  const gd = rng(99);
  const defs = b.tables.GATE_DEFS;
  let gateCases = 0;
  function checkGate(inp, label) {
    gateCases++;
    b.STATE.defects = Array.from({ length: inp.blockerCount }, (_, i) => ({ id: 'b' + i, releaseId: 'REL-G', classification: 'blocker' }))
      .concat([{ id: 'x1', releaseId: 'REL-G', classification: 'known' }, { id: 'x2', releaseId: 'OTHER', classification: 'blocker' }]);
    const rel = { id: 'REL-G', environments: { 'PRE-PROD': { version: inp.preProdVersion }, 'PROD': { version: inp.prodVersion } }, deliveryModels: inp.deliveryModels };
    const gate = { id: inp.gateId, checklist: { entry: new Array(inp.entryConfirmed).fill('c'), exit: new Array(inp.exitConfirmed).fill('c') } };
    const real = b.getGateReadinessHint(rel, gate);
    b.STATE.defects = [];
    dom.guard = true; let env; try { env = E.run('gate_hint', inp); } finally { dom.guard = false; }
    if (env.status !== 'computed') { ok(false, label + ' not computed: ' + J(env)); return; }
    const hs = env.output.hints;
    const exp = hs.length ? '<div class="ai-hint show" style="margin-top:10px;"><div class="ai-hint-label">⬡ Intelligence — Gate Readiness</div>' + hs.map((h) => h.text_html).join('<br>') + '</div>' : '';
    ok(real === exp, label + ' real=' + real.slice(0, 120) + ' export=' + exp.slice(0, 120));
  }
  GATE_IDS.forEach((gateId) => {
    const et = (defs[gateId].entryCriteria || []).length, xt = (defs[gateId].exitCriteria || []).length;
    [0, 1, et - 1, et, et + 1].forEach((ec) => [0, xt - 1, xt, xt + 2].forEach((xc) => [0, 1, 3].forEach((bc) => [['', ''], ['1.0.0', '1.0.0'], ['2.0.0', '1.9.0'], ['2.0.0', ''], ['', '1.9.0']].forEach((pv) => [[], ['mobile'], ['cloud', 'mobile']].forEach((dm) => {
      if (ec >= 0 && xc >= 0) checkGate({ gateId, entryConfirmed: ec, exitConfirmed: xc, blockerCount: bc, preProdVersion: pv[0], prodVersion: pv[1], deliveryModels: dm }, 'gate ' + gateId + ' ' + ec + '/' + xc + ' b' + bc + ' ' + pv + ' ' + dm);
    })))));
  });
  for (let k = 0; k < 1500; k++) {
    const gateId = pick(gd, GATE_IDS), et = (defs[gateId].entryCriteria || []).length, xt = (defs[gateId].exitCriteria || []).length;
    checkGate({ gateId, entryConfirmed: Math.floor(gd() * (et + 3)), exitConfirmed: Math.floor(gd() * (xt + 3)), blockerCount: Math.floor(gd() * 5), preProdVersion: pick(gd, ['', '1.0.0', '2.0.0']), prodVersion: pick(gd, ['', '1.0.0', '2.0.0']), deliveryModels: DM_ALL.filter(() => gd() < 0.3) }, 'gate-fuzz#' + k);
  }
  log('   ' + gateCases + ' gate cases');

  // ------------------------------------------------------------------------------------------ F. risk_score
  log('F. risk_score (documented L x I; bands 15 / 8)');
  for (let l = 1; l <= 5; l++) for (let i = 1; i <= 5; i++) {
    const env = E.run('risk_score', { likelihood: l, impact: i });
    const s = l * i, band = s >= 15 ? 'high' : s >= 8 ? 'medium' : 'low';
    ok(env.status === 'computed' && env.output.score === s && env.output.band === band, 'risk ' + l + 'x' + i + ' -> ' + J(env));
  }
  ok(E.run('risk_score', { likelihood: 0, impact: 3 }).status === 'rejected', 'out-of-range likelihood is rejected, not clamped');
  ok(E.run('risk_score', { likelihood: 3 }).status === 'rejected', 'missing impact is rejected');

  // ------------------------------------------------------------------------------------------ G. read-only + fail-closed
  log('G. read-only, refusals and fail-closed behaviour');
  {
    dom.reads = 0; const before = J(b.STATE);
    for (let k = 0; k < 200; k++) { E.run('release_hint', { name: 'Payment upgrade', notes: '', deliveryModels: [] }); E.run('defect_hint', { title: 'Application crash on startup' }); E.run('risk_score', { likelihood: 2, impact: 2 }); }
    ok(dom.reads === 0, 'the exports never read the DOM');
    ok(J(b.STATE) === before, 'the exports never change STATE');
    ok(b.last() !== undefined, 'sanity: bridge works');
    const dm = E.run('decision_record', { decision: 'go', decidedBy: 'x', rationale: '', riskNotes: '' });
    ok(dm.status === 'rejected' && dm.reason === 'human_decision_only', 'decision_record (the human GO / NO-GO) can never be run by the assistant: ' + J(dm));
    ok(E.evaluate('decision_record', {}).reason === 'human_decision_only', 'decision_record is refused on the draft path too');
    ok(E.run('nope', {}).reason === 'unknown_engine', 'unknown engine');
    ok(E.run('release_hint', null).status === 'rejected' && E.run('release_hint', []).status === 'rejected' && E.run('release_hint', 'x').status === 'rejected', 'non-object input is rejected');
    ok(E.run('release_hint', { name: 'a', notes: '', deliveryModels: ['not-a-model'] }).status === 'rejected', 'schema-invalid input is rejected, not repaired');
    ok(E.run('release_hint', { name: 'a', notes: '', deliveryModels: [], extra: 1 }).status === 'rejected', 'unknown fields are rejected');
  }
  {
    const M2 = makeContext({ omitGateDefs: true });
    ok(!M2.E.ready().ok && M2.E.ready().missing.includes('GATE_DEFS'), 'a missing tool table is reported');
    ok(M2.E.run('gate_hint', { gateId: 'gng', entryConfirmed: 0, exitConfirmed: 0, blockerCount: 1, preProdVersion: '', prodVersion: '', deliveryModels: [] }).reason === 'engine_tables_unavailable', 'engines whose table is missing fail closed');
    ok(M2.E.run('risk_score', { likelihood: 3, impact: 3 }).status === 'computed', 'engines that do not need the missing table still work');
  }
  {
    // defence in depth: with NO schema validator present, the engine layer itself still refuses the legacy artefacts
    const M4 = EMBEDDED ? null : makeContext({ skipAgentLayer: true });
    const noGates = { gates: [], defects: [], envPath: ENV_ALL, environments: [] };
    const emptyPath = { gates: [{ id: 'sit', status: 'passed', signedBy: 'S' }], defects: [], envPath: [], environments: [] };
    if (M4) {
      ok(M4.E.run('readiness', noGates).status === 'cannot_be_determined', 'engine layer alone: zero gates -> cannot_be_determined');
      ok(M4.E.run('readiness', emptyPath).status === 'cannot_be_determined', 'engine layer alone: empty environment path -> cannot_be_determined');
      ok(M4.E.run('risk_score', { likelihood: 3, impact: 3 }).output.score === 9, 'works without the validator (no hidden dependency)');
    }
  }
  {
    // drift: a tenth release rule must be refused (output schema enumerates release_rule_0..8), never passed on
    const M3 = makeContext({ freezeTables: false });
    vm.runInContext('RELEASE_AI_RULES.push({ pattern: /zzzdrift/i, level: "warn", hint: "<strong>drift</strong>" });', M3.ctx);
    const r = M3.E.run('release_hint', { name: 'zzzdrift release', notes: '', deliveryModels: [] });
    ok(r.status === 'rejected' && r.reason === 'engine_output_invalid', 'a tool change the schema has not caught up with fails closed: ' + J(r));
  }

  // ------------------------------------------------------------------------------------------ H. draft path (unresolved policy)
  log('H. evaluate(): drafts -> policy -> engine');
  {
    const R = (v) => ({ state: 'resolved', value: v, provenance: 'form' });
    const U = (reason) => ({ state: 'unresolved', reason: reason || 'not_yet_asked' });
    let r = E.evaluate('release_hint', { name: R('Payment gateway upgrade'), notes: U(), deliveryModels: R([]) });
    ok(r.status === 'computed' && r.output.matched && r.output.complete === false && r.caveats.some((c) => c.code === 'assessed_on_name_only'), 'unresolved notes -> computed with caveat, complete:false (a no-match could not be read as all-clear): ' + J(r));
    r = E.evaluate('release_hint', { name: R('Docs'), notes: R(''), deliveryModels: U() });
    ok(r.status === 'computed' && !r.output.matched && r.output.complete === false, 'nothing found + unresolved delivery models is flagged incomplete: ' + J(r));
    r = E.evaluate('release_hint', { name: U(), notes: R(''), deliveryModels: R([]) });
    ok(r.status === 'not_assessed', 'unresolved name -> not_assessed (silence is not an all-clear): ' + J(r));
    r = E.evaluate('defect_hint', { title: U('unknown_to_user') });
    ok(r.status === 'not_assessed', 'unresolved defect title -> not_assessed: ' + J(r));
    r = E.evaluate('risk_score', { likelihood: R(4), impact: U() });
    ok(r.status === 'cannot_be_determined', 'unresolved impact -> cannot_be_determined, no invented score: ' + J(r));
    r = E.evaluate('risk_score', { likelihood: R(4), impact: R(4) });
    ok(r.status === 'computed' && r.output.score === 16 && r.output.band === 'high', 'resolved risk draft: ' + J(r));
    r = E.evaluate('readiness', { gates: [{ id: R('sit'), status: U(), signedBy: R('') }], defects: [], envPath: R(['DEV', 'SIT']), environments: [{ env: R('DEV'), health: R('healthy') }] });
    ok(r.status === 'computed' && r.caveats.some((c) => c.code === 'gate_status_treated_as_not_started'), 'unresolved gate status falls back conservatively with a caveat: ' + J(r));
    r = E.evaluate('readiness', { gates: U(), defects: [], envPath: R(['DEV']), environments: [] });
    ok(r.status === 'cannot_be_determined', 'unresolved gates -> cannot_be_determined (never the legacy 50/100 artefact): ' + J(r));
    r = E.evaluate('gate_hint', { gateId: R('deploy'), entryConfirmed: U(), exitConfirmed: R(99), blockerCount: R(0), preProdVersion: R(''), prodVersion: R(''), deliveryModels: R([]) });
    ok(r.status === 'computed' && r.output.complete === false && r.caveats.some((c) => c.code === 'entry_criteria_treated_as_unconfirmed') && r.output.hints.some((h) => h.kind === 'entry_unconfirmed'), 'gate_hint: unresolved entry count falls back conservatively, caveat travels, complete:false: ' + J(r));
    r = E.evaluate('release_hint', { name: R('x'), notes: R(''), deliveryModels: R([]) }, { agentSupplied: ['decision'] });
    ok(r.status === 'computed' || r.status === 'rejected', 'agentSupplied handling does not throw');
  }

  const secs = ((Date.now() - T0) / 1000).toFixed(1);
  log('\nparity: ' + pass + ' assertions passed, ' + failures.length + ' failed in ' + secs + 's  (tool ' + path.basename(HTML_PATH) + ')');
  return { pass, failed: failures.length, failures };
}

if (require.main === module) {
  let res;
  try { res = runAll(); } catch (e) { console.error('PARITY HARNESS ERROR:', e && e.stack || e); process.exit(2); }
  if (res.failed) { console.log('PARITY FAILED'); process.exit(1); }
  console.log('PARITY PASS: ' + res.pass + ' assertions');
}
module.exports = { runAll };
