# Design QA in OpenHub

OpenHub registers **DesignPilot** as a fleet MCP server, so every Axiom loop started from the
console can validate a design instead of guessing at contrast, grid and token drift.

DesignPilot separates judgement from arithmetic: the model writes and critiques a `DesignSpec`,
the server validates it with pure code (no model calls) and exports the artifacts.

## Wiring

| | |
|---|---|
| Registry | `src/services/fleetMcp.ts` — id `designpilot` |
| Env var | `OPENHUB_MCP_DESIGNPILOT_DIR` → the `designpilot-mcp` checkout |
| Command | `python scripts/designpilot_mcp.py <checkout>` |
| Launcher | [`scripts/designpilot_mcp.py`](scripts/designpilot_mcp.py) puts the checkout's `src/` on `sys.path` |
| Requires | Python 3.10+ and a checkout — no `pip install`, no build step |

The launcher exists so the registration survives machines where the package was never installed.
If the checkout is missing, or the directory is not a DesignPilot checkout, the server is reported
`enabled: false` with the reason and the env var to set — `engineConfigOverlay` never advertises a
tool that cannot start.

```powershell
$env:OPENHUB_MCP_DESIGNPILOT_DIR = "C:/Users/tap45/Downloads/DP MCP/designpilot-mcp/designpilot"
```

Restart OpenHub after setting it; the engine config is composed at spawn.

## What the agent gets

21 tools, the ones that matter for web work:

- `list_standards('web')` — the enforced values (44px touch, 16px body, 4.5:1, 3 viewports).
- `check_contrast(fg, bg, size)` — WCAG AA for one pair, no spec needed.
- `validate_spec(spec)` — schema, token references, grid, type ratios, contrast, states, viewports,
  weighted score and checklist.
- `save_profile` / `save_version` / `diff_versions` — per-project standards, immutable versions.
- `submit_critique` / `attest` / `approve` / `export_all` — critique bound to a version hash, manual
  attestations, gates, and six exported artifacts (brief, dev spec, tokens, inventory, audit,
  checklist).

`design_task(role, platform, brief)` returns the role prompt when a client has no MCP prompts.

## Workflow for an ecosystem site

1. Write the spec from the site's real CSS tokens, not from memory. Flatten alpha colours onto
   their ground first; the schema only accepts `#RRGGBB`.
2. `validate_spec` → fix every blocker (contrast, missing states, dead token refs).
3. `save_version` → `submit_critique` → `attest` → `approve` → `export_all`.
4. Keep the exported `design-tokens.json` next to the CSS so the two can be diffed.

For a quick audit without a spec, sweep the stylesheet's text/ground pairs through
`check_contrast`. That is what has been done for `overlay-site` so far: six pairs, all AA
(17.15:1 body ink, 7.47:1 muted, 6.92:1 signal text and button label).

## Checks

```bash
npx vitest run tests/fleetMcp.test.ts   # registry: enabled/disabled/merge
npm run lint                            # tsc --noEmit
```

The registry tests create a temporary checkout, assert the launcher path is a real file in this
repo, and assert a directory that is not a DesignPilot checkout is refused with a reason rather
than advertised.
