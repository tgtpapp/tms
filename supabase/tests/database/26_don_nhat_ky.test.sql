-- Kiểm thử dọn nhật ký thao tác: chỉ xóa bản cũ hơn 90 ngày, không đụng bản gần đây.
begin;
create extension if not exists pgtap with schema extensions;
select * from no_plan();
insert into public.audit_logs (tenant_id, action, entity, created_at) values
  (null, 'test_cu', 'thu', now() - interval '120 days'),
  (null, 'test_moi', 'thu', now() - interval '10 days');
select ok(app.svc_purge_audit() >= 1, 'Có xóa bản cũ');
select is((select count(*)::int from public.audit_logs where action = 'test_cu'), 0, 'Bản cũ hơn 90 ngày đã xóa');
select is((select count(*)::int from public.audit_logs where action = 'test_moi'), 1, 'Bản gần đây còn giữ');
set local role authenticated;
select throws_ok($$ select app.svc_purge_audit() $$, '42501', null, 'Người dùng không gọi được hàm dọn');
reset role;
select * from finish();
rollback;
