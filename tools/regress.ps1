# 전 양식 회귀테스트 — 채움(node) → Excel/한글 COM으로 열어 값·재계산 검증
# 실행: powershell -File tools\regress.ps1   (이 PC에 Excel·한글 필요)
$ErrorActionPreference='Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location (Join-Path $here '..')
Write-Output "== 1단계: 엔진 채움 =="
$fill = node tools/regress_fill.mjs
Write-Output $fill
$out = Join-Path $here 'out'
$fails = @()

Write-Output "== 2단계: Excel COM 검증 =="
$xl = New-Object -ComObject Excel.Application
$xl.Visible=$false; $xl.DisplayAlerts=$false
function XTest($name, $file, $checks){
  try {
    $wb=$xl.Workbooks.Open((Join-Path $script:out $file))
    $xl.CalculateFullRebuild()
    $ok=$true
    foreach($c in $checks){
      $v=[string]$wb.Worksheets.Item($c[0]).Range($c[1]).Text
      if($v -notlike ('*'+$c[2]+'*')){ Write-Output ("  ✗ $name ${c[1]}: [$v] ≠ 기대 [$($c[2])]"); $ok=$false }
    }
    $wb.Close($false)
    if($ok){ Write-Output "  ✓ $name" } else { $script:fails += $name }
  } catch { Write-Output ("  ✗ $name 열기 실패: " + $_.Exception.Message); $script:fails += $name }
}
try {
  XTest '착공계' 'R_착공계.xlsx' @(@('공사예정공정표','C14','가설·보양'),@('공사예정공정표','F14','08.01'))
  XTest '폐기물신고서' 'R_폐기물신고서.xlsx' @(@('신고서','E8','회귀테스트상호'),@('신고서','E16','회귀 용역명'))
  XTest '해체신고서' 'R_해체신고서.xlsx' @(@('건축물해체신고서','C7','회귀테스트소유자'),@('건축물해체신고서','C21','회귀 테스트 지번'))
  # 낙찰률: 재계산 후 단가 실물 대조(내림)
  $wb=$xl.Workbooks.Open((Join-Path $out 'R_낙찰률.xlsx'))
  $xl.CalculateFullRebuild()
  $ws=$wb.Worksheets.Item('내역서')
  $pairs=@{ 'I6'=71464; 'K6'=30312; 'M6'=31621; 'I9'=49034 }
  $ok=$true
  foreach($k in $pairs.Keys){ $v=[double]$ws.Range($k).Value2; if([math]::Abs($v-$pairs[$k]) -gt 0.001){ Write-Output ("  ✗ 낙찰률 $k = $v ≠ " + $pairs[$k]); $ok=$false } }
  $wb.Close($false)
  if($ok){ Write-Output "  ✓ 낙찰률(단가 실물 일치)" } else { $fails += '낙찰률' }
} finally { $xl.Quit(); [System.Runtime.Interopservices.Marshal]::ReleaseComObject($xl) | Out-Null }

Write-Output "== 3단계: 한글 COM 검증 =="
# 표준 래퍼: 복구플래그 클리어(비정상 종료 후 복구창 방지) + 메시지박스 자동응답 + 대화상자 워치독
try { Set-ItemProperty 'HKCU:\SOFTWARE\HNC\Hwp\9.0\HwpFrame\AppState' -Name MruTempFileFlag -Value 0 -ErrorAction Stop } catch {}
$wd = Start-Job -ScriptBlock {
  Add-Type @'
using System; using System.Text; using System.Runtime.InteropServices;
public class WDR {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  public delegate bool EnumProc(IntPtr h, IntPtr lp);
}
'@
  while($true){
    $hwpPids=(Get-Process Hwp -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Id)
    if($hwpPids){
      [WDR]::EnumWindows({ param($h,$lp)
        $o=[uint32]0; [WDR]::GetWindowThreadProcessId($h,[ref]$o) | Out-Null
        if($hwpPids -contains [int]$o -and [WDR]::IsWindowVisible($h)){
          $sb=New-Object System.Text.StringBuilder 256
          [WDR]::GetWindowText($h,$sb,256) | Out-Null
          if($sb.ToString() -eq '한글'){
            [WDR]::PostMessage($h,0x100,[IntPtr]0x0D,[IntPtr]0) | Out-Null
            [WDR]::PostMessage($h,0x101,[IntPtr]0x0D,[IntPtr]0) | Out-Null
          }
        }
        return $true
      },[IntPtr]::Zero) | Out-Null
    }
    Start-Sleep -Seconds 2
  }
}
$hwp = New-Object -ComObject HWPFrame.HwpObject
try {
  try { $hwp.SetMessageBoxMode(0x10001) | Out-Null } catch {}
  $htests = @(
    @('적격패킷','R_적격패킷.hwpx',@('회귀테스트 석면철거공사','123,456,789','95.5')),
    @('서약서','R_서약서.hwpx',@('회귀테스트 준설공사','500,000','일금일천만원')),
    @('인감계','R_인감계.hwpx',@('주식회사 종운건설','2099년  01월'))
  )
  foreach($t in $htests){
    $okOpen=$hwp.Open((Join-Path $out $t[1]),'','forceopen:true')
    $txt=$hwp.GetTextFile('TEXT','')
    $ok=($okOpen -eq $true)
    if($txt -match '\{\{'){ Write-Output ("  ✗ " + $t[0] + " 잔여 토큰 존재"); $ok=$false }
    foreach($needle in $t[2]){ if(-not $txt.Contains($needle)){ Write-Output ("  ✗ " + $t[0] + " 값 없음: " + $needle); $ok=$false } }
    if($ok){ Write-Output ("  ✓ " + $t[0]) } else { $fails += $t[0] }
  }
} finally {
  try { $hwp.Quit() } catch {}
  [System.Runtime.Interopservices.Marshal]::ReleaseComObject($hwp) | Out-Null
  Stop-Job $wd -ErrorAction SilentlyContinue; Remove-Job $wd -Force -ErrorAction SilentlyContinue
}

Write-Output "== 결과 =="
if($fails.Count){ Write-Output ("실패 " + $fails.Count + "건: " + ($fails -join ', ')); exit 1 }
Write-Output "전 항목 통과"
