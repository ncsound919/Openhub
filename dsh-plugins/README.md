# OpenHub dsh plugins

First-party DeepSeek Harness bundles for the Overlay365 fleet. Each
subdirectory is a standalone npm package (own `package.json`, not part of
OpenHub's install — `npm ci` in `openhub/` ignores these).

## Bundles

- `openhub-fleet/` — `@overlay365/dsh-fleet`: read-only fleet observability
  (`fleet.status`, `fleet.service`, `telemetry.summary`, `voice.status`).
  Strategy for the rest of the ecosystem: `PLUGIN-MAP.md`.

## Try it against a local checkout

From the reference harness tree (or any installed `dsh >=0.2.2-alpha.3`):

```sh
# overlay that loads the bundle straight from this directory
cat > /tmp/openhub-fleet.patch.yml <<'EOF'
- insert:
    - id: overlay-fleet
      name: '/absolute/path/to/openhub/dsh-plugins/openhub-fleet/index.js'
EOF
dsh web --patch /tmp/openhub-fleet.patch.yml
```

The bundle needs no install for the smoke path above; `dsh plugin add`
packaging (npm + `dsh.bundle` manifest) is already declared in its
`package.json` for the indexed-distribution step in `PLUGIN-MAP.md`.

## Smoke test (no dsh runtime needed)

```sh
cd openhub
node --experimental-vm-modules scripts/smoke-dsh-fleet.mjs
```

It applies the bundle against a fake `ctx`, emulates conditional
registration, and asserts the four tool schemas — without touching the
network.
