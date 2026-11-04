# OpenHub coding decisions — JEV vs DeepSeek

Generated: **2026-10-31T22:51:31.091Z**

## What this measures

OpenHub's coding-decision surface (review / repair triage / audit verdict / workspace
safety) was replayed over **66 cases extracted from real artifacts** in this
workspace. Each case is answered by two engines over the *same* typed state and questions:

- **HF JEV** — OpenHub's `decideSystemOne` against
  `chaoliangUNSW/Jev-Style-0.8B-Decision-v3` served locally by `jev-style serve` on
  `127.0.0.1:8790`.
- **DeepSeek Flash** — `deepseek-flash` via `api.deepseek.com` (temperature 0, `effort=low`).

Ground truth is produced by deterministic policy functions in `labeler.ts`; neither
engine sees the label. This is a decision-agreement benchmark, not a code-generation test.

## Headline

| Engine | Case exact | Key accuracy | Mean latency | p50 | Tokens in / out | Cost |
|---|---:|---:|---:|---:|---:|---:|
| HF JEV (Jev-Style 0.8B) | 18.2% | 47.4% | 29.13s | 19.03s | 0 / 0 | $0.0000 |
| DeepSeek Flash | 57.6% | 78.2% | 2.10s | 1.92s | 24842 / 11718 | $0.0083 |

DeepSeek output tokens include 9484 reasoning tokens.
Cost uses the rates in `src/services/costTracker.ts` (not a live price feed).

## By family

| Family | Cases | JEV keys | DeepSeek keys | JEV exact | DeepSeek exact |
|---|---:|---:|---:|---:|---:|
| review | 24 | 43.1% | 80.6% | 20.8% | 54.2% |
| repair | 12 | 70.8% | 83.3% | 50.0% | 66.7% |
| audit | 10 | 50.0% | 90.0% | 0.0% | 80.0% |
| workspace | 20 | 40.0% | 65.0% | 5.0% | 45.0% |

## By question

| Question | JEV | DeepSeek |
|---|---:|---:|
| verdict | 33.3% (8/24) | 100.0% (24/24) |
| merge | 37.5% (9/24) | 83.3% (20/24) |
| risk | 36.4% (16/44) | 54.5% (24/44) |
| lane | 83.3% (10/12) | 66.7% (8/12) |
| urgent | 58.3% (7/12) | 100.0% (12/12) |
| severity | 0.0% (0/10) | 80.0% (8/10) |
| next | 100.0% (10/10) | 100.0% (10/10) |
| allow | 70.0% (14/20) | 80.0% (16/20) |

## Confusion (expected → predicted, J = JEV, D = DeepSeek)

| verdict (expected ↓ / predicted →) | request_changes | block | approve |
|---|---:|---:|---:|
| **request_changes** | J 1 / D 4 | J 1 / D 0 | J 2 / D 0 |
| **block** |  |  |  |
| **approve** | J 12 / D 0 | J 1 / D 0 | J 7 / D 20 |

| lane (expected ↓ / predicted →) | hold | dispatch | autofix |
|---|---:|---:|---:|
| **hold** | J 4 / D 0 | J 0 / D 4 |  |
| **dispatch** | J 1 / D 0 | J 0 / D 2 | J 1 / D 0 |
| **autofix** |  |  | J 6 / D 6 |

| next (expected ↓ / predicted →) | flag | accept |
|---|---:|---:|
| **flag** | J 3 / D 3 |  |
| **accept** |  | J 7 / D 7 |

## Class balance

0: 15 · 1: 19 · 2: 9 · 3: 11 · request_changes: 4 · true: 43 · approve: 20 · hold: 4 · dispatch: 2 · false: 13 · autofix: 6 · flag: 3 · accept: 7

## Per-class precision / recall (choice questions)

| Question | Class | JEV P/R | DeepSeek P/R |
|---|---|---:|---:|
| verdict | request_changes | 8% / 25% | 100% / 100% |
| verdict | approve | 78% / 35% | 100% / 100% |
| lane | hold | 80% / 100% | —% / 0% |
| lane | dispatch | —% / 0% | 33% / 100% |
| lane | autofix | 86% / 100% | 100% / 100% |
| next | flag | 100% / 100% | 100% / 100% |
| next | accept | 100% / 100% | 100% / 100% |

## Disagreements

54 of 66 cases differ on at least one answer.

