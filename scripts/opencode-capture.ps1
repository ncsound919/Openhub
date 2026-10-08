# Captures real opencode engine shapes for OpenHub contract tests.
# Reads the engine password from the secrets file; never prints it.
$ErrorActionPreference = 'Continue'
$base = 'http://127.0.0.1:4196'
$PW = (Get-Content "$env:USERPROFILE\.secrets\opencode\server-password" -Raw).Trim()
$auth = @{ Authorization = 'Basic ' + [Convert]::ToBase64String([Text.Encoding]::ASCII.GetBytes("opencode:$PW")) }
$out = Join-Path (Split-Path $PSScriptRoot -Parent) 'data\opencode-capture'
New-Item -ItemType Directory -Force $out | Out-Null
$hdr = Join-Path $env:TEMP "oc-hdr-$PID.txt"
"Authorization: $($auth.Authorization)" | Set-Content -NoNewline -Encoding ascii $hdr
$log = Join-Path $out 'run.log'
function Log($m) { $line = "$(Get-Date -Format o) $m"; Add-Content $log $line; Write-Host $line }
function Call($method, $path, $body, $name) {
  try {
    $req = @{ Method = $method; Uri = "$base$path"; Headers = $auth; ContentType = 'application/json'; UseBasicParsing = $true }
    if ($null -ne $body) { $req.Body = ($body | ConvertTo-Json -Depth 10 -Compress) }
    $r = Invoke-WebRequest @req
    if ($name) { $r.Content | Set-Content -Encoding utf8 (Join-Path $out "$name.json") }
    Log "$method $path -> $($r.StatusCode)"
    return $r.Content
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    Log "$method $path -> FAILED $code $($_.Exception.Message)"
    if ($name) { "FAILED $code $($_.Exception.Message)" | Set-Content (Join-Path $out "$name.json") }
    return $null
  }
}
Remove-Item $log -ErrorAction SilentlyContinue
$ev = Join-Path $out 'events.txt'
Remove-Item $ev -ErrorAction SilentlyContinue
$curl = Start-Process curl.exe -ArgumentList @('-s','-N','-H',"@$hdr","$base/event",'-o',$ev) -PassThru -WindowStyle Hidden
Start-Sleep 2

Call GET '/doc' $null 'openapi' | Out-Null
Call GET '/global/health' $null 'health' | Out-Null
# Force bash to ask permission for this session only (permission ruleset shape seen in GET /session).
$created = Call POST '/session' @{ title = 'openhub contract capture (safe to delete)'; permission = @(@{ permission = 'bash'; pattern = '*'; action = 'ask' }) } 'session-create'
if (-not $created) { Log 'session create failed'; Stop-Process $curl -ErrorAction SilentlyContinue; Remove-Item $hdr; exit 1 }
$sid = ($created | ConvertFrom-Json).id
Log "session $sid"
Call POST "/session/$sid/prompt_async" @{ parts = @(@{ type = 'text'; text = 'Use the bash tool to run exactly: echo openhub-capture . Then reply with the single word done.' }) } 'prompt' | Out-Null

# Wait for a permission request, then answer it once.
$permId = $null
for ($i = 0; $i -lt 60 -and -not $permId; $i++) {
  Start-Sleep 1
  if (Test-Path $ev) {
    foreach ($line in Get-Content $ev) {
      if ($line -like 'data:*permission*') {
        try { $j = $line.Substring(5).Trim() | ConvertFrom-Json } catch { continue }
        if ($j.type -match 'permission\.(asked|updated)') { $permId = $j.properties.id; Log "permission event $($j.type) id=$permId" }
      }
    }
  }
}
Call GET '/permission' $null 'permission-list' | Out-Null
if ($permId) {
  $r = Call POST "/session/$sid/permissions/$permId" @{ response = 'once' } 'permission-reply-legacy'
  if (-not $r) { Call POST "/permission/$permId/reply" @{ reply = 'once' } 'permission-reply-v2' | Out-Null }
} else { Log 'no permission event within 60s' }

# Wait for the run to settle.
for ($i = 0; $i -lt 90; $i++) {
  Start-Sleep 1
  if ((Get-Content $ev -Raw -ErrorAction SilentlyContinue) -match '"session\.idle"') { Log 'session.idle seen'; break }
}
Call GET "/session/$sid" $null 'session-get' | Out-Null
$msgs = Call GET "/session/$sid/message" $null 'messages'
Call GET "/session/$sid/todo" $null 'todo' | Out-Null
Call GET "/session/$sid/diff" $null 'diff' | Out-Null
Call GET '/session/status' $null 'session-status' | Out-Null
if ($msgs) {
  $first = ($msgs | ConvertFrom-Json) | Where-Object { $_.info.role -eq 'user' } | Select-Object -First 1
  if ($first) {
    Call POST "/session/$sid/revert" @{ messageID = $first.info.id } 'revert' | Out-Null
    Call GET "/session/$sid" $null 'session-after-revert' | Out-Null
    Call POST "/session/$sid/unrevert" $null 'unrevert' | Out-Null
  } else { Log 'no user message found for revert' }
}
Call POST "/session/$sid/abort" $null 'abort' | Out-Null
Start-Sleep 2
Stop-Process $curl -ErrorAction SilentlyContinue
Call DELETE "/session/$sid" $null 'session-delete' | Out-Null
Remove-Item $hdr -ErrorAction SilentlyContinue
Log "DONE -> $out"
