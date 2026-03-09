$root = Split-Path -Parent $PSScriptRoot

$targets = @(
  'artifacts/project.json',
  'artifacts/workflow-state.json',
  'artifacts/approval-log.json',
  'inputs/requirements-input.md',
  'requirements/normalized-requirements.md',
  'requirements/normalized-requirements.meta.json'
)

foreach ($relativePath in $targets) {
  $absolutePath = Join-Path $root $relativePath
  if (Test-Path $absolutePath) {
    Remove-Item $absolutePath -Force
  }
}

Set-Content -Path (Join-Path $root 'metadata/site/pages.yaml') -Value "pages: []`n"
Set-Content -Path (Join-Path $root 'metadata/site/flows.yaml') -Value "flows: []`n"

Write-Host 'Workflow artifacts reset for Phase 1.'
