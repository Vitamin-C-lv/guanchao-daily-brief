param(
  [ValidateSet('Write','DryRun')][string]$Mode = 'Write',
  [string]$EditionDate = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = if ($env:GUANCHAO_NODE) { $env:GUANCHAO_NODE } else { 'node' }
$shanghaiNow = [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'China Standard Time')
$effectiveDate = if ($EditionDate) {
  [datetime]::ParseExact($EditionDate, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
} else {
  $shanghaiNow.Date
}
if ($effectiveDate.DayOfWeek -eq [DayOfWeek]::Sunday) {
  Write-Output 'SUNDAY_NO_RUN'
  exit 0
}
$date = $effectiveDate.ToString('yyyy-MM-dd')
$args = @('scripts/run-prediction-publisher.mjs', '--edition-date', $date)
if ($Mode -eq 'Write') { $args += '--write' } else { $args += '--dry-run' }
& $node @args
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
