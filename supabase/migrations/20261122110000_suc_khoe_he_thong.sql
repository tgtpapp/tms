-- Cấu hình → Dung lượng: thêm "sức khỏe" bản dự phòng Neon (dung lượng + lần sao chép cuối có khớp không).
-- Số liệu do việc sao lưu mỗi đêm ghi vào (máy chủ, bảng nội bộ app.platform_stats, trình duyệt không đọc trực tiếp).
create table app.platform_stats (
  key         text primary key check (key ~ '^[a-z_]{1,40}$'),
  value       jsonb not null,
  updated_at  timestamptz not null default now()
);
alter table app.platform_stats enable row level security;
revoke all on app.platform_stats from public, anon, authenticated;
grant select, insert, update on app.platform_stats to service_role;

do $$
declare v text;
begin
  select pg_get_functiondef('public.storage_usage()'::regprocedure) into v;
  v := replace(v, '''drive_files_bytes'',',
    '''neon'', (select value || jsonb_build_object(''at'', updated_at) from app.platform_stats where key = ''neon''),
    ''drive_files_bytes'',');
  if v not like '%platform_stats%' then raise exception 'Không sửa được storage_usage'; end if;
  execute v;
end;
$$;
