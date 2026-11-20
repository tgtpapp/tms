-- =====================================================================
-- Phân quyền riêng từng người: sửa được mọi ô trong bảng quyền của 1 người.
-- - Tích thêm ô ngoài nhóm  → quyền riêng (nhóm ẩn "rieng_…" của người đó, toàn nhà xe).
-- - Bỏ tích ô có từ nhóm     → chặn riêng người đó (user_permission_denies), người khác trong nhóm không ảnh hưởng.
-- - Không sửa được quyền của chính mình và của Chủ nhà xe; không cấp vượt quyền của mình.
-- =====================================================================
create table public.user_permission_denies (
  tenant_id        uuid not null,
  user_id          uuid not null,
  permission_code  text not null references public.permissions (code) on delete cascade,
  created_at       timestamptz not null default now(),
  created_by       uuid default auth.uid(),
  primary key (tenant_id, user_id, permission_code),
  foreign key (tenant_id, user_id) references public.app_users (tenant_id, id) on delete cascade
);
create trigger user_permission_denies_audit after insert or update or delete on public.user_permission_denies for each row execute function app.write_audit();
alter table public.user_permission_denies enable row level security;
revoke all on public.user_permission_denies from public, anon, authenticated;
grant select on public.user_permission_denies to authenticated;
grant select, insert, update, delete on public.user_permission_denies to service_role;
create policy user_permission_denies_select on public.user_permission_denies for select to authenticated
  using (tenant_id = app.current_tenant_id() and (user_id = auth.uid() or app.has_permission('user.view')));

-- Kiểm tra quyền: có trong nhóm (đúng phạm vi) và không bị chặn riêng
create or replace function app.has_permission(p_perm text, p_branch_id uuid default null, p_office_id uuid default null)
returns boolean
language sql stable security definer set search_path = ''
as $$
  with me as (select app.current_tenant_id() as tid),
  office_branch as (
    select o.branch_id from public.ticket_offices o, me
    where p_office_id is not null and o.id = p_office_id and o.tenant_id = me.tid
  )
  select exists (
    select 1
    from me
    join public.user_roles ur on ur.tenant_id = me.tid and ur.user_id = auth.uid()
    join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
    where rp.permission_code = p_perm
      and (
        ur.scope_type = 'tenant'
        or (ur.scope_type = 'branch' and ur.scope_id = p_branch_id)
        or (ur.scope_type = 'branch' and ur.scope_id in (select branch_id from office_branch))
        or (ur.scope_type = 'ticket_office' and ur.scope_id = p_office_id)
      )
  ) and not exists (
    select 1 from public.user_permission_denies d, me
    where d.tenant_id = me.tid and d.user_id = auth.uid() and d.permission_code = p_perm
  )
$$;

create or replace function app.my_tenant_permissions()
returns setof text
language sql stable security definer set search_path = ''
as $$
  select distinct rp.permission_code
  from public.user_roles ur
  join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
  where ur.user_id = auth.uid()
    and ur.tenant_id = app.current_tenant_id()
    and ur.scope_type = 'tenant'
    and not exists (select 1 from public.user_permission_denies d
                    where d.tenant_id = ur.tenant_id and d.user_id = ur.user_id and d.permission_code = rp.permission_code)
$$;

create or replace function public.my_permissions()
returns table (permission_code text, scope_type text, scope_id uuid)
language sql stable security definer set search_path = ''
as $$
  select rp.permission_code, ur.scope_type, ur.scope_id
  from public.user_roles ur
  join public.role_permissions rp on rp.tenant_id = ur.tenant_id and rp.role_id = ur.role_id
  where ur.user_id = auth.uid()
    and ur.tenant_id = app.current_tenant_id()
    and not exists (select 1 from public.user_permission_denies d
                    where d.tenant_id = ur.tenant_id and d.user_id = ur.user_id and d.permission_code = rp.permission_code)
$$;

/** Lưu bảng quyền của 1 người: p_grants = ô tích thêm ngoài nhóm, p_denies = ô của nhóm bị bỏ tích riêng người này. */
create function public.set_user_permissions(p_user_id uuid, p_grants text[], p_denies text[])
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.require_user_manager(p_user_id);   -- cần Người dùng: Sửa, người đó thuộc nhà xe này
  v_code text := 'rieng_' || left(replace(p_user_id::text, '-', ''), 24);
  v_role uuid;
  v_name text;
begin
  if p_user_id = auth.uid() then
    raise exception 'Không tự sửa quyền của chính mình' using errcode = '42501';
  end if;
  if exists (select 1 from public.user_roles ur join public.roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id
             where ur.tenant_id = v_tid and ur.user_id = p_user_id and r.code = 'owner') then
    raise exception 'Không sửa quyền của Chủ nhà xe' using errcode = '42501';
  end if;
  if exists (select unnest(coalesce(p_grants, '{}')) except select app.my_tenant_permissions()) then
    raise exception 'Không được cấp quyền vượt quá quyền của mình' using errcode = '42501';
  end if;
  if exists (select unnest(coalesce(p_grants, '{}') || coalesce(p_denies, '{}')) except select code from public.permissions) then
    raise exception 'Quyền không hợp lệ' using errcode = '22023';
  end if;

  select full_name into v_name from public.app_users where tenant_id = v_tid and id = p_user_id;
  insert into public.roles (tenant_id, code, name) values (v_tid, v_code, left('Riêng: ' || v_name, 80))
  on conflict (tenant_id, code) do update set name = excluded.name
  returning id into v_role;
  delete from public.role_permissions where tenant_id = v_tid and role_id = v_role;
  insert into public.role_permissions (tenant_id, role_id, permission_code)
  select distinct v_tid, v_role, unnest(coalesce(p_grants, '{}'));
  insert into public.user_roles (tenant_id, user_id, role_id, scope_type, scope_id, created_by)
  values (v_tid, p_user_id, v_role, 'tenant', null, auth.uid())
  on conflict do nothing;

  delete from public.user_permission_denies where tenant_id = v_tid and user_id = p_user_id;
  insert into public.user_permission_denies (tenant_id, user_id, permission_code)
  select distinct v_tid, p_user_id, unnest(coalesce(p_denies, '{}'));
end;
$$;
revoke execute on function public.set_user_permissions(uuid, text[], text[]) from public, anon, authenticated;
grant execute on function public.set_user_permissions(uuid, text[], text[]) to authenticated;
