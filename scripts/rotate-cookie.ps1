<#
.SYNOPSIS
  Rotate SUNO_COOKIE in .env from the clipboard, without the value ever being
  echoed to a terminal, a log, or an AI transcript.

.DESCRIPTION
  Copy the Cookie header from suno.com DevTools (see CLAUDE.md), then run:

      .\scripts\rotate-cookie.ps1

  The cookie goes clipboard -> .env directly. Nothing prints it. Restart the dev
  server afterwards; Next.js only reads .env at boot.

  This is deliberately ~40 readable lines rather than upstream PR #282's ~680
  lines of unreviewed credential-handling code.
#>

[CmdletBinding()]
param(
    [string]$EnvFile = (Join-Path $PSScriptRoot '..\.env')
)

$ErrorActionPreference = 'Stop'

$cookie = (Get-Clipboard -Raw)
if ($null -eq $cookie) { throw 'Clipboard is empty.' }

# Strip whitespace/newlines — DevTools "Copy value" sometimes appends one.
$cookie = $cookie.Trim() -replace '\r?\n', ''

# Tolerate a pasted 'Cookie: ' header prefix.
$cookie = $cookie -replace '^\s*[Cc]ookie:\s*', ''

if ($cookie -notmatch '__client') {
    throw "Clipboard does not look like a Suno cookie (no '__client' entry found). " +
          "Copy the full Cookie REQUEST header value, not a single cookie or a response header."
}

# Deliberately NOT checking for __session. It reads like a required entry, and
# CLAUDE.md used to say so, but the code disagrees: getAuthToken and keepAlive
# both authenticate with `Authorization: cookies.__client`, keepAlive MINTS a
# session token from it, and launchBrowser synthesises the __session cookie from
# that minted value. Nothing ever reads cookies.__session. A guard here would
# reject perfectly good cookies — it did, once, for two rounds.
if ($cookie.Contains("'")) {
    throw "Cookie contains a single quote, which would break .env quoting. Rotate manually."
}

if (-not (Test-Path $EnvFile)) { throw ".env not found at $EnvFile" }

# Keep one backup so a bad paste is recoverable.
Copy-Item $EnvFile "$EnvFile.bak" -Force

$lines   = Get-Content $EnvFile
$newLine = "SUNO_COOKIE='$cookie'"
$found   = $false

$out = foreach ($line in $lines) {
    if ($line -match '^\s*SUNO_COOKIE\s*=') { $found = $true; $newLine }
    else { $line }
}
if (-not $found) { $out = @($out) + $newLine }

Set-Content -Path $EnvFile -Value $out -Encoding utf8

Write-Host "Cookie rotated. Length: $($cookie.Length) chars. Backup: .env.bak" -ForegroundColor Green
Write-Host "Restart the dev server, then verify:" -ForegroundColor Yellow
Write-Host "  curl http://localhost:3060/api/get_limit"
