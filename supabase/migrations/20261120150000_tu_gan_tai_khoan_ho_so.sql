-- =====================================================================
-- Tự gắn tài khoản đăng nhập với hồ sơ lái xe / nhân viên theo số điện thoại.
-- Lý do: "của chính mình" (Việc của tôi, hồ sơ, lý lịch, hợp đồng, ảnh, chữ ký…) xác định qua hồ sơ gắn tài khoản;
-- tạo tài khoản ở Người dùng mà quên chọn ở hồ sơ thì lái xe không thấy gì.
-- Quy tắc: số điện thoại của tài khoản = số trong hồ sơ, đúng 1 hồ sơ chưa gắn ai, tài khoản chưa gắn hồ sơ nào → tự gắn.
-- Không ghi đè hồ sơ đã gắn tài khoản khác.
-- =====================================================================

-- Dữ liệu đang có
update public.staff_members s set user_id = u.id
from public.app_users u
where s.tenant_id = u.tenant_id and s.user_id is null and s.phone = u.phone
  and (select count(*) from public.staff_members x where x.tenant_id = s.tenant_id and x.phone = s.phone) = 1
  and not exists (select 1 from public.staff_members x where x.tenant_id = u.tenant_id and x.user_id = u.id);

-- Hồ sơ thêm / sửa mà để trống tài khoản: tự gắn theo số điện thoại
create function app.staff_auto_link()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.user_id is null and new.phone is not null then
    select u.id into new.user_id from public.app_users u
    where u.tenant_id = new.tenant_id and u.phone = new.phone
      and not exists (select 1 from public.staff_members x where x.tenant_id = u.tenant_id and x.user_id = u.id and x.id <> new.id)
      and (select count(*) from public.staff_members x where x.tenant_id = new.tenant_id and x.phone = new.phone and x.id <> new.id) = 0
    limit 1;
  end if;
  return new;
end;
$$;
create trigger staff_members_auto_link before insert or update on public.staff_members
  for each row execute function app.staff_auto_link();

-- Tài khoản mới tạo (hoặc đổi số): tự gắn vào hồ sơ trùng số
create function app.user_auto_link()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if not exists (select 1 from public.staff_members x where x.tenant_id = new.tenant_id and x.user_id = new.id)
     and (select count(*) from public.staff_members x where x.tenant_id = new.tenant_id and x.phone = new.phone) = 1 then
    update public.staff_members set user_id = new.id
    where tenant_id = new.tenant_id and phone = new.phone and user_id is null;
  end if;
  return new;
end;
$$;
create trigger app_users_auto_link after insert or update of phone on public.app_users
  for each row execute function app.user_auto_link();
revoke execute on function app.staff_auto_link(), app.user_auto_link() from public, anon, authenticated;