| Case | Family | Policy | JEV | DeepSeek | Judge |
|---|---|---|---|---|---|
| `review/36a7da1` | review | verdict=request_changes, merge=true, risk=2 | approve, false, 1 | request_changes, false, 3 | deepseek |
| `repair/aetherdesk-mobile-SEC-004-27` | repair | lane=hold, urgent=true | hold, false | dispatch, true | deepseek |
| `repair/marketing-studio-CONC-004-42` | repair | lane=dispatch, urgent=false | autofix, false | dispatch, false | deepseek ✓ |
| `repair/openhub-web-insecure-http-//-331` | repair | lane=autofix, urgent=false | autofix, true | autofix, false | deepseek ✓ |
| `repair/openhub-web-insecure-http-//-31` | repair | lane=autofix, urgent=false | autofix, true | autofix, false | deepseek ✓ |
| `repair/audit-upgrade-C3` | repair | lane=dispatch, urgent=true | hold, false | dispatch, true | deepseek ✓ |
| `audit/aetherdesk-mobile` | audit | severity=3, next=flag | 1, flag | 3, flag | deepseek ✓ |
| `audit/agent-support-clean` | audit | severity=0, next=accept | 1, accept | 0, accept | deepseek ✓ |
| `audit/concordance-clean` | audit | severity=0, next=accept | 1, accept | 0, accept | deepseek ✓ |
| `audit/concordance-oss-clean` | audit | severity=0, next=accept | 1, accept | 0, accept | deepseek ✓ |
| `audit/nc-studio-clean` | audit | severity=0, next=accept | 1, accept | 0, accept | deepseek ✓ |
| `audit/phone-beat-clean` | audit | severity=0, next=accept | 1, accept | 0, accept | deepseek ✓ |
| `audit/recourse-clean` | audit | severity=0, next=accept | 1, accept | 0, accept | deepseek ✓ |
| `audit/sieve-clean` | audit | severity=0, next=accept | 1, accept | 0, accept | deepseek ✓ |
| `audit/openhub-web` | audit | severity=3, next=flag | 2, flag | 1, flag | jev |

### Judge (DeepSeek Pro, disagreements only)

- Calls: 20
- Preferred JEV: 1
- Preferred DeepSeek: 19
- Ties: 0
- Judge's own answers agree with the policy: 16/20 (80.0%)


## Method

1. `build-cases.ts` reads only real artifacts:
   - **review** — real commits + diffs from `openhub` git history.
   - **repair** — real findings in `audit-reports/*/report.json`, `audit-reports/openhub/web_findings.json`,
     and the CRITICAL items documented in `openhub/AUDIT-UPGRADE.md`.
   - **audit** — real before/after severity counts in `audit-reports/*/report.json`.
   - **workspace** — real paths from the working tree (`.env`, `.git/config`, `node_modules`, source,
     docs, and out-of-root probes).
2. `run.ts` sends each case through OpenHub's own advisory builders (`reviewAdvisory`,
   `repairAdvisory`, `auditAdvisory`, `workspaceAdvisory`) and then through both engines.
3. Answers are compared key-by-key with the policy labels; `noul` is compared at the 0.5
   threshold, `score` at the exact integer, `choice` at the exact criteria key.
4. The optional judge sees the state, questions and both answer sets — never the policy label —
   and returns its own answer plus a winner.

### Label policies (short form)

- **workspace** — out-of-root, secret/credential files (even for reads), and mutations under
  `.git`/`node_modules` are risky; otherwise risk = operation blast radius.
- **repair** — CRITICAL or security-flavoured → `hold`; HIGH non-security → `dispatch`;
  mechanical/autofixable LOW/MEDIUM → `autofix`; else `dispatch`.
- **audit** — no failed facts → `accept`; security findings → `flag` (or `reject` when
  explicitly blocking); else severity from the failure ratio and `autofix`/`flag`.
- **review** — committed secret → `block`; risky construct, security-flavoured file,
  1000+ line change, or an untested non-trivial source change → `request_changes`; else `approve`.

## Limitations

- Labels are policy-derived, not human-adjudicated. They encode a defensible but opinionated
  policy; read `labeler.ts` before treating a delta as an error.
- The review class balance is skewed toward `approve` because this history is mostly healthy.
  Per-class precision/recall matter more than raw accuracy here.
- The HF JEV engine runs 0.8B parameters on CPU here; its latency is hardware-specific.
- DeepSeek cost uses the repository's configured rates, not a live pricing API.

## Reproduce

```bash
cd openhub
npx tsx benchmarks/jev-coding/build-cases.ts
npx tsx benchmarks/jev-coding/run.ts --judge
```
