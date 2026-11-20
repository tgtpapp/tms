-- =====================================================================
-- Xếp xe (cả nhập lịch Vexere):
-- 1) Lỗi giấy tờ / pháp lý (GPLX hết hạn, sai hạng, khám sức khỏe hết hạn, giấy tờ xe hết hạn, quá tuổi, quá niên hạn,
--    xe ngừng dùng, xe chỉ chạy hợp đồng, người đã nghỉ việc, không phải lái xe) chuyển thành CẢNH BÁO: hiện ra, vẫn cho lưu.
--    Chỉ còn chặn: xe / người đã có chuyến khác chồng giờ (không thể chạy 2 chuyến cùng lúc).
-- 2) Giấy khám sức khỏe và giấy tập huấn: tính cả dòng "Theo dõi sức khỏe" / "Đào tạo, tập huấn" trong Lý lịch hành nghề
--    (dữ liệu chuyển từ app cũ nằm ở đây), lấy ngày hết hạn xa nhất. Trước đây chỉ đọc mục Giấy tờ nên báo thiếu sai.
-- =====================================================================

/** Giấy hiện hành của nhân viên theo loại, gộp cả Lý lịch hành nghề (sức khỏe → kham_suc_khoe, đào tạo → tap_huan).
    Trả 0 hoặc 1 dòng; expires_on = ngày hết hạn xa nhất. */
create function app.staff_paper(p_tid uuid, p_staff uuid, p_type text)
returns setof public.documents
language plpgsql stable security definer set search_path = ''
as $$
declare
  v public.documents;
  v_kind text := case p_type when 'kham_suc_khoe' then 'suc_khoe' when 'tap_huan' then 'dao_tao' end;
  v_has boolean := false;
  v_exp date;
begin
  select * into v from public.documents where tenant_id = p_tid and staff_id = p_staff and doc_type = p_type and is_current limit 1;
  if v_kind is not null then
    select true, max(case when r.data ->> 'het_han' ~ '^\d{4}-\d{2}-\d{2}$' then (r.data ->> 'het_han')::date end)
      into v_has, v_exp
    from public.staff_records r where r.tenant_id = p_tid and r.staff_id = p_staff and r.kind = v_kind
    having count(*) > 0;
  end if;
  if v.id is null and not coalesce(v_has, false) then
    return;
  end if;
  if v.id is null then
    v.tenant_id := p_tid; v.staff_id := p_staff; v.owner_kind := 'nhan_su'; v.doc_type := p_type; v.is_current := true; v.expires_on := v_exp;
  elsif v.expires_on is not null and v_exp is not null and v_exp > v.expires_on then
    v.expires_on := v_exp;
  end if;
  return next v;
end;
$$;
revoke execute on function app.staff_paper(uuid, uuid, text) from public, anon, authenticated;

do $$
declare v text; n int;
begin
  select pg_get_functiondef('public.assign_trip(uuid, uuid, uuid, uuid, uuid, text)'::regprocedure) into v;
  -- mọi lỗi chặn → cảnh báo, trừ trùng giờ
  v := replace(v, 'v_block := v_block ||', 'v_warn := v_warn ||');
  v := replace(v, 'v_warn := v_warn || format(''Xe %s đã có chuyến khác lúc %s''', 'v_block := v_block || format(''Xe %s đã có chuyến khác lúc %s''');
  v := replace(v, 'v_warn := v_warn || format(''%s đã có chuyến khác chồng giờ''', 'v_block := v_block || format(''%s đã có chuyến khác chồng giờ''');
  -- khám sức khỏe / tập huấn: gộp lý lịch
  v := replace(v, 'select * into v_doc from public.documents where tenant_id = v_tid and staff_id = v_s.id and doc_type = ''kham_suc_khoe'' and is_current;',
                  'select * into v_doc from app.staff_paper(v_tid, v_s.id, ''kham_suc_khoe'');');
  v := replace(v, 'select * into v_doc from public.documents where tenant_id = v_tid and staff_id = v_s.id and doc_type = ''tap_huan'' and is_current;',
                  'select * into v_doc from app.staff_paper(v_tid, v_s.id, ''tap_huan'');');
  n := (length(v) - length(replace(v, 'v_block := v_block ||', ''))) / length('v_block := v_block ||');
  if n <> 2 or v not like '%app.staff_paper(v_tid, v_s.id, ''kham_suc_khoe'')%' or v not like '%app.staff_paper(v_tid, v_s.id, ''tap_huan'')%' then
    raise exception 'Không sửa được assign_trip (còn % chỗ chặn)', n;
  end if;
  execute v;
end;
$$;
