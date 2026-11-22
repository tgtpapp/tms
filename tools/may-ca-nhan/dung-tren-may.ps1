# Dựng 1 bản TMS chạy trên máy tính của mình (Windows), dữ liệu lấy từ bản dự phòng Neon đêm gần nhất.
# Cần cài sẵn: Docker Desktop (đang chạy), Node.js 20+, Git. Chạy trong PowerShell tại thư mục kho code:
#   powershell -ExecutionPolicy Bypass -File tools\may-ca-nhan\dung-tren-may.ps1
# Lần đầu hỏi chuỗi kết nối Neon (dán vào, không hiện lên màn hình) + SĐT / mật khẩu tạm của Chủ nhà xe.
# Chỉ máy này mở được app (http://localhost:5173). Chạy lại bất cứ lúc nào để lấy dữ liệu mới nhất.
$ErrorActionPreference = 'Continue'   # lệnh ngoài (docker, npx) tự kiểm mã thoát
$OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$root = (Resolve-Path "$PSScriptRoot\..\..").Path
Set-Location $root
function Need($cmd, $name) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "Chưa cài $name" } }
Need docker 'Docker Desktop'; Need node 'Node.js'; Need npx 'Node.js (npx)'
docker info > $null 2> $null; if ($LASTEXITCODE -ne 0) { throw 'Docker Desktop chưa chạy: mở Docker Desktop rồi chạy lại' }

function Plain($sec) { [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec)) }
$neon = Plain (Read-Host 'Dán chuỗi kết nối Neon (postgresql://...)' -AsSecureString)
if (-not $neon.StartsWith('postgresql://')) { throw 'Chuỗi kết nối Neon không đúng' }
$phone = Read-Host 'SĐT đăng nhập của Chủ nhà xe'
$pass = Plain (Read-Host 'Đặt mật khẩu tạm cho Chủ nhà xe (tối thiểu 8 ký tự)' -AsSecureString)

Write-Host '1/4 Khởi động Supabase trên máy (lần đầu tải khoảng 2-3 GB, mất vài phút)...'
npx --yes supabase@3.2.0 start
if ($LASTEXITCODE -ne 0) { throw 'Không khởi động được Supabase trên máy' }
$st = @{}
npx --yes supabase@3.2.0 status -o env | ForEach-Object { if ($_ -match '^([A-Z_]+)="?(.*?)"?$') { $st[$matches[1]] = $matches[2] } }

Write-Host '2/4 Đổ dữ liệu từ Neon vào bản trên máy...'
$sh = (Get-Content "$root\.github\scripts\khoi_phuc.sh" -Raw) -replace "`r", ''
$sh | docker run --rm -i `
  -e NEON_DATABASE_URL=$neon -e OWNER_PHONE=$phone -e OWNER_PASSWORD=$pass `
  -e TARGET_DB_URL='postgresql://postgres:postgres@host.docker.internal:54322/postgres' `
  -e TARGET_API_URL='http://host.docker.internal:54321' -e TARGET_SERVICE_KEY=$($st['SERVICE_ROLE_KEY']) `
  postgres:17 bash -s
if ($LASTEXITCODE -ne 0) { throw 'Đổ dữ liệu chưa xong (xem dòng báo lỗi phía trên)' }

Write-Host '3/4 Cấu hình giao diện trỏ về bản trên máy...'
$envFile = Get-Content "$root\web\.env.production" | Where-Object { $_ -notmatch '^(VITE_SUPABASE_URL|VITE_SUPABASE_PUBLISHABLE_KEY|VITE_APP_ENV)=' }
$envFile += 'VITE_APP_ENV=local'
$envFile += "VITE_SUPABASE_URL=$($st['API_URL'])"
$envFile += "VITE_SUPABASE_PUBLISHABLE_KEY=$($st['ANON_KEY'])"
Set-Content -Path "$root\web\.env.local" -Value $envFile -Encoding UTF8

Write-Host '4/4 Mở app: http://localhost:5173 (đóng cửa sổ này là tắt app; Supabase vẫn chạy trong Docker)'
Set-Location "$root\web"
npm install --no-audit --no-fund
Start-Process 'http://localhost:5173'
npm run dev
