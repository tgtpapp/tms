# TMS tren may tinh (Windows): dung he thong tren may + lay du lieu moi nhat tu ban du phong Neon + mo app.
# Chi can Docker Desktop. Lan dau hoi chuoi ket noi Neon, SDT + mat khau tam cua Chu nha xe (luu ma hoa tren may, chi tai khoan Windows nay mo duoc).
$ErrorActionPreference = 'Continue'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$here = $PSScriptRoot
Set-Location $here
function Fail($m) { Write-Host ''; Write-Host "LOI: $m" -ForegroundColor Red; exit 1 }

if (Test-Path (Join-Path $here 'dang-la-may-chu.txt')) { Fail 'May nay dang la MAY CHU DU PHONG (co du lieu chi nam tren may). Khong lay lai du lieu Neon de khoi ghi de. Dung "Bat may chu khan cap.bat".' }

# 1. Docker Desktop
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Chua cai Docker Desktop (tai tai docker.com/products/docker-desktop, cai xong khoi dong lai may).' }
docker info > $null 2> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Dang mo Docker Desktop...'
  $dd = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dd) { Start-Process $dd }
  for ($i = 0; $i -lt 120; $i++) { Start-Sleep 3; Write-Host -NoNewline '.'; docker info > $null 2> $null; if ($LASTEXITCODE -eq 0) { Write-Host ''; break } }
  if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop chua chay. Mo Docker Desktop, doi bieu tuong ca voi dung yen roi chay lai.' }
}

# 2. Thong tin ket noi (luu ma hoa theo tai khoan Windows)
$store = Join-Path $here 'ket-noi.dat'
function Plain($sec) { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)) }
if (Test-Path $store) {
  $k = Get-Content $store | ForEach-Object { Plain (ConvertTo-SecureString $_) }
  $neon, $phone, $pass = $k[0], $k[1], $k[2]
} else {
  # Lay chuoi tu bo nho tam (nut "Copy snippet" tren Neon), khong phai dan vao cua so den
  Write-Host 'Tren trang Neon: bam Connect, TAT "Connection pooling", bam nut "Copy snippet".'
  $neon = ''
  for ($t = 0; $t -lt 5; $t++) {
    Read-Host 'Copy xong thi nhan Enter o day' | Out-Null
    $c = ((Get-Clipboard -Raw) -replace '\s', '')
    if ($c -match '^postgres(ql)?://[^:/]+:[^*@]+@') { $neon = $c; break }
    if ($c -match '\*') { Write-Host 'Chuoi dang bi che mat khau (dau *). Bam nut "Copy snippet", khong boi den.' -ForegroundColor Yellow }
    else { Write-Host 'Chua thay chuoi ket noi Neon trong bo nho tam. Bam nut "Copy snippet" tren Neon roi nhan Enter.' -ForegroundColor Yellow }
  }
  if (-not $neon) { Fail 'Chua lay duoc chuoi ket noi Neon.' }
  Set-Clipboard -Value ' '
  Write-Host 'Da lay chuoi ket noi Neon.' -ForegroundColor Green
  $phone = Read-Host 'SDT dang nhap cua Chu nha xe'
  $pass = Plain (Read-Host 'Dat mat khau cho Chu nha xe tren may nay (toi thieu 8 ky tu)' -AsSecureString)
  @($neon, $phone, $pass) | ForEach-Object { ConvertTo-SecureString $_ -AsPlainText -Force | ConvertFrom-SecureString } | Set-Content $store
}

# 3. He thong tren may
Write-Host '1/3 Khoi dong he thong tren may (lan dau tai khoang 2-3 GB, mat vai phut)...'
& "$here\supabase.exe" start --workdir "$here\he-thong" -x studio,imgproxy,inbucket,logflare,vector,supavisor
if ($LASTEXITCODE -ne 0) { Fail 'Khong khoi dong duoc he thong tren may.' }
$st = @{}
& "$here\supabase.exe" status --workdir "$here\he-thong" -o env | ForEach-Object { if ($_ -match '^([A-Z_]+)="?(.*?)"?$') { $st[$matches[1]] = $matches[2] } }

# 4. Du lieu moi nhat tu Neon (thay toan bo du lieu tren may)
Write-Host '2/3 Lay du lieu moi nhat tu ban du phong Neon...'
(Get-Content "$here\khoi_phuc.sh" -Raw) -replace "`r", '' | docker run --rm -i `
  -e NEON_DATABASE_URL=$neon -e OWNER_PHONE=$phone -e OWNER_PASSWORD=$pass `
  -e TARGET_DB_URL='postgresql://postgres@host.docker.internal:54322/postgres' -e PGPASSWORD=postgres `
  -e TARGET_API_URL='http://host.docker.internal:54321' -e TARGET_SERVICE_KEY=$($st['SERVICE_ROLE_KEY']) `
  postgres:17 bash -s
if ($LASTEXITCODE -ne 0) { Fail 'Lay du lieu chua xong (xem dong bao loi phia tren). Kiem tra mang roi chay lai.' }

# 5. Giao dien
Write-Host '3/3 Mo app...'
docker rm -f tms-tren-may > $null 2> $null
docker run -d --name tms-tren-may -p 5173:80 -v "${here}\web:/usr/share/nginx/html:ro" nginx:alpine > $null
if ($LASTEXITCODE -ne 0) { Fail 'Khong mo duoc giao dien.' }
Start-Process 'http://localhost:5173'
Write-Host ''
Write-Host 'Xong. App: http://localhost:5173 (dang nhap bang SDT + mat khau Chu nha xe da dat).' -ForegroundColor Green
Write-Host 'Ban tren may la ban sao: sua o day khong ve ban that; chay lai tep nay la lay du lieu moi nhat (ghi de).'
