#!/usr/bin/env python3
"""
Build the RM tool's constrained-agent schema package (Build Brief Step 2).

Reads enum values straight from ../rm-tool-v1.html so the schemas cannot drift from what the tool accepts,
and writes:
    engine-inputs.schema.json     strictly-typed inputs the deterministic engines consume (no 'unresolved' state)
    agent-drafts.schema.json      same shape, every leaf wrapped in a resolved/unresolved envelope
    engine-outputs.schema.json    three-state results: computed | cannot_be_determined | not_assessed
    unresolved-policy.json        PER FIELD: block, or a named conservative fallback + mandatory caveat
    fixtures/policy-cases.json    conformance cases the Step 3 validation layer (JS) must also pass

Nothing here changes the tool. The deterministic engines remain the only source of verdicts, scores and flags.
Run:  python schemas/build_schemas.py   then   python schemas/check_schemas.py
"""
import json
import os
import re
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _common import (COMMON_DEFS, SCHEMA_DIALECT, dump, leaf_paths, policy_markdown, result_schema, sha256_file, to_agent_draft)

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "..", "rm-tool-v1.html")
TOOL = "rm"


# ----------------------------------------------------------------------------- enums from source
def read_source():
    with open(SRC, encoding="utf-8", errors="ignore") as f:
        return f.read()


def select_options(html, element_id):
    m = re.search(r'<select\b[^>]*\bid="%s"[^>]*>' % re.escape(element_id), html)
    if not m:
        raise SystemExit(f"select #{element_id} not found in source")
    seg = html[m.end(): m.end() + 4000]
    seg = seg[: seg.find("</select>")]
    return [v for v in re.findall(r'<option value="([^"]*)"', seg) if v != ""]


def gate_ids(html):
    i = html.index("const GATE_DEFS = {")
    j = html.index("const EMERGENCY_GATES")
    return re.findall(r"^  '([a-z-]+)': \{", html[i:j], re.M)


def defect_status_ids(html):
    i = html.index("const DEFECT_STATUS_DEFS = {")
    j = html.index("};", i)
    return re.findall(r"^  ([a-z_]+):\s+\{label:", html[i:j], re.M)


def dm_ids(html):
    i = html.index("const DM_GUIDANCE = {")
    j = html.index("};", i)
    return re.findall(r"^  ([a-z0-9]+): \{ label:", html[i:j], re.M)


def build_enums(html):
    e = {
        "RELEASE_TYPE": select_options(html, "rel-type"),
        "DEFECT_CLASS": select_options(html, "def-class"),
        "DEFECT_STATUS": defect_status_ids(html),
        "DELIVERY_MODEL": dm_ids(html),
        "GATE_ID": gate_ids(html),
        # 'not-started' and 'pending' exist only in code (gate creation default / legacy state), the rest are in the gate <select>.
        "GATE_STATUS": ["not-started", "pending", "in-progress", "passed", "failed", "waived"],
        "ENV": ["DEV", "SIT", "UAT", "PRE-PROD", "PROD"],
        "ENV_HEALTH": ["unknown", "healthy", "warning", "blocked"],
    }
    return e


