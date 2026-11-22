#!/usr/bin/env bash
# Dựng lại hệ thống từ bản dự phòng Neon vào một Supabase (project mới khi có sự cố, hoặc Supabase tạm để diễn tập).
# Cần biến: NEON_DATABASE_URL, TARGET_DB_URL (database đích, đã chạy đủ migration), TARGET_API_URL, TARGET_SERVICE_KEY.
# Tùy chọn: OWNER_PHONE + OWNER_PASSWORD (đặt mật khẩu tạm cho Chủ nhà xe để đăng nhập, rồi đặt lại mật khẩu cho người khác trong app).
# Kho mã công khai: chỉ in số đếm, không in dữ liệu / khóa.
set -euo pipefail
{ command -v curl && command -v openssl; } >/dev/null || { apt-get update -qq >/dev/null && apt-get install -y -qq curl openssl >/dev/null; }
W=$(mktemp -d)
echo "1. Lấy dữ liệu từ bản dự phòng Neon"
psql "$NEON_DATABASE_URL" -tAc "select count(*) from public.tenants" | sed 's/^/   Số nhà xe trên Neon: /'
pg_dump "$NEON_DATABASE_URL" --data-only --no-owner --no-privileges -n public -n app -f "$W/data.sql"
psql "$NEON_DATABASE_URL" -v ON_ERROR_STOP=1 -qc "\copy (select u.id, u.email, coalesce(a.phone, '') from auth.users u left join public.app_users a on a.id = u.id) to '$W/users.csv' csv"
echo "   Tài khoản: $(wc -l < "$W/users.csv")"

echo "2. Tạo lại tài khoản đăng nhập (giữ nguyên mã tài khoản; mật khẩu ngẫu nhiên, không in ra)"
made=0; owner=0
while IFS=, read -r id email phone; do
  [ -n "$email" ] || continue
  pw=$(openssl rand -base64 24)
  if [ -n "${OWNER_PHONE:-}" ] && [ "$phone" = "$OWNER_PHONE" ] && [ -n "${OWNER_PASSWORD:-}" ]; then pw="$OWNER_PASSWORD"; owner=1; fi
  # mã, email, SĐT chỉ có chữ số / chữ / @ . - ; mật khẩu tạm của Chủ nhà xe: thoát dấu " và \
  pj=$(printf '%s' "$pw" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  body=$(printf '{"id":"%s","email":"%s","password":"%s","email_confirm":true,"user_metadata":{"phone":"%s"}}' "$id" "$email" "$pj" "$phone")
  code=$(curl -s -o "$W/r.json" -w '%{http_code}' -X POST "$TARGET_API_URL/auth/v1/admin/users" \
    -H "apikey: $TARGET_SERVICE_KEY" -H "Authorization: Bearer $TARGET_SERVICE_KEY" -H 'Content-Type: application/json' -d "$body")
  if [ "$code" = "200" ] || [ "$code" = "201" ]; then made=$((made+1));
  elif grep -qiE 'already|exists|registered' "$W/r.json"; then made=$((made+1));
  else echo "   ::warning::Không tạo được 1 tài khoản (mã $code)"; fi
done < "$W/users.csv"
echo "   Đã tạo $made tài khoản; mật khẩu tạm cho Chủ nhà xe: $([ $owner = 1 ] && echo đã đặt || echo chưa đặt)"

echo "3. Đổ dữ liệu vào database đích (thay toàn bộ dữ liệu nghiệp vụ)"
tables=$(psql "$TARGET_DB_URL" -tAc "select string_agg(format('%I.%I', schemaname, tablename), ', ') from pg_tables where schemaname in ('public', 'app')")
{
  echo "begin;"
  echo "set session_replication_role = replica;"
  echo "truncate table $tables restart identity cascade;"
  grep -vE '^SET transaction_timeout' "$W/data.sql"
  echo "commit;"
} > "$W/load.sql"
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 -q -f "$W/load.sql" > "$W/load.log" 2>&1 || { echo "::error::Đổ dữ liệu lỗi"; grep -m5 ERROR "$W/load.log" | sed -E 's/(DETAIL|LINE).*//'; exit 1; }

echo "4. Đối chiếu số dòng (Neon · đích)"
bad=0
for t in tenants app_users staff_members vehicles trips trip_crew bookings seat_inventory ledger_transactions ledger_lines shipments documents file_store archive_items tenant_settings; do
  a=$(psql "$NEON_DATABASE_URL" -tAc "select count(*) from public.$t" 2>/dev/null || echo "?")
  b=$(psql "$TARGET_DB_URL" -tAc "select count(*) from public.$t" 2>/dev/null || echo "?")
  echo "   $t: $a · $b"; [ "$a" = "$b" ] || bad=1
done
miss=$(psql "$TARGET_DB_URL" -tAc "select count(*) from public.app_users a where not exists (select 1 from auth.users u where u.id = a.id)")
echo "   Người dùng chưa có tài khoản đăng nhập: $miss"
[ "$miss" = "0" ] || bad=1
rm -rf "$W"
[ $bad = 0 ] || { echo "::error::Dữ liệu khôi phục lệch"; exit 1; }
echo "Khôi phục xong, dữ liệu khớp."
