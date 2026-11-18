#!/usr/bin/env bash
# Khởi động Supabase local, tự thử lại khi máy GitHub trục trặc
# (kho ảnh Docker báo "Rate exceeded", cổng còn bị giữ từ lần thử trước…).
# Dùng: supabase-start.sh db      → chỉ Postgres
#       supabase-start.sh full    → đủ dịch vụ cho kiểm thử đầu-cuối / giao diện
set -u
mode="${1:-full}"
for i in 1 2 3; do
  if [ "$mode" = "db" ]; then
    supabase db start && exit 0
  else
    supabase start -x studio,imgproxy,logflare,vector && exit 0
  fi
  echo "::warning::Khởi động Supabase lần $i chưa được, dọn và thử lại"
  supabase stop --no-backup || true
  docker ps -aq --filter "name=supabase_" | xargs -r docker rm -f || true
  sleep $((i * 20))
done
echo "Khởi động Supabase thất bại sau 3 lần"
exit 1
