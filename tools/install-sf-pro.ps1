# Mengambil SF Pro dari Apple Design Resources dan menaruh 8 berkas yang
# dipakai src/ui/fonts.css (Display, 400/500/600/700) di
# public/fonts/sf-pro/. Butuh 7-Zip (`7z` di PATH).
#
#   powershell -ExecutionPolicy Bypass -File tools/install-sf-pro.ps1
#   powershell -ExecutionPolicy Bypass -File tools/install-sf-pro.ps1 -Dmg C:\Downloads\SF-Pro.dmg
param([string]$Dmg)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$dest = Join-Path $repo 'public\fonts\sf-pro'
$work = Join-Path ([IO.Path]::GetTempPath()) "dichroic-sf-pro-$([guid]::NewGuid().ToString('N').Substring(0, 8))"
$wanted = foreach ($o in @('Display')) { foreach ($w in 'Regular', 'Medium', 'Semibold', 'Bold') { "SF-Pro-$o-$w.otf" } }

$sevenZip = (Get-Command 7z -ErrorAction SilentlyContinue).Source
if (-not $sevenZip -and (Test-Path 'C:\Program Files\7-Zip\7z.exe')) { $sevenZip = 'C:\Program Files\7-Zip\7z.exe' }
if (-not $sevenZip) { throw '7-Zip tidak ditemukan. Pasang dari https://www.7-zip.org lalu jalankan lagi.' }

New-Item -ItemType Directory -Force $work, $dest | Out-Null
try {
  if (-not $Dmg) {
    $Dmg = Join-Path $work 'SF-Pro.dmg'
    Write-Host 'Mengunduh SF-Pro.dmg dari Apple...'
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    Invoke-WebRequest -UseBasicParsing -Uri 'https://devimages-cdn.apple.com/design/resources/download/SF-Pro.dmg' -OutFile $Dmg
  }

  # dmg -> pkg -> Payload (cpio terkompresi) -> cpio -> Library/Fonts/*.otf.
  # Setiap lapis dibuka sampai berkas .otf yang dicari muncul.
  $queue = [System.Collections.Generic.Queue[string]]::new()
  $queue.Enqueue((Resolve-Path $Dmg).Path)
  $step = 0
  while ($queue.Count -gt 0 -and $step -lt 12) {
    $archive = $queue.Dequeue()
    $out = Join-Path $work "x$step"
    $step++
    & $sevenZip x -y -bso0 -bsp0 "-o$out" $archive | Out-Null
    if (Get-ChildItem $out -Recurse -Filter 'SF-Pro-Display-Regular.otf' -ErrorAction SilentlyContinue) { break }
    Get-ChildItem $out -Recurse -File |
      Where-Object { $_.Extension -in '.pkg', '.cpio', '.gz', '.hfs', '.img' -or $_.Name -like 'Payload*' -or $_.Name -match '^\d+\.hfs$' } |
      Sort-Object Length -Descending |
      ForEach-Object { $queue.Enqueue($_.FullName) }
  }

  $missing = @()
  foreach ($name in $wanted) {
    $file = Get-ChildItem $work -Recurse -Filter $name -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($file) { Copy-Item $file.FullName (Join-Path $dest $name) -Force } else { $missing += $name }
  }
  if ($missing.Count -gt 0) { throw "Tidak ditemukan di dmg: $($missing -join ', ')" }
  Write-Host "Selesai: $($wanted.Count) berkas di $dest"
} finally {
  Remove-Item -Recurse -Force $work -ErrorAction SilentlyContinue
}
