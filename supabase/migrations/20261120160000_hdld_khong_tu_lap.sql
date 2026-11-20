-- =====================================================================
-- Hợp đồng lao động: nhân viên chỉ XEM bản PDF hợp đồng của mình; không ai tự lập / sửa / hủy hợp đồng của chính mình
-- (kể cả người có quyền Hợp đồng lao động: Thêm / Sửa / Xóa).
-- =====================================================================
do $$
declare f record; v text;
begin
  for f in select pr.oid, pr.proname from pg_proc pr join pg_namespace n on n.oid = pr.pronamespace
           where n.nspname = 'public' and pr.proname in ('save_labor_contract', 'cancel_labor_contract')
  loop
    v := pg_get_functiondef(f.oid);
    if f.proname = 'save_labor_contract' then
      v := replace(v, '  if p_start_on is null or p_kind is null',
        '  if exists (select 1 from public.staff_members where tenant_id = v_tid and id = p_staff_id and user_id = auth.uid()) then
    raise exception ''Không tự lập / sửa hợp đồng lao động của chính mình'' using errcode = ''42501'';
  end if;
  if p_start_on is null or p_kind is null');
    else
      v := replace(v, '  if nullif(trim(p_reason), '''') is null then',
        '  if exists (select 1 from public.labor_contracts k join public.staff_members s on s.tenant_id = k.tenant_id and s.id = k.staff_id
             where k.tenant_id = v_tid and k.id = p_id and s.user_id = auth.uid()) then
    raise exception ''Không tự hủy hợp đồng lao động của chính mình'' using errcode = ''42501'';
  end if;
  if nullif(trim(p_reason), '''') is null then');
    end if;
    if v not like '%của chính mình%' then raise exception 'Không chèn được kiểm tra vào %', f.proname; end if;
    execute v;
  end loop;
end;
$$;
