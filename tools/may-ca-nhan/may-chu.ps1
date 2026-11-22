# MAY CHU DU PHONG KHAN CAP: khi Supabase gap su co, may tinh nay chay app cho ca nha xe qua Internet.
# - Lan bat dau tien: lay du lieu tu ban du phong Neon (dem gan nhat). Cac lan sau GIU NGUYEN du lieu dang chay tren may.
# - Dia chi: co ma duong ham Cloudflare (ten mien rieng) thi dia chi co dinh; chua co thi dia chi tam *.trycloudflare.com (doi moi lan bat).
# - May phai mo lien tuc, co mang; tat may la nha xe khong dung duoc.
$ErrorActionPreference = 'Continue'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$here = $PSScriptRoot
Set-Location $here
function Fail($m) { Write-Host ''; Write-Host "LOI: $m" -ForegroundColor Red; exit 1 }
function Plain($sec) { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)) }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Chua cai Docker Desktop.' }
docker info > $null 2> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Dang mo Docker Desktop...'
  $dd = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dd) { Start-Process $dd }
  for ($i = 0; $i -lt 120; $i++) { Start-Sleep 3; Write-Host -NoNewline '.'; docker info > $null 2> $null; if ($LASTEXITCODE -eq 0) { Write-Host ''; break } }
  if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop chua chay.' }
}

$store = Join-Path $here 'ket-noi.dat'
if (-not (Test-Path $store)) { Fail 'Chay "TMS tren may.bat" mot lan truoc de nhap ket noi Neon va tai khoan Chu nha xe.' }
$k = Get-Content $store | ForEach-Object { Plain (ConvertTo-SecureString $_) }
$neon, $phone, $pass = $k[0], $k[1], $k[2]
$tok = ''
$tokFile = Join-Path $here 'duong-ham.dat'
if (Test-Path $tokFile) { $tok = Plain (ConvertTo-SecureString (Get-Content $tokFile)) }

Write-Host '1/4 Khoi dong he thong tren may...'
& "$here\supabase.exe" start --workdir "$here\he-thong" -x studio,imgproxy,inbucket,logflare,vector,supavisor
if ($LASTEXITCODE -ne 0) { Fail 'Khong khoi dong duoc he thong tren may.' }
$st = @{}
& "$here\supabase.exe" status --workdir "$here\he-thong" -o env | ForEach-Object { if ($_ -match '^([A-Z_]+)="?(.*?)"?$') { $st[$matches[1]] = $matches[2] } }

$flag = Join-Path $here 'dang-la-may-chu.txt'
if (-not (Test-Path $flag)) {
  Write-Host '2/4 Lan bat dau tien: lay du lieu tu ban du phong Neon...'
  (Get-Content "$here\khoi_phuc.sh" -Raw) -replace "`r", '' | docker run --rm -i `
    -e NEON_DATABASE_URL=$neon -e OWNER_PHONE=$phone -e OWNER_PASSWORD=$pass `
    -e TARGET_DB_URL='postgresql://postgres@host.docker.internal:54322/postgres' -e PGPASSWORD=postgres `
    -e TARGET_API_URL='http://host.docker.internal:54321' -e TARGET_SERVICE_KEY=$($st['SERVICE_ROLE_KEY']) `
    postgres:17 bash -s
  if ($LASTEXITCODE -ne 0) { Fail 'Lay du lieu chua xong. Kiem tra mang roi chay lai.' }
  Set-Content $flag "May chu du phong bat dau chay luc $(Get-Date -Format 'HH:mm dd/MM/yyyy'). Du lieu tu day chi co tren may nay."
} else { Write-Host '2/4 Giu nguyen du lieu dang chay tren may.' }

Write-Host '3/4 Mo cong cho app...'
docker rm -f tms-tren-may tms-may-chu tms-duong-ham > $null 2> $null
docker run -d --name tms-may-chu --restart unless-stopped -p 8080:80 -v "${here}\web-may-chu:/usr/share/nginx/html:ro" `
  -v "${here}\nginx-may-chu.conf:/etc/nginx/conf.d/default.conf:ro" nginx:alpine > $null
if ($LASTEXITCODE -ne 0) { Fail 'Khong mo duoc cong app.' }

Write-Host '4/4 Dua ra Internet (Cloudflare)...'
if ($tok) {
  docker run -d --name tms-duong-ham --restart unless-stopped cloudflare/cloudflared:latest tunnel --no-autoupdate run --token $tok > $null
  Write-Host 'Xong. Nhan vien vao dia chi ten mien cua nha xe nhu da cai.' -ForegroundColor Green
} else {
  docker run -d --name tms-duong-ham --restart unless-stopped cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://host.docker.internal:8080 > $null
  $url = ''
  for ($i = 0; $i -lt 30 -and -not $url; $i++) { Start-Sleep 2; $m = (docker logs tms-duong-ham 2>&1 | Out-String) | Select-String -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com'; if ($m) { $url = $m.Matches[0].Value } }
  if (-not $url) { Fail 'Chua lay duoc dia chi Internet. Kiem tra mang roi chay lai.' }
  Set-Clipboard $url
  Write-Host ''
  Write-Host "Xong. Dia chi app cho ca nha xe: $url" -ForegroundColor Green
  Write-Host '(da chep san, dan vao Zalo gui nhan vien; dia chi nay doi moi lan bat lai)'
}
Write-Host 'Chi Chu nha xe dang nhap duoc ngay; vao Nguoi dung -> Dat lai mat khau cho tung nguoi.'
Write-Host 'May phai mo lien tuc va co mang. Khi Supabase hoat dong lai: nhan Claude de chuyen du lieu tren may ve.'
