-- =====================================================================
-- Lái xe / nhân viên xem được dòng lương chuyển khoản, BHXH, lương cố định của chính mình (Công & lương của tôi,
-- phiếu lương như app cũ). Người khác vẫn cần quyền Xem bảng lương.
-- =====================================================================
create policy staff_pay_months_select_mine on public.staff_pay_months for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.is_my_staff(staff_id::text));
