# 29 pan4 part B fixture writer - reads layout JSON (UTF-8) made by make_sinil_fake.mjs and saves .xls (FileFormat 56) via Excel COM.
# ASCII only on purpose (PowerShell 5.1 reads BOM-less scripts as ANSI). All Korean text comes from the JSON.
param([Parameter(Mandatory = $true)][string]$Layout)
$ErrorActionPreference = 'Stop'
$spec = Get-Content -LiteralPath $Layout -Raw -Encoding UTF8 | ConvertFrom-Json
$xl = New-Object -ComObject Excel.Application
$xl.Visible = $false
$xl.DisplayAlerts = $false
try {
  $wb = $xl.Workbooks.Add()
  while ($wb.Worksheets.Count -lt 2) { [void]$wb.Worksheets.Add([Type]::Missing, $wb.Worksheets.Item($wb.Worksheets.Count)) }
  $wb.Worksheets.Item(2).Name = $spec.sheet2
  foreach ($c in $spec.cells) {
    $ws = $wb.Worksheets.Item([int]$c.s)
    $cell = $ws.Cells.Item([int]$c.r + 1, [int]$c.c + 1)
    if ($c.t -eq 'text') { $cell.NumberFormat = '@'; $cell.Value2 = [string]$c.v }
    elseif ($c.t -eq 'num') { $cell.Value2 = [double]$c.v }
    else { $cell.Formula = [string]$c.v }
  }
  $wb.Worksheets.Item(1).Activate()
  $wb.SaveAs($spec.out, 56)
  $wb.Close($false)
} finally {
  $xl.Quit()
  [void][System.Runtime.InteropServices.Marshal]::ReleaseComObject($xl)
  [GC]::Collect(); [GC]::WaitForPendingFinalizers()
}
