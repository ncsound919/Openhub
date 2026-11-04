#!/usr/bin/env python
"""Start the DesignPilot MCP server from a checkout.

The fleet registers DesignPilot as a stdio server (src/services/fleetMcp.ts), but the
package is not pip-installed on every machine. This shim puts the checkout's `src/` on
sys.path and calls the same entry point as the `designpilot-mcp` console script, so the
only requirements are a checkout and Python 3.10+.

    python scripts/designpilot_mcp.py "C:/path/to/designpilot-mcp/designpilot"

stdout is forced to UTF-8: JSON-RPC payloads carry design text (arrows, em dashes) and
the Windows console default is cp1252, which would corrupt them.
"""

from __future__ import annotations

import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: designpilot_mcp.py <designpilot-checkout>", file=sys.stderr)
        return 2

    checkout = Path(sys.argv[1]).resolve()
    src = checkout / "src"
    if not (src / "designpilot" / "server.py").is_file():
        print(f"designpilot server not found under {src}", file=sys.stderr)
        return 2

    sys.path.insert(0, str(src))
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8")
        except (AttributeError, ValueError):
            pass

    from designpilot.server import main as server_main

    server_main()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
