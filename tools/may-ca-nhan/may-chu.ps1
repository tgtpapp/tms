# MÁY CHỦ DỰ PHÒNG KHẨN CẤP: khi Supabase gặp sự cố, máy tính này chạy app cho cả nhà xe qua Internet.
# - Lần bật đầu tiên: lấy dữ liệu từ bản dự phòng Neon (đêm gần nhất). Các lần sau GIỮ NGUYÊN dữ liệu đang chạy trên máy.
# - Địa chỉ: có mã đường hầm Cloudflare (tên miền riêng) thì địa chỉ cố định; chưa có thì địa chỉ tạm *.trycloudflare.com (đổi mỗi lần bật).
# - Máy phải mở liên tục, có mạng; tắt máy là nhà xe không dùng được.
$ErrorActionPreference = 'Continue'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$here = $PSScriptRoot
Set-Location $here
function Fail($m) { Write-Host ''; Write-Host "LỖI: $m" -ForegroundColor Red; exit 1 }
function Plain($sec) { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)) }

if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Chưa cài Docker Desktop.' }
docker info > $null 2> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Đang mở Docker Desktop...'
  $dd = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dd) { Start-Process $dd }
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep 3; docker info > $null 2> $null; if ($LASTEXITCODE -eq 0) { break } }
  if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop chưa chạy.' }
}

$store = Join-Path $here 'ket-noi.dat'
if (-not (Test-Path $store)) { Fail 'Chạy "TMS tren may.bat" một lần trước để nhập kết nối Neon và tài khoản Chủ nhà xe.' }
$k = Get-Content $store | ForEach-Object { Plain (ConvertTo-SecureString $_) }
$neon, $phone, $pass = $k[0], $k[1], $k[2]
$tok = ''
$tokFile = Join-Path $here 'duong-ham.dat'
if (Test-Path $tokFile) { $tok = Plain (ConvertTo-SecureString (Get-Content $tokFile)) }

Write-Host '1/4 Khởi động hệ thống trên máy...'
& "$here\supabase.exe" start --workdir "$here\he-thong" -x studio,imgproxy,inbucket,logflare,vector,supavisor
if ($LASTEXITCODE -ne 0) { Fail 'Không khởi động được hệ thống trên máy.' }
$st = @{}
& "$here\supabase.exe" status --workdir "$here\he-thong" -o env | ForEach-Object { if ($_ -match '^([A-Z_]+)="?(.*?)"?$') { $st[$matches[1]] = $matches[2] } }

$flag = Join-Path $here 'dang-la-may-chu.txt'
if (-not (Test-Path $flag)) {
  Write-Host '2/4 Lần bật đầu tiên: lấy dữ liệu từ bản dự phòng Neon...'
  (Get-Content "$here\khoi_phuc.sh" -Raw) -replace "`r", '' | docker run --rm -i `
    -e NEON_DATABASE_URL=$neon -e OWNER_PHONE=$phone -e OWNER_PASSWORD=$pass `
    -e TARGET_DB_URL='postgresql://postgres@host.docker.internal:54322/postgres' -e PGPASSWORD=postgres `
    -e TARGET_API_URL='http://host.docker.internal:54321' -e TARGET_SERVICE_KEY=$($st['SERVICE_ROLE_KEY']) `
    postgres:17 bash -s
  if ($LASTEXITCODE -ne 0) { Fail 'Lấy dữ liệu chưa xong. Kiểm tra mạng rồi chạy lại.' }
  Set-Content $flag "Máy chủ dự phòng bắt đầu chạy lúc $(Get-Date -Format 'HH:mm dd/MM/yyyy'). Dữ liệu từ đây chỉ có trên máy này."
} else { Write-Host '2/4 Giữ nguyên dữ liệu đang chạy trên máy.' }

Write-Host '3/4 Mở cổng cho app...'
docker rm -f tms-tren-may tms-may-chu tms-duong-ham > $null 2> $null
docker run -d --name tms-may-chu --restart unless-stopped -p 8080:80 -v "${here}\web-may-chu:/usr/share/nginx/html:ro" `
  -v "${here}\nginx-may-chu.conf:/etc/nginx/conf.d/default.conf:ro" nginx:alpine > $null
if ($LASTEXITCODE -ne 0) { Fail 'Không mở được cổng app.' }

Write-Host '4/4 Đưa ra Internet (Cloudflare)...'
if ($tok) {
  docker run -d --name tms-duong-ham --restart unless-stopped cloudflare/cloudflared:latest tunnel --no-autoupdate run --token $tok > $null
  Write-Host 'Xong. Nhân viên vào địa chỉ tên miền của nhà xe như đã cài.' -ForegroundColor Green
} else {
  docker run -d --name tms-duong-ham --restart unless-stopped cloudflare/cloudflared:latest tunnel --no-autoupdate --url http://host.docker.internal:8080 > $null
  $url = ''
  for ($i = 0; $i -lt 30 -and -not $url; $i++) { Start-Sleep 2; $m = (docker logs tms-duong-ham 2>&1 | Out-String) | Select-String -Pattern 'https://[a-z0-9-]+\.trycloudflare\.com'; if ($m) { $url = $m.Matches[0].Value } }
  if (-not $url) { Fail 'Chưa lấy được địa chỉ Internet. Kiểm tra mạng rồi chạy lại.' }
  Set-Clipboard $url
  Write-Host ''
  Write-Host "Xong. Địa chỉ app cho cả nhà xe: $url" -ForegroundColor Green
  Write-Host '(đã chép sẵn, dán vào Zalo gửi nhân viên; địa chỉ này đổi mỗi lần bật lại)'
}
Write-Host 'Chỉ Chủ nhà xe đăng nhập được ngay; vào Người dùng → Đặt lại mật khẩu cho từng người.'
Write-Host 'Máy phải mở liên tục và có mạng. Khi Supabase hoạt động lại: nhắn Claude để chuyển dữ liệu trên máy về.'
