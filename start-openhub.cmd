@echo off
rem start-openhub.cmd - start OpenHub on :3011.
rem
rem WHY THIS EXISTS: OpenHub's machine surface (/api/internal/*) is guarded by a shared
rem secret. That secret is resolved from the Infisical vault (the primary credential lane)
rem at launch, so (a) the value never appears in argv or in this file, and (b) Keywire is
rem not a dependency of starting OpenHub.
setlocal
cd /d "%~dp0"
set "OPENHUB_INTERNAL_SECRET="
for /f "usebackq delims=" %%s in (`node "..\infisical\infisical-lane.mjs" get OPENHUB_INTERNAL_SECRET`) do set "OPENHUB_INTERNAL_SECRET=%%s"
if not defined OPENHUB_INTERNAL_SECRET (
  echo [start-openhub] WARNING: could not resolve OPENHUB_INTERNAL_SECRET from Infisical.
  echo [start-openhub] Starting anyway - /api/internal/* will answer 503 until it is set.
) else (
  echo [start-openhub] machine-surface secret resolved from Infisical.
)
set PORT=3011
npm run dev
