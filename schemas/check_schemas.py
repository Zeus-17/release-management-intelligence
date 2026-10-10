#!/usr/bin/env python3
"""
RM schema package gate (Build Brief Step 2).  Exit code 0 only if every check passes.
Generic checks live in _check_lib.py (shared, hash-locked); this file adds the RM-specific output-fit check.

    python schemas/build_schemas.py     # regenerate from rm-tool-v1.html
    python schemas/check_schemas.py     # verify
"""
import json
import os
import sys

from jsonschema import Draft202012Validator

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_schemas as B  # noqa: E402
from _check_lib import run_checks  # noqa: E402


def check_outputs(outputs, check):
    """Real engine outputs recorded in tests/rm-baseline.json must fit the output schemas."""
    base_path = os.path.join(HERE, "..", "tests", "rm-baseline.json")
    if not check(os.path.exists(base_path), "tests/rm-baseline.json not found"):
        return
    base = json.load(open(base_path, encoding="utf-8"))

    def v(engine):
        return Draft202012Validator({"$schema": outputs["$schema"], "$defs": outputs["$defs"], "$ref": f"#/$defs/{engine}"})

    n = 0
    for fid, r in base["readiness"].items():
        res = {"engine": "readiness", "status": "computed", "output": r, "caveats": []}
        valid = v("readiness").is_valid(res)
        if fid == "ready-S11-emptyenvs":
            check(not valid, "NaN readiness artefact (empty envPath) must NOT validate as a computed result")
        else:
            check(valid, f"readiness output {fid} does not fit the output schema")
            n += 1
    for fid, r in base["release"].items():
        out = {"matched": bool(r["shown"]), "complete": True}
        if r["shown"]:
            out["hint_html"] = r["html"]
            out["level"] = "danger" if "danger" in r["cls"] else "warn" if "warn" in r["cls"] else "info"
            out["rule"] = "dm_complexity" if "High-complexity" in r["html"] else "release_rule_0"  # rule index is assigned by the adapter
        check(v("release_hint").is_valid({"engine": "release_hint", "status": "computed", "output": out, "caveats": []}), f"release output {fid} does not fit")
        n += 1
    for fid, r in base["defect"].items():
        out = {"matched": bool(r["shown"])}
        if r["shown"]:
            out.update({"hint_html": r["html"], "suggested_severity": r["sevAfter"], "suggested_classification": r["classAfter"], "rule": "defect_rule_0"})
        check(v("defect_hint").is_valid({"engine": "defect_hint", "status": "computed", "output": out, "caveats": []}), f"defect output {fid} does not fit")
        n += 1
    # tri-state discipline
    bad = {"engine": "readiness", "status": "cannot_be_determined", "output": {"score": 0, "gates": 0, "defects": 0, "envs": 0, "signoffs": 0}}
    check(not v("readiness").is_valid(bad), "a cannot_be_determined result must not be able to carry a score")
    # completeness discipline: a caveated 'nothing found' must not claim to be complete
    caveated_clear = {"engine": "release_hint", "status": "computed", "output": {"matched": False, "complete": True},
                      "caveats": [{"code": "assessed_on_name_only", "field": "notes"}]}
    check(not v("release_hint").is_valid(caveated_clear), "a caveated 'no match' must not be allowed to claim complete=true")
    caveated_ok = dict(caveated_clear, output={"matched": False, "complete": False})
    check(v("release_hint").is_valid(caveated_ok), "a caveated 'no match' with complete=false must be valid")
    print(f"   {n} recorded outputs validated")


if __name__ == "__main__":
    sys.exit(run_checks(HERE, B, "rm", check_outputs))
