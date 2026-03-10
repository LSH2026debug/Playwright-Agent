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

$message = [string]::Concat(
  [char]0x5DF2, [char]0x91CD, [char]0x7F6E, [char]0x7B2C, [char]0x4E00,
  [char]0x9636, [char]0x6BB5, [char]0x7684, [char]0x5DE5, [char]0x4F5C,
  [char]0x6D41, [char]0x4EA7, [char]0x7269, [char]0x3002
)

Write-Host $message