# ----------------------------------------------------------------------------- engine definitions
def engines(E):
    """Return {engine_id: {input: schema, output: schema, doc: str}}."""
    str_nonempty = {"type": "string", "minLength": 1}
    count = {"type": "integer", "minimum": 0}

    release_hint = {
        "input": {
            "type": "object", "required": ["name", "notes", "deliveryModels"], "additionalProperties": False,
            "properties": {
                "name": {**str_nonempty, "description": "Release name (the text the keyword rules scan, with notes)."},
                "notes": {"type": "string", "description": "Release notes text. May be an empty string if the user confirmed there are none."},
                "deliveryModels": {"type": "array", "uniqueItems": True, "items": {"enum": E["DELIVERY_MODEL"]},
                                   "description": "4 or more delivery models trigger the complexity hint before any keyword rule."},
            },
        },
        "output": {
            "type": "object", "required": ["matched"], "additionalProperties": False,
            "properties": {
                "matched": {"type": "boolean"},
                "rule": {"enum": ["dm_complexity"] + [f"release_rule_{i}" for i in range(9)],
                         "description": "dm_complexity = the >=4 delivery-model pre-check; release_rule_0 = payment ... release_rule_8 = decommission. First match wins."},
                "level": {"enum": ["danger", "warn", "info"]},
                "hint_html": {"type": "string", "description": "Verbatim engine text. Never reworded."},
                "matched_text": {"type": "string", "description": "The words in the text that triggered the rule (Q-5). Display aid: a hint is a keyword match, not an assessment."},
            },
        },
        "completeness": True,
        "doc": "runReleaseAI() - 9 keyword rules (first match wins) preceded by the >=4 delivery-model complexity check.",
    }

    defect_hint = {
        "input": {
            "type": "object", "required": ["title"], "additionalProperties": False,
            "properties": {"title": {"type": "string", "minLength": 8,
                                      "description": "Defect title. The engine shows nothing for titles shorter than 8 characters."}},
        },
        "output": {
            "type": "object", "required": ["matched"], "additionalProperties": False,
            "properties": {
                "matched": {"type": "boolean"},
                "rule": {"enum": [f"defect_rule_{i}" for i in range(8)]},
                "suggested_severity": {"type": "string", "description": "Engine-suggested severity KEY. Only meaningful if the organisation's severity scale contains it."},
                "suggested_classification": {"enum": E["DEFECT_CLASS"]},
                "hint_html": {"type": "string"},
                "matched_text": {"type": "string", "description": "The words in the title that triggered the rule (Q-5)."},
            },
        },
        "doc": "runDefectAI() - 8 keyword rules over the defect title (first match wins). In the standard form it also overwrites the severity and classification fields; in the agent path those are shown as SUGGESTIONS only.",
    }

    readiness = {
        "input": {
            "type": "object", "required": ["gates", "defects", "envPath", "environments"], "additionalProperties": False,
            "properties": {
                "gates": {"type": "array", "minItems": 1, "items": {
                    "type": "object", "required": ["id", "status", "signedBy"], "additionalProperties": False,
                    "properties": {"id": {"enum": E["GATE_ID"]}, "status": {"enum": E["GATE_STATUS"]}, "signedBy": {"type": "string"}}}},
                "defects": {"type": "array", "items": {
                    "type": "object", "required": ["releaseId", "classification"], "additionalProperties": False,
                    "properties": {"releaseId": str_nonempty, "classification": {"enum": E["DEFECT_CLASS"]},
                                   "status": {"enum": E["DEFECT_STATUS"], "description": "Lifecycle status (R-1). Absent means Open. A blocker counts only while unresolved: Open / Fix identified / Fix in progress / Blocked / Fixed - awaiting verification / Reopened, or Resolved without a named confirmer, or closed without a named decision-maker and reason."},
                                   "decisionRecorded": {"type": "boolean", "description": "True only if a named decision-maker AND a reason are recorded (needed for Deferred, Accepted, Won't fix, Duplicate, Cannot reproduce, Not a defect to stop a blocker counting)."},
                                   "confirmationRecorded": {"type": "boolean", "description": "True only if a named confirmer is recorded (needed for Resolved & confirmed to stop a blocker counting)."}}},
                    "description": "Defects for THIS release. A defect counts as an open blocker per the tool's isUnresolvedBlocker(): classification === 'blocker' AND not (resolved with a named confirmer, or closed with a named decision-maker and reason)."},
                "envPath": {"type": "array", "minItems": 1, "uniqueItems": True, "items": {"enum": E["ENV"]}},
                "environments": {"type": "array", "items": {
                    "type": "object", "required": ["env", "health"], "additionalProperties": False,
                    "properties": {"env": {"enum": E["ENV"]}, "health": {"enum": E["ENV_HEALTH"]}}}},
            },
        },
        "output": {
            "type": "object", "required": ["score", "gates", "defects", "envs", "signoffs"], "additionalProperties": False,
            "properties": {k: {"type": "integer", "minimum": 0, "maximum": 100} for k in ["score", "gates", "defects", "envs", "signoffs"]},
        },
        "doc": "calculateReadiness() - score = gates*0.40 + defects*0.30 + envs*0.20 + signoffs*0.10 (rounded). No Go/No-Go threshold exists; colour bands (75/50) are display only.",
    }

    gate_hint = {
        "input": {
            "type": "object", "required": ["gateId", "entryConfirmed", "exitConfirmed", "blockerCount", "preProdVersion", "prodVersion", "deliveryModels"],
            "additionalProperties": False,
            "properties": {
                "gateId": {"enum": E["GATE_ID"]},
                "entryConfirmed": count, "exitConfirmed": count, "blockerCount": count,
                "preProdVersion": {"type": "string"}, "prodVersion": {"type": "string"},
                "deliveryModels": {"type": "array", "uniqueItems": True, "items": {"enum": E["DELIVERY_MODEL"]}},
            },
        },
        "output": {
            "type": "object", "required": ["hints"], "additionalProperties": False,
            "properties": {"hints": {"type": "array", "items": {
                "type": "object", "required": ["kind", "text_html"], "additionalProperties": False,
                "properties": {"kind": {"enum": ["blockers_open", "entry_unconfirmed", "exit_unconfirmed", "version_mismatch", "mobile_store_approval"]},
                               "text_html": {"type": "string"}}}}},
        },
        "completeness": True,
        "doc": "getGateReadinessHint() - up to 5 conditional hints per gate.",
    }

    risk_score = {
        "input": {
            "type": "object", "required": ["likelihood", "impact"], "additionalProperties": False,
            "properties": {"likelihood": {"type": "integer", "minimum": 1, "maximum": 5}, "impact": {"type": "integer", "minimum": 1, "maximum": 5}},
        },
        "output": {
            "type": "object", "required": ["score", "band"], "additionalProperties": False,
            "properties": {"score": {"type": "integer", "minimum": 1, "maximum": 25}, "band": {"enum": ["high", "medium", "low"]}},
        },
        "doc": "Risk score = likelihood x impact. High >= 15, medium >= 8, otherwise low. Open risks scoring >= 15 are counted in Go/No-Go wizard step 4.",
    }

    decision_record = {
        "input": {
            "type": "object", "required": ["decision", "decidedBy", "rationale", "riskNotes"], "additionalProperties": False,
            "properties": {"decision": {"enum": ["go", "nogo"]}, "decidedBy": str_nonempty,
                           "rationale": {"type": "string"}, "riskNotes": {"type": "string"}},
        },
        "output": {
            "type": "object", "required": ["recorded"], "additionalProperties": False,
            "properties": {"recorded": {"const": True}, "decision": {"enum": ["go", "nogo"]}},
        },
        "doc": "recordGNGDecision() - RECORDS a human GO / NO-GO. It computes nothing. The agent layer may never supply or imply 'decision' (Constraints doc Sections 2-3, 8).",
    }

    return {
        "release_hint": release_hint, "defect_hint": defect_hint, "readiness": readiness,
        "gate_hint": gate_hint, "risk_score": risk_score, "decision_record": decision_record,
    }


