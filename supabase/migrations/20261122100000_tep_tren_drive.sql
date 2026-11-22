-- =====================================================================
-- Tệp (ảnh giấy tờ, chữ ký, con dấu, logo, ảnh đại diện, ảnh báo dầu, PDF…) lưu trên Google Drive của nhà xe như app cũ.
-- Database chỉ giữ chữ: bảng file_store ghi tên tệp (đường dẫn cũ, giữ nguyên làm khóa) → mã tệp trên Drive.
-- - Xem: Edge Function "tep" kiểm quyền theo bảng này (RLS) rồi lấy tệp từ Drive; máy người dùng nhớ tệp, lần sau không tải lại.
-- - Quyền đọc / ghi / xóa: chép đúng các quy tắc đang áp cho kho tệp cũ (storage.objects, bucket giay-to) sang bảng này.
-- - Nhà xe chưa kết nối Drive: tệp tạm để ở kho cũ (drive_id trống), kết nối Drive xong tự chuyển sang Drive.
-- - Tệp đang có ở kho cũ: ghi vào bảng (drive_id trống); Chủ nhà xe mở app thì tự chuyển lên Drive, đủ dung lượng mới xóa bản cũ.
-- =====================================================================
create table public.file_store (
  tenant_id   uuid not null default app.current_tenant_id() references public.tenants (id),
  name        text not null check (length(name) <= 500 and name !~ '\.\.'),
  drive_id    text check (drive_id is null or length(drive_id) <= 200),   -- trống: tệp còn ở kho cũ
  mime        text check (mime is null or length(mime) <= 100),
  size_bytes  bigint,
  move_fail   int not null default 0,                                     -- số lần chuyển lên Drive chưa được (tệp lỗi để sau)
  updated_at  timestamptz not null default now(),
  updated_by  uuid default auth.uid(),
  primary key (tenant_id, name),
  check (name like tenant_id::text || '/%')
);
alter table public.file_store enable row level security;
revoke all on public.file_store from public, anon;
grant select, insert, update, delete on public.file_store to authenticated, service_role;

-- Chỉ trong nhà xe của mình (áp cho mọi thao tác)
create policy file_store_tenant on public.file_store as restrictive for all to authenticated
  using (tenant_id = app.current_tenant_id()) with check (tenant_id = app.current_tenant_id());

-- Chép quy tắc của kho cũ: cùng điều kiện theo tên tệp (thư mục nhà xe / loại / chủ…)
do $$
declare
  p record;
  q text;
  c text;
  n int := 0;
begin
  for p in select policyname, cmd, roles, qual, with_check from pg_policies
           where schemaname = 'storage' and tablename = 'objects'
             and (coalesce(qual, '') like '%giay-to%' or coalesce(with_check, '') like '%giay-to%') loop
    q := replace(p.qual, '(bucket_id = ''giay-to''::text)', 'true');
    c := replace(p.with_check, '(bucket_id = ''giay-to''::text)', 'true');
    if coalesce(q, '') ~ '(bucket_id|owner|metadata|objects\.)' or coalesce(c, '') ~ '(bucket_id|owner|metadata|objects\.)' then
      raise exception 'Không chép được quy tắc % của kho tệp', p.policyname;
    end if;
    execute format('create policy %I on public.file_store for %s to %s %s %s',
      'f_' || p.policyname, p.cmd, array_to_string(p.roles, ', '),
      case when q is not null then format('using (%s)', q) else '' end,
      case when c is not null then format('with check (%s)', c) else '' end);
    n := n + 1;
  end loop;
  if n < 10 then raise exception 'Thiếu quy tắc kho tệp (mới thấy %)', n; end if;
end;
$$;

-- Ghi các tệp đang có ở kho cũ (chưa có trong bảng) cho 1 nhà xe; null = mọi nhà xe. Dùng khi chuyển + bắt tệp do app bản cũ tải lên.
create function public.svc_file_backfill(p_tenant uuid)
returns int
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  insert into public.file_store (tenant_id, name, drive_id, mime, size_bytes, updated_at, updated_by)
  select t.id, o.name, null, o.metadata ->> 'mimetype', nullif(o.metadata ->> 'size', '')::bigint, coalesce(o.updated_at, o.created_at, now()), o.owner
  from storage.objects o
  join public.tenants t on t.id::text = split_part(o.name, '/', 1)
  where o.bucket_id = 'giay-to' and (p_tenant is null or t.id = p_tenant) and o.name !~ '\.\.'
    and o.name not like '%/.emptyFolderPlaceholder'
  on conflict (tenant_id, name) do nothing;
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function public.svc_file_backfill(uuid) from public, anon, authenticated;
grant execute on function public.svc_file_backfill(uuid) to service_role;

select public.svc_file_backfill(null);

-- Dung lượng: thêm số tệp / dung lượng đã chuyển lên Drive của nhà xe (giữ nguyên quyền xem hiện có)
do $$
declare v text;
begin
  select pg_get_functiondef('public.storage_usage()'::regprocedure) into v;
  v := replace(v, '''drive_bytes'', (select coalesce(sum(size_bytes), 0) from public.archive_items where tenant_id = v_tid and kind = ''file'')',
    '''drive_bytes'', (select coalesce(sum(size_bytes), 0) from public.archive_items where tenant_id = v_tid and kind = ''file''),
    ''drive_files'', (select count(*) from public.file_store where tenant_id = v_tid and drive_id is not null),
    ''drive_files_bytes'', (select coalesce(sum(size_bytes), 0) from public.file_store where tenant_id = v_tid and drive_id is not null)');
  if v not like '%drive_files_bytes%' then raise exception 'Không sửa được storage_usage'; end if;
  execute v;
end;
$$;
