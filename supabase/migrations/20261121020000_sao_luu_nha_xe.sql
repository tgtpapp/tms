-- =====================================================================
-- Sao lưu / khôi phục dữ liệu từng nhà xe.
-- - Xuất theo trang (bảng × khoảng dòng), mỗi trang có chữ ký HMAC của máy chủ gắn với đúng nhà xe:
--   file sao lưu không sửa / ghép tay được, không khôi phục sang nhà xe khác.
-- - Khôi phục: chỉ THÊM các dòng đang thiếu (on conflict do nothing), không ghi đè, không xóa, không sửa sổ tiền.
--   Không khôi phục tài khoản / nhóm quyền / phân quyền (tránh cấp lại quyền đã thu hồi).
-- - Chỉ Chủ nhà xe được tải và khôi phục. Bảng chứa mã bí mật (kết nối Drive, Zalo) không đưa vào file.
-- - Bản sao lưu mỗi đêm (lên Google Drive của nhà xe) ghi ở bảng tenant_backups.
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

-- Khóa ký file sao lưu: chỉ máy chủ biết (không cấp quyền cho ai)
create table app.backup_secret (id int primary key default 1 check (id = 1), secret bytea not null);
insert into app.backup_secret (secret) values (extensions.gen_random_bytes(32));
revoke all on app.backup_secret from public, anon, authenticated;

/** Người đang dùng là Chủ nhà xe (toàn nhà xe) */
create function app.is_tenant_owner()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (select 1 from public.user_roles ur join public.roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id and r.code = 'owner'
                 join public.app_users u on u.tenant_id = ur.tenant_id and u.id = ur.user_id and u.status = 'active'
                 where ur.tenant_id = app.current_tenant_id() and ur.user_id = auth.uid() and ur.scope_type = 'tenant')
$$;
revoke execute on function app.is_tenant_owner() from public, anon;
grant execute on function app.is_tenant_owner() to authenticated, service_role;

/** Các bảng của nhà xe theo thứ tự khôi phục (bảng cha trước). restore = false: chỉ xuất, không khôi phục. */
create function app.backup_tables()
returns table (tbl text, ord int, restore boolean)
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_all text[]; v_done text[] := '{}'; v_left text[]; v_next text[]; v_i int := 0; t text;
  v_skip text[] := array['tenant_drive', 'zalo_connections', 'zalo_oauth_states', 'audit_logs'];
  v_norestore text[] := array['app_users', 'user_roles', 'roles', 'role_permissions', 'user_permission_denies', 'tenant_backups'];
begin
  select array_agg(c.relname::text order by c.relname) into v_all
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
  where n.nspname = 'public' and c.relkind = 'r' and c.relname <> all (v_skip)
    and exists (select 1 from pg_attribute a where a.attrelid = c.oid and a.attname = 'tenant_id' and not a.attisdropped);
  v_left := v_all;
  while coalesce(cardinality(v_left), 0) > 0 loop
    -- bảng mà mọi bảng cha (trong danh sách) đã xếp trước
    select array_agg(x order by x) into v_next from unnest(v_left) x
    where not exists (
      select 1 from pg_constraint k join pg_class p on p.oid = k.confrelid
      where k.contype = 'f' and k.conrelid = ('public.' || quote_ident(x))::regclass
        and p.relname::text <> x and p.relname::text = any (v_left));
    if v_next is null then v_next := v_left; end if;   -- vòng tham chiếu: xếp nốt
    foreach t in array v_next loop
      v_i := v_i + 1; tbl := t; ord := v_i; restore := not (t = any (v_norestore)); return next;
    end loop;
    v_done := v_done || v_next;
    v_left := array(select x from unnest(v_left) x where x <> all (v_done));
  end loop;
end;
$$;
revoke execute on function app.backup_tables() from public, anon, authenticated;

create function app.backup_sig(p_tid uuid, p_table text, p_rows text)
returns text
language sql stable security definer set search_path = ''
as $$
  select encode(extensions.hmac(convert_to(p_tid::text || '|' || p_table || '|' || p_rows, 'UTF8'), (select secret from app.backup_secret), 'sha256'), 'hex')
$$;
revoke execute on function app.backup_sig(uuid, text, text) from public, anon, authenticated;