# ----------------------------------------------------------------------------- unresolved-input policy
def B(reason_code, why, status="cannot_be_determined", agent_writable="yes", on_invalid="reject", invalid_reason_code=None):
    """Hard block. on_invalid: what to do when a RESOLVED value fails the engine-input schema:
         'reject'           -> malformed input, hard-rejected (default)
         'block_as_missing' -> treated exactly like unresolved (e.g. an empty gate list)
         'not_assessed'     -> engine would silently show nothing, so say 'not assessed' instead"""
    d = {"on_unresolved": "block", "reason_code": reason_code, "block_status": status,
         "agent_writable": agent_writable, "on_invalid": on_invalid, "rationale": why}
    if invalid_reason_code:
        d["invalid_reason_code"] = invalid_reason_code
    return d


def F(value, caveat, why, agent_writable="yes", on_invalid="reject"):
    return {"on_unresolved": "fallback", "fallback_value": value, "caveat_code": caveat,
            "agent_writable": agent_writable, "on_invalid": on_invalid, "rationale": why}


def policy():
    P = {}
    P["release_hint"] = {
        "name": B("release_name_missing", "Without a name there is nothing to scan; 'no hint' would read as 'checked and clear'.", status="not_assessed"),
        "notes": F("", "assessed_on_name_only", "Standard form treats blank notes as '' and scans name only. Allowed ONLY with a mandatory caveat so the user knows notes were not scanned."),
        "deliveryModels": F([], "delivery_models_not_considered", "Blank selection is the form default, but the >=4 delivery-model complexity check would be silently skipped - caveat is mandatory."),
    }
    P["defect_hint"] = {
        "title": B("defect_title_missing", "Engine shows nothing without a title; that must not read as 'no issue found'.", status="not_assessed", on_invalid="not_assessed", invalid_reason_code="title_too_short"),
    }
    P["readiness"] = {
        "gates[].id": B("gate_identity_missing", "Cannot place a gate in the gate set."),
        "gates[].status": F("not-started", "gate_status_treated_as_not_started", "Conservative: only passed/waived add to the score, and 'not-started' is the form default at gate creation."),
        "gates[].signedBy": F("", "signoff_treated_as_missing", "Conservative: a blank sign-off lowers the sign-off component, matching the form default."),
        "gates": B("gates_missing", "With zero gates the old engine returned 50/100 (an artefact). Since Q-7 (2026-10-10) the tool itself reports 'not assessed'; the agent path refuses to produce a score as well.", on_invalid="block_as_missing"),
        "defects": B("defect_list_unknown", "If the defect list is unknown the 30% defect component cannot be computed; defaulting to 'no defects' would score a possibly-blocked release as clear."),
        "defects[].releaseId": B("defect_release_unknown", "A defect that cannot be attributed to a release cannot be included or excluded safely."),
        "defects[].classification": B("defect_classification_unknown", "NOT conservative to default: an unresolved defect defaulted to non-blocker could hide a release blocker (30% of the score). Hard block."),
        "defects[].status": F("open", "defect_status_treated_as_open", "Conservative: Open is counted as unresolved, which is also what the tool does for a defect with no status."),
        "defects[].decisionRecorded": F(False, "decision_treated_as_unrecorded", "Conservative: a blocker closed without a KNOWN named decision-maker and reason still counts as open."),
        "defects[].confirmationRecorded": F(False, "confirmation_treated_as_unrecorded", "Conservative: a blocker marked resolved without a KNOWN named confirmer still counts as open."),
        "envPath": B("env_path_missing", "With an empty path the old engine divided by zero and returned NaN. Since Q-8 (2026-10-10) the tool itself reports 'not assessed'; the agent path refuses to produce a score as well.", on_invalid="block_as_missing"),
        "environments": F([], "environments_treated_as_unknown", "Conservative: an environment with no health reading scores exactly like 'unknown' (not healthy)."),
        "environments[].env": B("environment_identity_missing", "Cannot place a health reading in the path."),
        "environments[].health": F("unknown", "env_health_treated_as_unknown", "Conservative: 'unknown' is the form default and scores as not healthy, exactly like warning/blocked."),
    }
    P["gate_hint"] = {
        "gateId": B("gate_identity_missing", "Hints depend on which gate this is."),
        "entryConfirmed": F(0, "entry_criteria_treated_as_unconfirmed", "Conservative: the hint then says criteria are not yet confirmed, which prompts the user to check."),
        "exitConfirmed": F(0, "exit_criteria_treated_as_unconfirmed", "Conservative, as above."),
        "blockerCount": B("blocker_count_unknown", "The Go/No-Go blocker hint depends on it, and a defaulted 0 would suppress a warning."),
        "preProdVersion": F("", "version_mismatch_check_skipped", "Hint is skipped (not asserted either way); caveat tells the user the comparison was not made."),
        "prodVersion": F("", "version_mismatch_check_skipped", "As above."),
        "deliveryModels": F([], "mobile_check_skipped", "Mobile store-approval hint skipped; caveat required."),
    }
    P["risk_score"] = {
        "likelihood": B("risk_likelihood_unknown", "No neutral value exists; any default would invent a score."),
        "impact": B("risk_impact_unknown", "No neutral value exists; any default would invent a score."),
    }
    P["decision_record"] = {
        "decision": B("decision_not_made", "The GO / NO-GO is a human decision. The agent can never supply it, only present the evidence.", agent_writable="no"),
        "decidedBy": B("decider_missing", "A recorded decision without an accountable person is not valid."),
        "rationale": F("", "no_rationale_given", "Optional narrative; blank is allowed by the standard form."),
        "riskNotes": F("", "no_risk_notes_given", "Optional narrative; blank is allowed by the standard form."),
    }
    return P


