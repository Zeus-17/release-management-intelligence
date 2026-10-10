/*!
 * Agent-layer ENGINE EXPORTS - Release Management tool  (Build Brief: engine invocation; Master Plan Phase E)
 *
 * PER-TOOL file (the ITSM repo has its own engine-exports.js with the same API): NOT part of the hash-locked shared set.
 * Embedded by agent-layer/embed.py after the shared modules.
 *
 * WHAT IT IS
 *   Read-only, side-effect-free versions of the tool's deterministic engines, so the agent layer can ask "what would the
 *   rules engine say for THIS input?" without touching the user's form, the DOM, STATE, storage or any global.
 *   The legacy engines read and write the DOM (runReleaseAI/runDefectAI even overwrite the severity and classification
 *   fields), so they cannot be called safely from an assistant. These exports are NOT a second rules engine:
 *     - the keyword rule tables (RELEASE_AI_RULES, DEFECT_AI_RULES) and the gate definitions (GATE_DEFS) are read BY REFERENCE
 *       from the tool at call time - a content-layer update to a table is picked up automatically, and the audit trail's
 *       engine fingerprint (config.json engineSources) still detects it;
 *     - the few formulas/literals that live inside engine functions rather than tables (readiness weights, risk bands,
 *       hint wording) are mirrored here and PROVEN IDENTICAL by tests/parity_run.js (Node, runs the tool's real source) and
 *       tests/rm-parity-runner.html (real browser, real DOM) on every fixture and on thousands of fuzzed inputs.
 *   If the engine changes and a mirror drifts, the parity test fails - that is the guarantee, and it is part of every gate.
 *
 * OUTPUT SHAPE
 *   Every call returns an envelope that conforms to schemas/engine-outputs.schema.json (verified before it is returned):
 *     {engine, status:'computed', output, caveats}  |  {engine, status:'cannot_be_determined'|'not_assessed', missing}
 *   A computed result is verbatim engine output; this module never rewords engine text and never invents a verdict.
 *   `decision_record` (the human GO / NO-GO) is deliberately NOT exportable: it is a recorded human decision, not a computation.
 *
 * DEGENERATE READINESS CASES: a release with zero gates or an empty environment path used to score 50/100 or NaN. Since the Q-7/Q-8 engine
 *   change the tool reports "not assessed"; run() returns cannot_be_determined for both (same meaning, the unresolved-input policy agrees).
 *
 * INERT UNTIL USED. No listeners, timers, storage or network. Never throws for bad input (returns a status instead).
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) { module.exports = factory; }   // tests inject a root that holds the tool's tables
  else { root.AgentEngine = factory(root); }
})(typeof self !== 'undefined' ? self : this, function (root) {
  'use strict';

  var VERSION = 'ee-1.0-rm';
  var TOOL = 'rm';

  /** The tool's own tables and PURE helper functions, referenced BY NAME in the global scope at call time (never copied). */
  var REQUIRED = ['RELEASE_AI_RULES', 'DEFECT_AI_RULES', 'GATE_DEFS', 'stripNegatedTerms', 'matchedTextOf', 'isUnresolvedBlocker'];

  function table(name) {
    switch (name) {
      case 'RELEASE_AI_RULES': return typeof RELEASE_AI_RULES !== 'undefined' ? RELEASE_AI_RULES : null; // eslint-disable-line no-undef
      case 'DEFECT_AI_RULES': return typeof DEFECT_AI_RULES !== 'undefined' ? DEFECT_AI_RULES : null;    // eslint-disable-line no-undef
      case 'GATE_DEFS': return typeof GATE_DEFS !== 'undefined' ? GATE_DEFS : null;                      // eslint-disable-line no-undef
      case 'stripNegatedTerms': return typeof stripNegatedTerms === 'function' ? stripNegatedTerms : null; // eslint-disable-line no-undef
      case 'matchedTextOf': return typeof matchedTextOf === 'function' ? matchedTextOf : null;            // eslint-disable-line no-undef
      case 'isUnresolvedBlocker': return typeof isUnresolvedBlocker === 'function' ? isUnresolvedBlocker : null; // eslint-disable-line no-undef
      default: return null;
    }
  }

  /** Are all the tool tables this module depends on present? Fail closed if the tool changed shape. */
  function ready() {
    var missing = REQUIRED.filter(function (n) { var t = table(n); return !t || (typeof t !== 'object' && typeof t !== 'function'); });
    return { ok: missing.length === 0, missing: missing };
  }

  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function AL() { return root && root.AgentLayer ? root.AgentLayer : null; }

  /* ---------------------------------------------------------------------------------------------- envelopes */

  function computed(engine, output, caveats) { return { engine: engine, status: 'computed', output: output, caveats: (caveats || []).map(clone) }; }
  function nonAnswer(engine, status, missing) { return { engine: engine, status: status, missing: missing.map(clone) }; }
  function unavailable(engine, why) { return { engine: engine, status: 'rejected', reason: why }; }

  /**
   * Final safety net: the envelope must satisfy the output schema before it leaves this module. A drifted table (for example
   * a tenth release rule) fails HERE, loudly, rather than flowing on as a malformed result.
   */
  function finish(engine, envelope) {
    var al = AL();
    if (al && al.validate && typeof al.validate.against === 'function') {
      var errs;
      try { errs = al.validate.against('outputs', engine, envelope); } catch (e) { errs = null; }
      if (errs && errs.length) return unavailable(engine, 'engine_output_invalid');
    }
    if (al && al.debug && al.debug.isOn && al.debug.isOn('engine_output') && typeof console !== 'undefined' && console.debug) {
      console.debug('[AgentLayer:engine_output]', { engine: engine, status: envelope.status });   // named debug breakpoint (Brief: layer boundaries)
    }
    return envelope;
  }

  /* ---------------------------------------------------------------------------------------------- release_hint
   * Mirrors runReleaseAI(): the >=4 delivery-model complexity check comes FIRST and short-circuits the keyword rules;
   * otherwise the first matching rule wins, scanning lower-cased `name + ' ' + notes`. */

  function dmComplexityHtml(n) {
    return '<strong>High-complexity multi-model release.</strong> ' + n + ' delivery models selected. Releases spanning 4+ delivery models have statistically higher change failure rates. Consider: breaking into smaller releases where possible; assigning a dedicated contact per delivery model for the go-live window; extending the hypercare period to 72 hours minimum.';
  }

  function releaseHint(input, caveats) {
    var rules = table('RELEASE_AI_RULES');
    var name = String(input.name === undefined || input.name === null ? '' : input.name).toLowerCase();
    var notes = String(input.notes === undefined || input.notes === null ? '' : input.notes).toLowerCase();
    var dms = input.deliveryModels || [];
    var text = name + ' ' + notes;
    var complete = !(caveats && caveats.length);
    if (dms.length >= 4) {
      return computed('release_hint', { matched: true, rule: 'dm_complexity', level: 'warn', hint_html: dmComplexityHtml(dms.length), complete: complete }, caveats);
    }
    var scan = table('stripNegatedTerms')(text);        // Q-3: negated keywords ("non-urgent") are ignored - the tool's own pure helper
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].pattern.test(scan)) {
        var out = { matched: true, rule: 'release_rule_' + i, level: rules[i].level, hint_html: rules[i].hint, complete: complete };
        var mt = table('matchedTextOf')(rules[i], scan);  // Q-5: the words that triggered it
        if (mt) out.matched_text = mt;
        return computed('release_hint', out, caveats);
      }
    }
    return computed('release_hint', { matched: false, complete: complete }, caveats);
  }

  /* ---------------------------------------------------------------------------------------------- defect_hint
   * Mirrors runDefectAI(): nothing for titles shorter than 8 characters (after trim); first matching rule wins over the
   * UNTRIMMED title. The legacy function also overwrites the severity and classification fields - here they are only
   * SUGGESTIONS in the output; nothing is written anywhere. */

  function defectHint(input, caveats) {
    var rules = table('DEFECT_AI_RULES');
    var title = String(input.title === undefined || input.title === null ? '' : input.title);
    if (title.trim().length < 8) return nonAnswer('defect_hint', 'not_assessed', [{ field: 'title', reason_code: 'title_too_short' }]);
    for (var i = 0; i < rules.length; i++) {
      if (rules[i].pattern.test(title)) {
        var o = { matched: true, rule: 'defect_rule_' + i, hint_html: rules[i].hint };
        var mtd = table('matchedTextOf')(rules[i], title);
        if (mtd) o.matched_text = mtd;
        if (rules[i].sev) o.suggested_severity = rules[i].sev;
        if (rules[i].cls) o.suggested_classification = rules[i].cls;
        return computed('defect_hint', o, caveats);
      }
    }
    return computed('defect_hint', { matched: false }, caveats);
  }

  /* ---------------------------------------------------------------------------------------------- readiness
   * Mirrors calculateReadiness(): gates 40% / defects 30% / environments 20% / sign-offs 10%, each rounded, then the weighted
   * sum rounded. There is NO Go/No-Go threshold in this engine (colour bands 75/50 are display only). */

  /** The tool's readiness arithmetic for a release that HAS gates and environments (the two degenerate cases are 'not assessed' in the tool since Q-7/Q-8). */
  function legacyReadiness(input) {
    var gates = input.gates || [];
    var gatesTotal = gates.length || 1;
    var gatesDone = gates.filter(function (g) { return g.status === 'passed' || g.status === 'waived'; }).length;
    var gatesPct = Math.round((gatesDone / gatesTotal) * 100);
    // R-1: the tool's own rule decides what is an open blocker. The input only says WHETHER a named decision / confirmation is recorded (never who or why), so a stand-in record is built for the tool's helper.
    var isOpenBlocker = table('isUnresolvedBlocker');
    var blockers = (input.defects || []).filter(function (d) {
      return isOpenBlocker({ classification: d.classification, status: d.status,
        decision: d.decisionRecorded ? { by: 'recorded', reason: 'recorded' } : null, confirmation: d.confirmationRecorded ? { by: 'recorded' } : null });
    }).length;
    var defectScore = blockers === 0 ? 100 : blockers === 1 ? 60 : blockers === 2 ? 30 : 0;
    var envs = input.envPath;
    var envObj = {};
    (input.environments || []).forEach(function (e) { if (!Object.prototype.hasOwnProperty.call(envObj, e.env)) envObj[e.env] = { health: e.health }; });
    var healthy = envs.filter(function (e) { return envObj[e] && envObj[e].health === 'healthy'; }).length;
    var envPct = Math.round((healthy / envs.length) * 100);
    var signoffDone = gates.filter(function (g) { return g.signedBy && g.status === 'passed'; }).length;
    var signoffTotal = gates.filter(function (g) { return g.status === 'passed'; }).length || 1;
    var signoffPct = Math.round((signoffDone / signoffTotal) * 100);
    var score = Math.round(gatesPct * 0.4 + defectScore * 0.3 + envPct * 0.2 + signoffPct * 0.1);
    return { score: score, gates: gatesPct, defects: defectScore, envs: envPct, signoffs: signoffPct };
  }

  function readiness(input, caveats) {
    var missing = [];
    if (!input.gates || !input.gates.length) missing.push({ field: 'gates', reason_code: 'gates_missing' });
    if (!input.envPath || !input.envPath.length) missing.push({ field: 'envPath', reason_code: 'env_path_missing' });
    if (missing.length) return nonAnswer('readiness', 'cannot_be_determined', missing);
    return computed('readiness', legacyReadiness(input), caveats);
  }

  /* ---------------------------------------------------------------------------------------------- gate_hint
   * Mirrors getGateReadinessHint(): up to five conditional hints, in the engine's order. Each hint is the engine's own
   * <span> text; the legacy function joins them with <br> inside a wrapper - the wrapper is display, not engine content. */

  function gateHint(input, caveats) {
    var defs = table('GATE_DEFS');
    var def = defs[input.gateId] || {};
    var entryTotal = (def.entryCriteria || []).length, exitTotal = (def.exitCriteria || []).length;
    var entryChecked = input.entryConfirmed, exitChecked = input.exitConfirmed;
    var hints = [];
    if (input.gateId === 'gng' && input.blockerCount > 0) {
      hints.push({ kind: 'blockers_open', text_html: '<span style="color:var(--red);">⬡ ' + input.blockerCount + ' release-blocking defect(s) open — Go/No-Go must be NO-GO until resolved or formally waived at Director level.</span>' });
    }
    if (entryChecked < entryTotal) {
      hints.push({ kind: 'entry_unconfirmed', text_html: '<span style="color:var(--amber);">⬡ ' + (entryTotal - entryChecked) + ' entry criteria not yet confirmed — review before signing off.</span>' });
    }
    if (exitChecked < exitTotal) {
      hints.push({ kind: 'exit_unconfirmed', text_html: '<span style="color:var(--amber);">⬡ ' + (exitTotal - exitChecked) + ' exit criteria not yet confirmed — ensure all evidence is captured.</span>' });
    }
    if (input.gateId === 'deploy' && input.preProdVersion && input.prodVersion && input.preProdVersion !== input.prodVersion) {
      hints.push({ kind: 'version_mismatch', text_html: '<span style="color:var(--accent);">⬡ Version mismatch: PRE-PROD is ' + input.preProdVersion + ', PROD is ' + input.prodVersion + '. Confirm this is the expected delta before deploying.</span>' });
    }
    if ((input.deliveryModels || []).indexOf('mobile') !== -1 && input.gateId === 'deploy') {
      hints.push({ kind: 'mobile_store_approval', text_html: '<span style="color:var(--sky);">⬡ Mobile delivery in scope — confirm app store submission was approved before recording production deployment complete.</span>' });
    }
    return computed('gate_hint', { hints: hints, complete: !(caveats && caveats.length) }, caveats);
  }

  /* ---------------------------------------------------------------------------------------------- risk_score
   * Mirrors the risk register: score = likelihood x impact (savePlannerRisk), band high >= 15, medium >= 8, otherwise low
   * (renderPlannerRisks). These two literals live inside functions rather than tables, so parity is proven in the browser harness. */

  function riskScore(input, caveats) {
    var score = input.likelihood * input.impact;
    return computed('risk_score', { score: score, band: score >= 15 ? 'high' : score >= 8 ? 'medium' : 'low' }, caveats);
  }

  /* ---------------------------------------------------------------------------------------------- public API */

  var IMPL = { release_hint: releaseHint, defect_hint: defectHint, readiness: readiness, gate_hint: gateHint, risk_score: riskScore };
  var DEPENDS = { release_hint: ['RELEASE_AI_RULES', 'stripNegatedTerms', 'matchedTextOf'], defect_hint: ['DEFECT_AI_RULES', 'matchedTextOf'], gate_hint: ['GATE_DEFS'], readiness: [], risk_score: [] };

  /**
   * Run engine `engine` on an already-resolved, schema-valid engine input. `caveats` are those produced by the unresolved-input
   * policy (AgentLayer.validate.draft -> {status:'ready', engine_input, caveats}); a caveat forces `complete:false` where the output has that flag.
   * The input is re-validated against the strict input schema (defence in depth) - nothing is coerced or repaired.
   */
  function run(engine, input, caveats) {
    if (engine === 'decision_record') return unavailable(engine, 'human_decision_only');
    if (!Object.prototype.hasOwnProperty.call(IMPL, engine)) return unavailable(engine, 'unknown_engine');
    if (!input || typeof input !== 'object' || Array.isArray(input)) return unavailable(engine, 'engine_input_invalid');
    var rd = ready();
    var need = DEPENDS[engine].filter(function (n) { return rd.missing.indexOf(n) !== -1; });
    if (need.length) return unavailable(engine, 'engine_tables_unavailable');
    var al = AL();
    if (al && al.validate && typeof al.validate.against === 'function') {
      var errs;
      try { errs = al.validate.against('inputs', engine, input); } catch (e) { errs = [{ path: '', message: 'validator error' }]; }
      if (errs.length) {
        // the one legitimate "valid draft, but the engine would show nothing" case is surfaced as not_assessed, as the policy says
        if (engine === 'defect_hint' && input && typeof input.title === 'string' && input.title.trim().length < 8) return finish(engine, defectHint(input, caveats));
        return unavailable(engine, 'engine_input_invalid');
      }
    }
    return finish(engine, IMPL[engine](clone(input), caveats || []));
  }

  /**
   * Full path from an agent DRAFT: validate -> resolve unresolved inputs per the policy -> run the engine.
   *   returns the output envelope, or {engine, status:'rejected', reason} when the draft itself is malformed / forbidden.
   * `opts.agentSupplied` lists paths the model tried to set (rejected for fields the policy marks agent_writable:'no').
   */
  function evaluate(engine, draft, opts) {
    var al = AL();
    if (!al) return unavailable(engine, 'agent_layer_unavailable');
    if (engine === 'decision_record') return unavailable(engine, 'human_decision_only');
    var v = al.validate.draft(engine, draft, opts);
    if (v.status === 'ready') return run(engine, v.engine_input, v.caveats);
    if (v.status === 'rejected') return unavailable(engine, v.reason);
    return finish(engine, nonAnswer(engine, v.status, v.missing));
  }

  return Object.freeze({
    version: VERSION, tool: TOOL,
    engines: function () { return Object.keys(IMPL); },
    ready: ready, run: run, evaluate: evaluate,
    _test: { legacyReadiness: legacyReadiness, table: table }
  });
});
