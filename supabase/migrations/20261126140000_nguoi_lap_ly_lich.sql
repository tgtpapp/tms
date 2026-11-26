-- =====================================================================
-- Lý lịch hành nghề: khi lái xe tự mở lý lịch của mình, ô NGƯỜI LẬP là người quản lý cập nhật hồ sơ / giấy tờ / lý lịch
-- của lái xe đó gần nhất (theo nhật ký thao tác, không tính chính lái xe); chưa có thì Chủ nhà xe.
-- Lái xe được đọc chữ ký của đúng người lập đó (để in đủ chữ ký), không đọc được chữ ký người khác.
-- Không đổi bảng.
-- =====================================================================

/** Người lập hồ sơ của 1 nhân viên: {user_id, staff_id, name} */
create function app.paper_maker_of(p_tid uuid, p_staff_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_self uuid; v_uid uuid; v_name text; v_sid uuid;
begin
  select user_id into v_self from public.staff_members where tenant_id = p_tid and id = p_staff_id;
  select l.actor_id into v_uid from public.audit_logs l
  join public.app_users a on a.id = l.actor_id and a.tenant_id = p_tid
  where l.tenant_id = p_tid and l.actor_id is not null and l.actor_id is distinct from v_self
    and ((l.entity in ('staff_members', 'staff_private') and (l.entity_id = p_staff_id::text
           or coalesce(l.detail -> 'new' ->> 'staff_id', l.detail -> 'old' ->> 'staff_id') = p_staff_id::text))
      or (l.entity in ('staff_records', 'documents') and coalesce(l.detail -> 'new' ->> 'staff_id', l.detail -> 'old' ->> 'staff_id') = p_staff_id::text))
  order by l.created_at desc limit 1;
  if v_uid is null then   -- chưa có ai cập nhật: Chủ nhà xe
    select ur.user_id into v_uid from public.user_roles ur join public.roles r on r.tenant_id = ur.tenant_id and r.id = ur.role_id and r.code = 'owner'
    join public.app_users a on a.id = ur.user_id and a.status = 'active'
    where ur.tenant_id = p_tid and ur.scope_type = 'tenant' order by ur.created_at limit 1;
  end if;
  if v_uid is null then return null; end if;
  select id, full_name into v_sid, v_name from public.staff_members where tenant_id = p_tid and user_id = v_uid limit 1;
  if v_name is null then select full_name into v_name from public.app_users where id = v_uid; end if;
  return jsonb_build_object('user_id', v_uid, 'staff_id', v_sid, 'name', coalesce(v_name, ''));
end;
$$;
revoke execute on function app.paper_maker_of(uuid, uuid) from public, anon, authenticated;

/** Trình duyệt: người lập lý lịch của chính mình (lái xe) hoặc của người khác (người xem được hồ sơ nhân sự) */
create function public.paper_maker(p_staff_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not (app.is_my_staff(p_staff_id::text) or app.has_permission('staff.view_all') or app.has_permission('staff.manage')) then
    raise exception 'Không tìm thấy nhân viên' using errcode = 'P0002';
  end if;
  return app.paper_maker_of(v_tid, p_staff_id);
end;
$$;
revoke execute on function public.paper_maker(uuid) from public, anon, authenticated;
grant execute on function public.paper_maker(uuid) to authenticated;

/** Tệp chữ ký của người lập lý lịch của chính mình: người dùng được đọc để in */
create function app.my_paper_maker_files()
returns text[]
language sql stable security definer set search_path = ''
as $$
  select coalesce(array_agg(f), '{}') from (
    select unnest(array[(m ->> 'user_id') || '.png', case when m ->> 'staff_id' is not null then 'nv_' || (m ->> 'staff_id') || '.png' end]) f
    from public.staff_members s, lateral (select app.paper_maker_of(s.tenant_id, s.id) m) x
    where s.tenant_id = app.current_tenant_id() and s.user_id = auth.uid() and m is not null) t
  where f is not null
$$;
revoke execute on function app.my_paper_maker_files() from public, anon;
grant execute on function app.my_paper_maker_files() to authenticated, service_role;

do $$
declare v text;
begin
  v := pg_get_functiondef('app.can_read_signature(text)'::regprocedure);
  v := replace(v, 'select app.has_permission(''order.add'')', 'select (p_file = any (app.my_paper_maker_files())) or app.has_permission(''order.add'')');
  if v not like '%my_paper_maker_files%' then raise exception 'Không sửa được can_read_signature'; end if;
  execute v;
end;
$$;