def engine_rules():
    """Engine-level sufficiency rules (none needed for RM: release name is a hard-block field)."""
    return {}


# ----------------------------------------------------------------------------- fixtures (conformance cases)
def R(v, prov="user_confirmed"):
    return {"state": "resolved", "value": v, "provenance": prov}


def U(reason="declined"):
    return {"state": "unresolved", "reason": reason}


def cases():
    gate_ok = lambda i, st="passed", s="Alex": {"id": R(i), "status": R(st), "signedBy": R(s)}
    return [
        {"id": "readiness-all-resolved", "engine": "readiness",
         "draft": {"gates": [gate_ok("dev-complete"), gate_ok("gng", "pending", "")],
                   "defects": [{"releaseId": R("REL-1"), "classification": R("blocker"), "status": R("open"), "decisionRecorded": R(False), "confirmationRecorded": R(False)}],
                   "envPath": R(["DEV", "PROD"]),
                   "environments": [{"env": R("DEV"), "health": R("healthy")}, {"env": R("PROD"), "health": R("unknown")}]},
         "expect": {"status": "ready", "caveats": []}},
        {"id": "readiness-unresolved-conservative-fields", "engine": "readiness",
         "draft": {"gates": [{"id": R("dev-complete"), "status": U("unknown_to_user"), "signedBy": U("not_yet_asked")}],
                   "defects": [], "envPath": R(["DEV"]),
                   "environments": [{"env": R("DEV"), "health": U("declined")}]},
         "expect": {"status": "ready",
                    "caveats": [{"code": "gate_status_treated_as_not_started", "field": "gates[0].status"},
                                {"code": "signoff_treated_as_missing", "field": "gates[0].signedBy"},
                                {"code": "env_health_treated_as_unknown", "field": "environments[0].health"}],
                    "engine_input_contains": {"gates[0].status": "not-started", "environments[0].health": "unknown"}}},
        {"id": "readiness-unresolved-defect-classification-blocks", "engine": "readiness",
         "draft": {"gates": [gate_ok("dev-complete")],
                   "defects": [{"releaseId": R("REL-1"), "classification": U("unknown_to_user"), "status": R("open"), "decisionRecorded": R(False), "confirmationRecorded": R(False)}],
                   "envPath": R(["DEV"]), "environments": [{"env": R("DEV"), "health": R("healthy")}]},
         "expect": {"status": "cannot_be_determined", "missing": [{"field": "defects[0].classification", "reason_code": "defect_classification_unknown"}]}},
        {"id": "readiness-no-gates-blocks", "engine": "readiness",
         "draft": {"gates": U("not_yet_asked"), "defects": [], "envPath": R(["DEV"]), "environments": []},
         "expect": {"status": "cannot_be_determined", "missing": [{"field": "gates", "reason_code": "gates_missing"}]}},
        {"id": "readiness-empty-env-path-blocks", "engine": "readiness",
         "draft": {"gates": [gate_ok("dev-complete")], "defects": [], "envPath": U("declined"), "environments": []},
         "expect": {"status": "cannot_be_determined", "missing": [{"field": "envPath", "reason_code": "env_path_missing"}]}},
        {"id": "readiness-model-inferred-provenance-rejected", "engine": "readiness",
         "draft": {"gates": [{"id": R("dev-complete"), "status": R("passed", "model_inferred"), "signedBy": R("Alex")}],
                   "defects": [], "envPath": R(["DEV"]), "environments": []},
         "expect": {"status": "rejected"}},
        {"id": "readiness-field-absent-rejected", "engine": "readiness",
         "draft": {"gates": [{"id": R("dev-complete"), "status": R("passed")}], "defects": [], "envPath": R(["DEV"]), "environments": []},
         "expect": {"status": "rejected"}},
        {"id": "release-hint-notes-unresolved-caveat", "engine": "release_hint",
         "draft": {"name": R("Payment gateway upgrade"), "notes": U("declined"), "deliveryModels": R([])},
         "expect": {"status": "ready", "caveats": [{"code": "assessed_on_name_only", "field": "notes"}]}},
        {"id": "release-hint-name-unresolved-not-assessed", "engine": "release_hint",
         "draft": {"name": U("not_yet_asked"), "notes": R("Stripe webhook listener update"), "deliveryModels": R([])},
         "expect": {"status": "not_assessed", "missing": [{"field": "name", "reason_code": "release_name_missing"}]}},
        {"id": "release-hint-unknown-delivery-model-rejected", "engine": "release_hint",
         "draft": {"name": R("x"), "notes": R(""), "deliveryModels": R(["quantum"])},
         "expect": {"status": "rejected"}},
        {"id": "defect-hint-short-title-not-assessed", "engine": "defect_hint",
         "draft": {"title": R("crash!!")},
         "expect": {"status": "not_assessed", "missing": [{"field": "title", "reason_code": "title_too_short"}]}},
        {"id": "defect-hint-title-unresolved-not-assessed", "engine": "defect_hint",
         "draft": {"title": U("not_yet_asked")},
         "expect": {"status": "not_assessed", "missing": [{"field": "title", "reason_code": "defect_title_missing"}]}},
        {"id": "gate-hint-blocker-count-unresolved-blocks", "engine": "gate_hint",
         "draft": {"gateId": R("gng"), "entryConfirmed": R(2), "exitConfirmed": R(1), "blockerCount": U("unknown_to_user"),
                   "preProdVersion": R("2.0.0"), "prodVersion": R("1.9.0"), "deliveryModels": R([])},
         "expect": {"status": "cannot_be_determined", "missing": [{"field": "blockerCount", "reason_code": "blocker_count_unknown"}]}},
        {"id": "gate-hint-versions-unresolved-caveats", "engine": "gate_hint",
         "draft": {"gateId": R("deploy"), "entryConfirmed": R(4), "exitConfirmed": R(5), "blockerCount": R(0),
                   "preProdVersion": U("unknown_to_user"), "prodVersion": U("unknown_to_user"), "deliveryModels": R(["mobile"])},
         "expect": {"status": "ready", "caveats": [{"code": "version_mismatch_check_skipped", "field": "preProdVersion"},
                                                   {"code": "version_mismatch_check_skipped", "field": "prodVersion"}]}},
        {"id": "risk-score-likelihood-unresolved-blocks", "engine": "risk_score",
         "draft": {"likelihood": U("unknown_to_user"), "impact": R(4)},
         "expect": {"status": "cannot_be_determined", "missing": [{"field": "likelihood", "reason_code": "risk_likelihood_unknown"}]}},
        {"id": "risk-score-out-of-range-rejected", "engine": "risk_score",
         "draft": {"likelihood": R(6), "impact": R(4)}, "expect": {"status": "rejected"}},
        {"id": "decision-record-decision-unresolved-blocks", "engine": "decision_record",
         "draft": {"decision": U("not_yet_asked"), "decidedBy": R("A. Manager"), "rationale": R(""), "riskNotes": R("")},
         "expect": {"status": "cannot_be_determined", "missing": [{"field": "decision", "reason_code": "decision_not_made"}]}},
        {"id": "decision-record-agent-supplied-decision-rejected", "engine": "decision_record",
         "agent_supplied": ["decision"],
         "draft": {"decision": R("go", "form"), "decidedBy": R("A. Manager"), "rationale": R(""), "riskNotes": R("")},
         "expect": {"status": "rejected", "reason": "agent_may_not_write:decision"}},
    ]


