-- Xóa hẳn giấy tờ / dòng lý lịch BỊ TRÙNG (cùng 1 giấy tải lên 2 lần). Chỉ xóa được khi máy chủ xác nhận có bản trùng còn lại,
-- nên không xóa nhầm giấy duy nhất. Hàm mới, không đổi bảng / RLS / hàm cũ.
--  'ly_lich' : dòng lý lịch trùng 1 dòng lý lịch khác (cùng loại + cùng số giấy hoặc cùng ngày)
--              hoặc trùng giấy ở mục Giấy tờ (Theo dõi sức khỏe ↔ Giấy khám SK, Đào tạo ↔ Giấy tập huấn: cùng số / ngày cấp / hạn)
--  'giay_to' : bản giấy tờ CŨ (không phải bản đang dùng) trùng 1 bản khác cùng loại (cùng số, hoặc cùng ngày cấp + hạn)
create or replace function app.paper_no(p_no text, p_title text)
returns text language sql immutable set search_path = '' as $$
  select nullif(upper(regexp_replace(coalesce(nullif(trim(p_no), ''), substring(coalesce(p_title, '') from '(?i)s[ốo]\s*:?\s*([0-9A-Za-z/.\-]+)'), ''), '[^0-9A-Za-z]', '', 'g')), '')
$$;
revoke execute on function app.paper_no(text, text) from public;

create function public.delete_duplicate_paper(p_kind text, p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  r public.staff_records;
  d public.documents;
  v_no text;
  v_type text;
begin
  if v_tid is null then raise exception 'Không có quyền' using errcode = '42501'; end if;
  if p_kind = 'ly_lich' then
    select * into r from public.staff_records where id = p_id and tenant_id = v_tid;
    if not found then raise exception 'Không tìm thấy' using errcode = 'P0002'; end if;
    if not app.has_permission('staff.edit') then raise exception 'Không có quyền sửa lý lịch' using errcode = '42501'; end if;
    v_no := app.paper_no(r.doc_no, r.title);
    v_type := case r.kind when 'suc_khoe' then 'kham_suc_khoe' when 'dao_tao' then 'tap_huan' end;
    if not exists (select 1 from public.staff_records x where x.tenant_id = v_tid and x.staff_id = r.staff_id and x.kind = r.kind and x.id <> r.id
                     and (x.occurred_on = r.occurred_on or (v_no is not null and app.paper_no(x.doc_no, x.title) = v_no)))
       and not (v_type is not null and exists (select 1 from public.documents g where g.tenant_id = v_tid and g.staff_id = r.staff_id and g.doc_type = v_type
                     and ((v_no is not null and app.paper_no(g.doc_no, null) = v_no) or g.issued_on = r.occurred_on
                          or (g.expires_on is not null and g.expires_on::text = r.data ->> 'het_han')))) then
      raise exception 'Dòng lý lịch này không trùng giấy nào, không xóa' using errcode = '22023';
    end if;
    delete from public.staff_records where id = r.id;
  elsif p_kind = 'giay_to' then
    select * into d from public.documents where id = p_id and tenant_id = v_tid;
    if not found then raise exception 'Không tìm thấy' using errcode = 'P0002'; end if;
    if not app.can_manage_documents(d.owner_kind) then raise exception 'Không có quyền quản lý giấy tờ' using errcode = '42501'; end if;
    if d.is_current then raise exception 'Bản đang dùng không xóa được' using errcode = '22023'; end if;
    v_no := app.paper_no(d.doc_no, null);
    if not exists (select 1 from public.documents x where x.tenant_id = v_tid and x.id <> d.id and x.doc_type = d.doc_type
                     and x.staff_id is not distinct from d.staff_id and x.vehicle_id is not distinct from d.vehicle_id
                     and ((v_no is not null and app.paper_no(x.doc_no, null) = v_no and x.expires_on is not distinct from d.expires_on)
                          or (x.issued_on is not distinct from d.issued_on and x.expires_on is not distinct from d.expires_on
                              and (v_no is null or app.paper_no(x.doc_no, null) is null or app.paper_no(x.doc_no, null) = v_no)))) then
      raise exception 'Giấy này không trùng giấy nào, không xóa' using errcode = '22023';
    end if;
    delete from public.documents where id = d.id;
  else
    raise exception 'Loại không hợp lệ' using errcode = '22023';
  end if;
end;
$$;
revoke execute on function public.delete_duplicate_paper(text, uuid) from public, anon, authenticated;
grant execute on function public.delete_duplicate_paper(text, uuid) to authenticated;
