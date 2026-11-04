# Serve the Hugging Face JEV model used by OpenHub's local tier.
#
#   powershell -ExecutionPolicy Bypass -File benchmarks/jev-coding/serve-jev.ps1
#
# The first run creates a venv, installs jev-style[torch], and downloads the
# 0.8B model (~1.5 GB). Later runs reuse both. Leave this process running;
# OpenHub's JEV client points at http://127.0.0.1:8790.

$ErrorActionPreference = 'Stop'
$venv = Join-Path $PSScriptRoot '..\..\..\.tmp\jev-hf'
$python = Join-Path $venv 'Scripts\python.exe'
$jev = Join-Path $venv 'Scripts\jev-style.exe'

if (-not (Test-Path $python)) {
  Write-Host "creating venv at $venv"
  python -m venv $venv --system-site-packages
}

if (-not (Test-Path $jev)) {
  Write-Host 'installing jev-style[torch]'
  & $python -m pip install --disable-pip-version-check "jev-style[torch]"
}

& $jev serve --release 0.8b-v3 --backend torch --device cpu --host 127.0.0.1 --port 8790
