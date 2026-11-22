# TMS trên máy tính (Windows): dựng hệ thống trên máy + lấy dữ liệu mới nhất từ bản dự phòng Neon + mở app.
# Chỉ cần Docker Desktop. Lần đầu hỏi chuỗi kết nối Neon, SĐT + mật khẩu tạm của Chủ nhà xe (lưu mã hóa trên máy, chỉ tài khoản Windows này mở được).
$ErrorActionPreference = 'Continue'
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$here = $PSScriptRoot
Set-Location $here
function Fail($m) { Write-Host ''; Write-Host "LỖI: $m" -ForegroundColor Red; exit 1 }

if (Test-Path (Join-Path $here 'dang-la-may-chu.txt')) { Fail 'Máy này đang là MÁY CHỦ DỰ PHÒNG (có dữ liệu chỉ nằm trên máy). Không lấy lại dữ liệu Neon để khỏi ghi đè. Dùng "Bat may chu khan cap.bat".' }

# 1. Docker Desktop
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Chưa cài Docker Desktop (tải tại docker.com/products/docker-desktop, cài xong khởi động lại máy).' }
docker info > $null 2> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host 'Đang mở Docker Desktop...'
  $dd = "$env:ProgramFiles\Docker\Docker\Docker Desktop.exe"
  if (Test-Path $dd) { Start-Process $dd }
  for ($i = 0; $i -lt 60; $i++) { Start-Sleep 3; docker info > $null 2> $null; if ($LASTEXITCODE -eq 0) { break } }
  if ($LASTEXITCODE -ne 0) { Fail 'Docker Desktop chưa chạy. Mở Docker Desktop, đợi biểu tượng cá voi đứng yên rồi chạy lại.' }
}

# 2. Thông tin kết nối (lưu mã hóa theo tài khoản Windows)
$store = Join-Path $here 'ket-noi.dat'
function Plain($sec) { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)) }
if (Test-Path $store) {
  $k = Get-Content $store | ForEach-Object { Plain (ConvertTo-SecureString $_) }
  $neon, $phone, $pass = $k[0], $k[1], $k[2]
} else {
  $neon = Plain (Read-Host 'Dán chuỗi kết nối Neon (postgresql://...)' -AsSecureString)
  if (-not $neon.StartsWith('postgres')) { Fail 'Chuỗi kết nối Neon không đúng.' }
  $phone = Read-Host 'SĐT đăng nhập của Chủ nhà xe'
  $pass = Plain (Read-Host 'Đặt mật khẩu cho Chủ nhà xe trên máy này (tối thiểu 8 ký tự)' -AsSecureString)
  @($neon, $phone, $pass) | ForEach-Object { ConvertTo-SecureString $_ -AsPlainText -Force | ConvertFrom-SecureString } | Set-Content $store
}

# 3. Hệ thống trên máy
Write-Host '1/3 Khởi động hệ thống trên máy (lần đầu tải khoảng 2-3 GB, mất vài phút)...'
& "$here\supabase.exe" start --workdir "$here\he-thong" -x studio,imgproxy,inbucket,logflare,vector,supavisor
if ($LASTEXITCODE -ne 0) { Fail 'Không khởi động được hệ thống trên máy.' }
$st = @{}
& "$here\supabase.exe" status --workdir "$here\he-thong" -o env | ForEach-Object { if ($_ -match '^([A-Z_]+)="?(.*?)"?$') { $st[$matches[1]] = $matches[2] } }

# 4. Dữ liệu mới nhất từ Neon (thay toàn bộ dữ liệu trên máy)
Write-Host '2/3 Lấy dữ liệu mới nhất từ bản dự phòng Neon...'
(Get-Content "$here\khoi_phuc.sh" -Raw) -replace "`r", '' | docker run --rm -i `
  -e NEON_DATABASE_URL=$neon -e OWNER_PHONE=$phone -e OWNER_PASSWORD=$pass `
  -e TARGET_DB_URL='postgresql://postgres:postgres@host.docker.internal:54322/postgres' `
  -e TARGET_API_URL='http://host.docker.internal:54321' -e TARGET_SERVICE_KEY=$($st['SERVICE_ROLE_KEY']) `
  postgres:17 bash -s
if ($LASTEXITCODE -ne 0) { Fail 'Lấy dữ liệu chưa xong (xem dòng báo lỗi phía trên). Kiểm tra mạng rồi chạy lại.' }

# 5. Giao diện
Write-Host '3/3 Mở app...'
docker rm -f tms-tren-may > $null 2> $null
docker run -d --name tms-tren-may -p 5173:80 -v "${here}\web:/usr/share/nginx/html:ro" nginx:alpine > $null
if ($LASTEXITCODE -ne 0) { Fail 'Không mở được giao diện.' }
Start-Process 'http://localhost:5173'
Write-Host ''
Write-Host 'Xong. App: http://localhost:5173 (đăng nhập bằng SĐT + mật khẩu Chủ nhà xe đã đặt).' -ForegroundColor Green
Write-Host 'Bản trên máy là bản sao: sửa ở đây không về bản thật; chạy lại tệp này là lấy dữ liệu mới nhất (ghi đè).'
