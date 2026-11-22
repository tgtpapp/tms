-- Dọn nhật ký sinh ra do các đợt nhập / sửa hàng loạt (chuyển dữ liệu app cũ, nhập lịch, bản cập nhật hệ thống):
-- giờ nào có trên 500 dòng nhật ký là đợt hàng loạt, không phải thao tác tay của nhân viên. Chủ nhà xe duyệt 22/11/2026.
-- Không đụng sổ cái tiền, lịch sử vé, dữ liệu nghiệp vụ.
delete from public.audit_logs a
where (a.tenant_id, date_trunc('hour', a.created_at)) in (
  select tenant_id, date_trunc('hour', created_at) from public.audit_logs group by 1, 2 having count(*) > 500);