# ----------------------------------------------------------------------------- main
def relaxed_paths(pol_engine):
    """Leaf paths where the policy (not the draft schema) decides what 'too little' means."""
    return frozenset(p for p, e in pol_engine.items() if e.get("on_invalid") in ("block_as_missing", "not_assessed"))


def generate():
    """Return {filename: object} - used by main() and by check_schemas.py for drift detection."""
    html = read_source()
    E = build_enums(html)
    eng = engines(E)
    pol = policy()
    pol_engine_rules = engine_rules()

    inputs = {"$schema": SCHEMA_DIALECT, "$id": f"urn:zeus17:{TOOL}:engine-inputs:v1",
              "title": "RM engine inputs (strictly typed; no unresolved state)",
              "x-enums-source": "../rm-tool-v1.html (regenerated by build_schemas.py; verified by check_schemas.py)",
              "$defs": {k: v["input"] for k, v in eng.items()}}
    drafts = {"$schema": SCHEMA_DIALECT, "$id": f"urn:zeus17:{TOOL}:agent-drafts:v1",
              "title": "RM agent drafts (every leaf explicitly resolved or unresolved)",
              "$defs": {**COMMON_DEFS, **{k: to_agent_draft(v["input"], relaxed_paths(pol[k])) for k, v in eng.items()}}}
    outputs = {"$schema": SCHEMA_DIALECT, "$id": f"urn:zeus17:{TOOL}:engine-outputs:v1",
               "title": "RM engine results (computed | cannot_be_determined | not_assessed)",
               "$defs": {**COMMON_DEFS, **{k: result_schema(v["output"], k, v.get("completeness", False)) for k, v in eng.items()}}}
    policy_doc = {"$id": f"urn:zeus17:{TOOL}:unresolved-policy:v1",
                  "description": "For every leaf input of every engine: what happens when the input arrives as 'unresolved'. 'block' = no verdict can be produced (UI shows the distinct 'cannot be determined' state). 'fallback' = a named, conservative value is substituted AND a caveat is attached to the result. Model-inferred values are never an allowed provenance.",
                  "engines": {k: {"doc": eng[k]["doc"], **({"_engine": pol_engine_rules[k]} if k in pol_engine_rules else {}), "inputs": pol[k]} for k in eng}}

    return {
        "engine-inputs.schema.json": inputs,
        "agent-drafts.schema.json": drafts,
        "engine-outputs.schema.json": outputs,
        "unresolved-policy.json": policy_doc,
        os.path.join("fixtures", "policy-cases.json"): {"cases": cases(), "enums": E},
    }


def main():
    os.makedirs(os.path.join(HERE, "fixtures"), exist_ok=True)
    out = generate()
    for name, obj in out.items():
        dump(os.path.join(HERE, name), obj)
    with open(os.path.join(HERE, "POLICY.md"), "w", encoding="utf-8", newline=chr(10)) as f:
        f.write(policy_markdown(out["unresolved-policy.json"], "Release Management tool") + chr(10))
    with open(os.path.join(HERE, "COMMON.sha256"), "w", encoding="utf-8", newline="\n") as f:
        for mod in ("_common.py", "_check_lib.py"):
            f.write(sha256_file(os.path.join(HERE, mod)) + "  " + mod + "\n")
    print("wrote", len(out), "files; engines:", ", ".join(out["engine-inputs.schema.json"]["$defs"]))


if __name__ == "__main__":
    main()
