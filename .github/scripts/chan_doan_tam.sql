\pset pager off
-- Hồ sơ "Nguyễn Thị Qu?": tên hiện tại kết thúc chữ gì, các lần sửa tên gần đây (chỉ in chữ cuối, không in cả tên)
select right(full_name, 2) cuoi_ten, user_id is not null co_tk, updated_at from public.staff_members where full_name like 'Nguyễn Thị Qu%';
select a.created_at, a.action, right(a.detail -> 'old' ->> 'full_name', 2) cu, right(a.detail -> 'new' ->> 'full_name', 2) moi, jsonb_object_keys(a.detail) k
from public.audit_logs a where a.entity = 'staff_members' and a.entity_id in (select id::text from public.staff_members where full_name like 'Nguyễn Thị Qu%')
order by a.created_at desc limit 8;
select a.created_at, a.action, left(a.detail::text, 0) x, (select string_agg(k, ',') from jsonb_object_keys(a.detail) k) keys from public.audit_logs a
where a.entity = 'staff_members' order by a.created_at desc limit 3;
