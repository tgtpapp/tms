-- =====================================================================
-- Chuyển hợp đồng vận chuyển (hdvc) từ app cũ. Hợp đồng cũ có thể thiếu SĐT bên thuê nên cho phép để trống SĐT
-- (màn hình nhập mới vẫn bắt buộc). Hợp đồng đã qua giờ trả khách → "Xong"; còn lại → "Nháp" để điều hành kiểm tra rồi ký.
-- Không ghi tiền vào sổ cái (tiền đã thu ở app cũ); giữ nguyên số hợp đồng, nhập lại không trùng.
-- =====================================================================
alter table public.charters alter column customer_phone drop not null;

create function public.import_legacy_charters(p_rows jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  r jsonb;
  v_id uuid;
  v_start timestamptz; v_end timestamptz;
  v_veh uuid; v_d1 uuid; v_d2 uuid;
  n_new int := 0; n_same int := 0;
  v_err jsonb := '[]';
begin
  if v_tid is null or not app.has_permission('trip.manage') then
    raise exception 'Không có quyền điều hành' using errcode = '42501';
  end if;
  if jsonb_typeof(p_rows) <> 'array' or jsonb_array_length(p_rows) > 500 then
    raise exception 'Mỗi lần tối đa 500 hợp đồng' using errcode = '22023';
  end if;
  for r in select * from jsonb_array_elements(p_rows) loop
    begin
      if exists (select 1 from public.charters where tenant_id = v_tid and contract_no = r ->> 'contract_no') then
        n_same := n_same + 1; continue;
      end if;
      v_start := (r ->> 'start_at')::timestamptz;
      v_end := (r ->> 'end_at')::timestamptz;
      v_veh := (select id from public.vehicles where tenant_id = v_tid and id = nullif(r ->> 'vehicle_id', '')::uuid);
      v_d1 := (select id from public.staff_members where tenant_id = v_tid and id = nullif(r ->> 'driver1_id', '')::uuid);
      v_d2 := (select id from public.staff_members where tenant_id = v_tid and id = nullif(r ->> 'driver2_id', '')::uuid);
      insert into public.charters (tenant_id, code, contract_no, signed_on, customer_name, customer_phone, customer_tax_code, customer_address,
                                   customer_email, pickup_place, destination, itinerary, start_at, end_at, passengers, vehicle_id, driver1_id,
                                   driver2_id, price, deposit, status, note, distance_km, payment_terms, toll_by, meals_by, attendant, round_trip, created_by)
      values (v_tid, 'HD' || to_char(app.local_today(), 'YYMMDD') || lpad((floor(random() * 10000))::int::text, 4, '0'),
              trim(r ->> 'contract_no'), nullif(r ->> 'signed_on', '')::date, trim(r ->> 'customer_name'),
              nullif(regexp_replace(coalesce(r ->> 'customer_phone', ''), '[^0-9]', '', 'g'), ''),
              nullif(trim(r ->> 'customer_tax_code'), ''), nullif(trim(r ->> 'customer_address'), ''), nullif(trim(r ->> 'customer_email'), ''),
              trim(r ->> 'pickup_place'), trim(r ->> 'destination'), nullif(trim(r ->> 'itinerary'), ''), v_start, v_end,
              least(greatest(coalesce((r ->> 'pax_count')::int, 1), 1), 100), v_veh, v_d1, case when v_d2 is distinct from v_d1 then v_d2 end,
              greatest(coalesce((r ->> 'price')::int, 0), 0), 0, case when v_end < now() then 'xong' else 'nhap' end,
              coalesce(nullif(trim(r ->> 'note'), ''), 'Nhập từ app cũ'), nullif(r ->> 'distance_km', '')::int, nullif(trim(r ->> 'payment_terms'), ''),
              nullif(r ->> 'toll_by', ''), nullif(r ->> 'meals_by', ''), nullif(trim(r ->> 'attendant'), ''), coalesce((r ->> 'round_trip')::boolean, true),
              auth.uid())
      returning id into v_id;
      insert into public.charter_passengers (tenant_id, charter_id, seq, full_name, phone, birth_year)
      select v_tid, v_id, x.ord, trim(x.e ->> 'full_name'), nullif(regexp_replace(coalesce(x.e ->> 'phone', ''), '[^0-9]', '', 'g'), ''),
             nullif(x.e ->> 'birth_year', '')::int
      from jsonb_array_elements(coalesce(r -> 'passengers', '[]')) with ordinality x(e, ord)
      where nullif(trim(x.e ->> 'full_name'), '') is not null
      limit 100;
      n_new := n_new + 1;
    exception when others then
      v_err := v_err || jsonb_build_object('code', r ->> 'contract_no', 'error', sqlerrm);
    end;
  end loop;
  return jsonb_build_object('created', n_new, 'same', n_same, 'errors', v_err);
end;
$$;
revoke execute on function public.import_legacy_charters(jsonb) from public, anon, authenticated;
grant execute on function public.import_legacy_charters(jsonb) to authenticated;
