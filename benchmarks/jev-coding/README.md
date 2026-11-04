# JEV coding benchmark — OpenHub's inference engine vs DeepSeek

A reproducible head-to-head on OpenHub's **coding-decision surface**: review
verdicts, repair triage, audit verdicts, and workspace safety. Every case is
extracted from a real artifact in this workspace; every label comes from a pure
function in [`labeler.ts`](./labeler.ts), never from a contender.

## Quick start

```bash
cd openhub

# 0. Serve the Hugging Face JEV model (once; CPU-friendly 0.8B)
#    Windows helper: powershell -ExecutionPolicy Bypass -File benchmarks/jev-coding/serve-jev.ps1
pip install "jev-style[torch]"
jev-style serve --release 0.8b-v3 --backend torch --device cpu --port 8790

# 1. Regenerate the case set from the repo's real artifacts
npx tsx benchmarks/jev-coding/build-cases.ts

# 2. Run both engines (needs DEEPSEEK_API_KEY in .env)
npx tsx benchmarks/jev-coding/run.ts

# 3. Optional: have DeepSeek Pro adjudicate disagreements
npx tsx benchmarks/jev-coding/run.ts --judge

# Subsets for a cheap smoke test
npx tsx benchmarks/jev-coding/run.ts --families=workspace --limit=5
```

Outputs: [`report.json`](./report.json) (machine-readable) and
[`REPORT.md`](./REPORT.md) (human-readable).

## Pipeline

```
cases.json ──► reviewAdvisory/repairAdvisory/auditAdvisory/workspaceAdvisory
                     │
                     ├──► HF JEV     (decideSystemOne → 127.0.0.1:8790)
                     └──► DeepSeek   (api.deepseek.com, temp 0, effort=low)
                                   │
                     labeler.ts ──► score key-by-key ──► REPORT.md/json
```

Both engines receive the **same** `state` and `questions` object. The JEV engine
is the one OpenHub actually calls (`decideSystemOne` → `JEV_LOCAL_BASE_URL`), so
its latency and answer shape are the production path, not a reimplementation.

## Which HF JEV model?

The five most-downloaded JEV repositories on Hugging Face (2026-10-31) are all
9B–35B and need a datacenter GPU:

| # | Model | Downloads | Params |
|---|---|---:|---|
| 1 | `autotrust/JEV-27B-VL` | 2,833,604 | 27B |
| 2 | `autotrust/JEV-35B` | 1,583,113 | 35B (MoE) |
| 3 | `autotrust/JEV-9B` | 883,650 | 9B |
| 4 | `autotrust/JEV-27B` | 596,318 | 27B |
| 5 | `autotrust/JEV-35B-NVFP4` | 371,900 | 35B (FP4) |

This laptop is a 4-core CPU with 16 GB RAM and no GPU, so the benchmark uses the
most-downloaded JEV that actually runs here:
**`chaoliangUNSW/Jev-Style-0.8B-Decision-v3`** (Q4_K_M 0.53 GB / torch ~1.5 GB,
0.8B params, systemone-compatible API). Swap `--release` / `JEV_LOCAL_MODEL` to
benchmark a larger model on a machine that can hold it.

## Case sources

| Family | Real source | What the question asks |
|---|---|---|
| `review` | Real commits + diffs from `git log`, up to 24 commits | verdict / merge-safe / regression risk |
| `repair` | `audit-reports/*/report.json` findings, `audit-reports/openhub/web_findings.json`, and the documented CRITICALs in `AUDIT-UPGRADE.md` | repair lane / urgency |
| `audit` | Before/after severity counts in `audit-reports/*/report.json` | finding severity / next action |
| `workspace` | Real paths in the working tree (`.env`, `.git/config`, `node_modules`, source, docs, out-of-root probes) | allow / blast radius |

## Label policies

The exact rules live in `labeler.ts`. Summary:

- **workspace** — out-of-root paths, secret/credential files (even reads), and
  mutations under `.git`/`node_modules` are risky. Otherwise risk = blast radius:
  read 0, docs write 1, config/source write 2, delete/execute 3.
- **repair** — CRITICAL or security-flavoured → `hold`; HIGH non-security →
  `dispatch`; mechanical/autofixable LOW/MEDIUM → `autofix`; else `dispatch`.
- **audit** — no failed facts → `accept`; security-flavoured failures → `flag`
  (`reject` only when explicitly blocking); otherwise severity from the failure
  ratio, with `autofix` for minor and `flag` for moderate/major.
- **review** — a committed secret → `block`; a risky construct, security-flavoured
  file, 1000+ line change, or a non-trivial source change with no test change →
  `request_changes`; else `approve`.

## Scoring

- `choice` — exact criteria key (case-insensitive).
- `noul` — boolean at the 0.5 threshold.
- `score` — exact integer index.
- **Key accuracy** = correct keys / total keys. **Exact** = every key in a case
  correct. Both are reported overall and by family.
- **Cost** uses the USD/1M-token rates already in
  `src/services/costTracker.ts`; it is not a live pricing feed.

## Why the numbers are only as good as the labels

The labels are policy-derived, not human-adjudicated. That is a deliberate
trade: it makes the benchmark reproducible and free, but a reader who disagrees
with a rule should change the rule, not the engine. The review class balance is
also skewed toward `approve` (this history is mostly healthy), so per-class
behaviour matters more than raw accuracy. Use `--judge` for an independent
quality read on disagreements.
