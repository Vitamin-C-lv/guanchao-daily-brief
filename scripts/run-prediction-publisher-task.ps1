param(
  [ValidateSet('Write','DryRun')][string]$Mode = 'Write',
  [string]$EditionDate = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = if ($env:GUANCHAO_NODE) { $env:GUANCHAO_NODE } else { 'node' }
$date = if ($EditionDate) { $EditionDate } else { [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'China Standard Time').ToString('yyyy-MM-dd') }
$args = @('scripts/run-prediction-publisher.mjs', '--edition-date', $date)
if ($Mode -eq 'Write') { $args += '--write' } else { $args += '--dry-run' }
& $node @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