/** Một trang dữ liệu của nhà xe: tối đa p_limit dòng sau vị trí p_after (ctid). Sổ cái: kèm đủ dòng của mỗi bút toán. */
create function app.backup_page_for(p_tid uuid, p_table text, p_after text, p_limit int)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_rows text; v_last text; v_n int; v_lim int := least(greatest(coalesce(p_limit, 1000), 1), 5000);
begin
  if not exists (select 1 from app.backup_tables() b where b.tbl = p_table) then
    raise exception 'Bảng không thuộc bản sao lưu: %', p_table using errcode = '22023';
  end if;
  execute format(
    'with pg as (select ctid c, t.* from public.%I t where tenant_id = $1 and ctid > $2::tid order by ctid limit $3)
     select (select max(c)::text from pg), (select count(*) from pg)::int', p_table)
    into v_last, v_n using p_tid, coalesce(p_after, '(0,0)'), v_lim;
  if v_n = 0 then
    return jsonb_build_object('rows', '[]', 'sig', app.backup_sig(p_tid, p_table, '[]'), 'last', null, 'n', 0);
  end if;
  if p_table = 'ledger_lines' then
    execute 'select coalesce(jsonb_agg(to_jsonb(l) order by l.id), ''[]'')::text from public.ledger_lines l where l.tenant_id = $1 and l.txn_id in
               (select txn_id from public.ledger_lines where tenant_id = $1 and ctid > $2::tid and ctid <= $3::tid)'
      into v_rows using p_tid, coalesce(p_after, '(0,0)'), v_last;
  else
    execute format('select coalesce(jsonb_agg(to_jsonb(t) - ''ctid''), ''[]'')::text from (select * from public.%I where tenant_id = $1 and ctid > $2::tid and ctid <= $3::tid) t', p_table)
      into v_rows using p_tid, coalesce(p_after, '(0,0)'), v_last;
  end if;
  return jsonb_build_object('rows', v_rows, 'sig', app.backup_sig(p_tid, p_table, v_rows), 'last', v_last, 'n', v_n);
end;
$$;
revoke execute on function app.backup_page_for(uuid, text, text, int) from public, anon, authenticated;

/** Danh sách bảng cho trình duyệt (Chủ nhà xe) */
create function public.backup_tables()
returns table (tbl text, ord int, restore boolean)
language plpgsql stable security definer set search_path = ''
as $$
begin
  if app.current_tenant_id() is null or not app.is_tenant_owner() then
    raise exception 'Chỉ Chủ nhà xe được sao lưu / khôi phục' using errcode = '42501';
  end if;
  return query select * from app.backup_tables();
end;
$$;
revoke execute on function public.backup_tables() from public, anon, authenticated;
grant execute on function public.backup_tables() to authenticated, service_role;

create function public.backup_page(p_table text, p_after text, p_limit int)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
begin
  if app.current_tenant_id() is null or not app.is_tenant_owner() then
    raise exception 'Chỉ Chủ nhà xe được sao lưu / khôi phục' using errcode = '42501';
  end if;
  return app.backup_page_for(app.current_tenant_id(), p_table, p_after, p_limit);
end;
$$;
revoke execute on function public.backup_page(text, text, int) from public, anon, authenticated;
grant execute on function public.backup_page(text, text, int) to authenticated, service_role;

/** Khôi phục 1 trang: kiểm chữ ký, chỉ thêm dòng còn thiếu của chính nhà xe. Trả {added, skipped, failed}. */
create function public.restore_page(p_table text, p_rows text, p_sig text)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id(); v_rows jsonb; v_cols text; v_ov text := ''; v_n int; v_total int; v_add int := 0; v_fail int := 0; e jsonb;
begin
  if v_tid is null or not app.is_tenant_owner() then
    raise exception 'Chỉ Chủ nhà xe được sao lưu / khôi phục' using errcode = '42501';
  end if;
  if not exists (select 1 from app.backup_tables() b where b.tbl = p_table and b.restore) then
    return jsonb_build_object('added', 0, 'skipped', 0, 'failed', 0);   -- bảng không khôi phục (tài khoản, phân quyền…)
  end if;
  if p_sig is null or p_sig <> app.backup_sig(v_tid, p_table, p_rows) then
    raise exception 'File sao lưu không đúng của nhà xe này hoặc đã bị sửa' using errcode = '22023';
  end if;
  v_rows := p_rows::jsonb;
  v_total := jsonb_array_length(v_rows);
  if v_total = 0 then return jsonb_build_object('added', 0, 'skipped', 0, 'failed', 0); end if;
  -- cột ghi được (bỏ cột tự sinh), giữ nguyên mã cột tự tăng
  select string_agg(quote_ident(a.attname), ', ' order by a.attnum), bool_or(a.attidentity = 'a')
    into v_cols, v_ov
  from pg_attribute a where a.attrelid = ('public.' || quote_ident(p_table))::regclass and a.attnum > 0 and not a.attisdropped and a.attgenerated = '';
  v_ov := case when v_ov = 'true' then 'overriding system value' else '' end;
  v_rows := (select jsonb_agg(x || jsonb_build_object('tenant_id', v_tid)) from jsonb_array_elements(v_rows) x);
  begin
    execute format('insert into public.%I (%s) %s select %s from jsonb_populate_recordset(null::public.%I, $1) on conflict do nothing',
                   p_table, v_cols, v_ov, v_cols, p_table) using v_rows;
    get diagnostics v_add = row_count;
  exception when others then
    -- có dòng lỗi (thiếu dòng cha…): thêm từng dòng, bỏ qua dòng lỗi
    v_add := 0;
    for e in select * from jsonb_array_elements(v_rows) loop
      begin
        execute format('insert into public.%I (%s) %s select %s from jsonb_populate_record(null::public.%I, $1) on conflict do nothing',
                       p_table, v_cols, v_ov, v_cols, p_table) using e;
        get diagnostics v_n = row_count;
        v_add := v_add + v_n;
      exception when others then
        v_fail := v_fail + 1;
      end;
    end loop;
  end;
  return jsonb_build_object('added', v_add, 'skipped', v_total - v_add - v_fail, 'failed', v_fail);
end;
$$;
revoke execute on function public.restore_page(text, text, text) from public, anon, authenticated;
grant execute on function public.restore_page(text, text, text) to authenticated, service_role;

-- Bản sao lưu đã lưu lên Google Drive của nhà xe (mỗi đêm hoặc bấm tay)
create table public.tenant_backups (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id),
  kind        text not null check (kind in ('dem', 'tay')),
  drive_id    text not null,
  file_name   text not null,
  size_bytes  bigint,
  row_count   int,
  created_at  timestamptz not null default now(),
  unique (tenant_id, id)
);
create index tenant_backups_tenant_idx on public.tenant_backups (tenant_id, created_at desc);
alter table public.tenant_backups enable row level security;
create policy tenant_backups_select on public.tenant_backups for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_tenant_owner());
grant select on public.tenant_backups to authenticated;
grant select, insert, delete on public.tenant_backups to service_role;
