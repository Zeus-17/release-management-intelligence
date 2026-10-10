# Release Management tool - what happens when an input is unresolved

*Generated from `unresolved-policy.json` by `build_schemas.py`. Do not edit by hand.*

For every leaf input of every engine: what happens when the input arrives as 'unresolved'. 'block' = no verdict can be produced (UI shows the distinct 'cannot be determined' state). 'fallback' = a named, conservative value is substituted AND a caveat is attached to the result. Model-inferred values are never an allowed provenance.

**Block** = no verdict can be produced; the UI shows the distinct 'cannot be determined' state (or 'not assessed' where the engine would otherwise show nothing).  
**Fallback** = a named, conservative value is used AND a caveat travels with the result.  
**Agent may write: no** = only an explicit human action may set the value; the agent can show evidence but never supply it.

## `release_hint`

runReleaseAI() - 9 keyword rules (first match wins) preceded by the >=4 delivery-model complexity check.

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `name` | **Block** (`release_name_missing`) | not assessed | yes | Without a name there is nothing to scan; 'no hint' would read as 'checked and clear'. |
| `notes` | Fallback `""` | computed + caveat `assessed_on_name_only` | yes | Standard form treats blank notes as '' and scans name only. Allowed ONLY with a mandatory caveat so the user knows notes were not scanned. |
| `deliveryModels` | Fallback `[]` | computed + caveat `delivery_models_not_considered` | yes | Blank selection is the form default, but the >=4 delivery-model complexity check would be silently skipped - caveat is mandatory. |

## `defect_hint`

runDefectAI() - 8 keyword rules over the defect title (first match wins). In the standard form it also overwrites the severity and classification fields; in the agent path those are shown as SUGGESTIONS only.

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `title` | **Block** (`defect_title_missing`) | not assessed | yes | Engine shows nothing without a title; that must not read as 'no issue found'. |

## `readiness`

calculateReadiness() - score = gates*0.40 + defects*0.30 + envs*0.20 + signoffs*0.10 (rounded). No Go/No-Go threshold exists; colour bands (75/50) are display only.

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `gates[].id` | **Block** (`gate_identity_missing`) | cannot be determined | yes | Cannot place a gate in the gate set. |
| `gates[].status` | Fallback `"not-started"` | computed + caveat `gate_status_treated_as_not_started` | yes | Conservative: only passed/waived add to the score, and 'not-started' is the form default at gate creation. |
| `gates[].signedBy` | Fallback `""` | computed + caveat `signoff_treated_as_missing` | yes | Conservative: a blank sign-off lowers the sign-off component, matching the form default. |
| `gates` | **Block** (`gates_missing`) | cannot be determined | yes | With zero gates the old engine returned 50/100 (an artefact). Since Q-7 (2026-10-10) the tool itself reports 'not assessed'; the agent path refuses to produce a score as well. |
| `defects` | **Block** (`defect_list_unknown`) | cannot be determined | yes | If the defect list is unknown the 30% defect component cannot be computed; defaulting to 'no defects' would score a possibly-blocked release as clear. |
| `defects[].releaseId` | **Block** (`defect_release_unknown`) | cannot be determined | yes | A defect that cannot be attributed to a release cannot be included or excluded safely. |
| `defects[].classification` | **Block** (`defect_classification_unknown`) | cannot be determined | yes | NOT conservative to default: an unresolved defect defaulted to non-blocker could hide a release blocker (30% of the score). Hard block. |
| `defects[].status` | Fallback `"open"` | computed + caveat `defect_status_treated_as_open` | yes | Conservative: Open is counted as unresolved, which is also what the tool does for a defect with no status. |
| `defects[].decisionRecorded` | Fallback `false` | computed + caveat `decision_treated_as_unrecorded` | yes | Conservative: a blocker closed without a KNOWN named decision-maker and reason still counts as open. |
| `defects[].confirmationRecorded` | Fallback `false` | computed + caveat `confirmation_treated_as_unrecorded` | yes | Conservative: a blocker marked resolved without a KNOWN named confirmer still counts as open. |
| `envPath` | **Block** (`env_path_missing`) | cannot be determined | yes | With an empty path the old engine divided by zero and returned NaN. Since Q-8 (2026-10-10) the tool itself reports 'not assessed'; the agent path refuses to produce a score as well. |
| `environments` | Fallback `[]` | computed + caveat `environments_treated_as_unknown` | yes | Conservative: an environment with no health reading scores exactly like 'unknown' (not healthy). |
| `environments[].env` | **Block** (`environment_identity_missing`) | cannot be determined | yes | Cannot place a health reading in the path. |
| `environments[].health` | Fallback `"unknown"` | computed + caveat `env_health_treated_as_unknown` | yes | Conservative: 'unknown' is the form default and scores as not healthy, exactly like warning/blocked. |

## `gate_hint`

getGateReadinessHint() - up to 5 conditional hints per gate.

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `gateId` | **Block** (`gate_identity_missing`) | cannot be determined | yes | Hints depend on which gate this is. |
| `entryConfirmed` | Fallback `0` | computed + caveat `entry_criteria_treated_as_unconfirmed` | yes | Conservative: the hint then says criteria are not yet confirmed, which prompts the user to check. |
| `exitConfirmed` | Fallback `0` | computed + caveat `exit_criteria_treated_as_unconfirmed` | yes | Conservative, as above. |
| `blockerCount` | **Block** (`blocker_count_unknown`) | cannot be determined | yes | The Go/No-Go blocker hint depends on it, and a defaulted 0 would suppress a warning. |
| `preProdVersion` | Fallback `""` | computed + caveat `version_mismatch_check_skipped` | yes | Hint is skipped (not asserted either way); caveat tells the user the comparison was not made. |
| `prodVersion` | Fallback `""` | computed + caveat `version_mismatch_check_skipped` | yes | As above. |
| `deliveryModels` | Fallback `[]` | computed + caveat `mobile_check_skipped` | yes | Mobile store-approval hint skipped; caveat required. |

## `risk_score`

Risk score = likelihood x impact. High >= 15, medium >= 8, otherwise low. Open risks scoring >= 15 are counted in Go/No-Go wizard step 4.

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `likelihood` | **Block** (`risk_likelihood_unknown`) | cannot be determined | yes | No neutral value exists; any default would invent a score. |
| `impact` | **Block** (`risk_impact_unknown`) | cannot be determined | yes | No neutral value exists; any default would invent a score. |

## `decision_record`

recordGNGDecision() - RECORDS a human GO / NO-GO. It computes nothing. The agent layer may never supply or imply 'decision' (Constraints doc Sections 2-3, 8).

| Input | If unresolved | Result | Agent may write | Why |
|---|---|---|---|---|
| `decision` | **Block** (`decision_not_made`) | cannot be determined | no | The GO / NO-GO is a human decision. The agent can never supply it, only present the evidence. |
| `decidedBy` | **Block** (`decider_missing`) | cannot be determined | yes | A recorded decision without an accountable person is not valid. |
| `rationale` | Fallback `""` | computed + caveat `no_rationale_given` | yes | Optional narrative; blank is allowed by the standard form. |
| `riskNotes` | Fallback `""` | computed + caveat `no_risk_notes_given` | yes | Optional narrative; blank is allowed by the standard form. |

