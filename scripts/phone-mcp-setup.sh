#!/usr/bin/env bash
# phone-mcp-setup.sh — one-time setup of the fleet MCP servers on the phone.
#
# Run this INSIDE the proot Ubuntu (the same environment the opencode engine
# runs in), e.g.:
#   proot-distro login ubuntu -- bash
#   bash ~/openhub/scripts/phone-mcp-setup.sh
#
# It clones/builds the stdio MCP checkouts, pre-warms the npx packages the
# engine spawns (sequential-thinking, tsx) so the first mission does not pay
# for a download mid-session, and prints the .env lines for the phone's openhub.
#
# Not covered here (they are HTTP services, not opencode MCP servers):
#   - Middle-Man-MCP  (gateway; capability-registry bridge "middle-man" :8085)
#   - math-x          (compute API; bridge "math-x" :5000)
#   - BigBack-        (backend generator; deployed to the EC2 one-host stack)
set -euo pipefail

MCP_ROOT="${MCP_ROOT:-$HOME/mcp}"
OPENHUB_DIR="${OPENHUB_DIR:-$HOME/openhub}"
GITHUB_BASE="${GITHUB_BASE:-https://github.com/ncsound919}"

mkdir -p "$MCP_ROOT"
cd "$MCP_ROOT"

ensure_repo() {
  local name="$1"
  if [ -d "$name/.git" ]; then
    echo "==> $name: already cloned"
    return
  fi
  echo "==> $name: cloning"
  git clone --depth 1 "$GITHUB_BASE/$name" "$name"
}

build_if_needed() {
  local name="$1" marker="$2"
  if [ -e "$name/$marker" ]; then
    echo "==> $name: $marker present, skipping build"
    return
  fi
  echo "==> $name: npm install + build"
  (cd "$name" && npm install && npm run build)
}

warm_npx() {
  # npm exec resolves the package into the npx cache without running its
  # server entry (an MCP server run directly would block on stdin forever).
  local pkg="$1"
  echo "==> pre-warming $pkg"
  npm exec --yes --package="$pkg" -- node -e 'process.exit(0)' >/dev/null 2>&1 \
    || echo "    warm failed (offline?) — npx will fetch it on first engine use"
}

# Dev-Brain — the stdio MCP bridge (dev-brain-mcp.ts) runs under tsx: deps only.
ensure_repo Dev-Brain
if [ ! -d "Dev-Brain/node_modules" ]; then
  echo "==> Dev-Brain: npm install"
  (cd Dev-Brain && npm install)
fi

# Business-Logic-MCP — compiled server (37 tools).
ensure_repo Business-Logic-MCP
build_if_needed Business-Logic-MCP dist/index.js

# Packages the engine spawns via `npx -y ...`.
warm_npx '@modelcontextprotocol/server-sequential-thinking'
warm_npx 'tsx'

cat <<EOF

Done. Add these lines to $OPENHUB_DIR/.env, then restart OpenHub (the engine
picks the servers up on its next spawn):

  OPENHUB_MCP_SEQTHINK=1
  OPENHUB_MCP_DEVBRAIN_DIR=$MCP_ROOT/Dev-Brain
  OPENHUB_MCP_BUSINESS_LOGIC_DIR=$MCP_ROOT/Business-Logic-MCP
  OPENHUB_MCP_OG_GLASS_URL=https://design.overlay365.online/mcp
  # Authorization header VALUE for design.overlay365.online (Caddy basic auth),
  # e.g. Basic \$(printf '%s' 'operator:YOUR-PASSWORD' | base64):
  OPENHUB_MCP_OG_GLASS_AUTH=

Optional — run the Dev-Brain decision API on the phone (port 3450):
  cd $MCP_ROOT/Dev-Brain && npm run dev
EOF
