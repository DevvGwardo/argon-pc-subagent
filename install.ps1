param(
    [switch]$ProjectOnly,
    [string]$ProjectRoot = (Get-Location).Path
)

$ErrorActionPreference = "Stop"
$RepoRoot = Split-Path -Parent $MyInvocation.MyCommand.Path

$SkillFiles = @(
    "SKILL.md",
    "scripts\check_status.mjs",
    "scripts\delegate_argon.mjs"
)

$Destinations = @()
if ($ProjectOnly) {
    $Destinations += (Join-Path $ProjectRoot ".agents\skills\argon-pc-subagent")
} else {
    $Destinations += (Join-Path $env:USERPROFILE ".agents\skills\argon-pc-subagent")
    $Destinations += (Join-Path $env:USERPROFILE ".gemini\config\skills\argon-pc-subagent")
}

foreach ($dest in $Destinations) {
    $scriptsDir = Join-Path $dest "scripts"
    New-Item -ItemType Directory -Force -Path $scriptsDir | Out-Null
    foreach ($rel in $SkillFiles) {
        Copy-Item -Path (Join-Path $RepoRoot $rel) -Destination (Join-Path $dest $rel) -Force
    }
    Write-Host "Installed argon-pc-subagent to $dest"
}
