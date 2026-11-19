-- =====================================================================
-- Nhật ký thao tác chỉ giữ 90 ngày gần nhất (chủ nhà xe chốt 19/11/2026: cũ hơn xóa hẳn, không lưu ra ngoài).
-- Số ngày giữ đổi được theo nhà xe bằng cấu hình 'nhat_ky.giu_ngay' (mặc định 90). Chạy mỗi đêm bằng pg_cron.
-- Không đụng sổ cái tiền (ledger_*), lịch sử vé (ticket_history) và dữ liệu nghiệp vụ.
-- =====================================================================
create function app.svc_purge_audit()
returns int
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  delete from public.audit_logs a
  where a.created_at < now() - make_interval(days => greatest(30, case when a.tenant_id is null then 90
                                                                 else app.setting_int(a.tenant_id, 'nhat_ky.giu_ngay', 90) end));
  get diagnostics n = row_count;
  return n;
end;
$$;
revoke execute on function app.svc_purge_audit() from public, anon, authenticated;
grant execute on function app.svc_purge_audit() to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.schedule('don-nhat-ky-thao-tac', '20 17 * * *', 'select app.svc_purge_audit()');  -- 00:20 giờ VN
  else
    raise notice 'Máy chủ không có pg_cron: nhật ký thao tác không tự dọn';
  end if;
exception when others then
  raise notice 'Không đặt được lịch dọn nhật ký (%)', sqlerrm;
end;
$$;
