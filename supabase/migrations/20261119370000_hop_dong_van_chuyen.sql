-- =====================================================================
-- Hợp đồng vận chuyển đầy đủ như app cũ: số hợp đồng 0001/HĐVC-<hậu tố>, ngày ký, giá trị (bằng chữ khi in),
-- email / người đại diện bên thuê, cự ly, hình thức thanh toán, chi phí cầu đường & ăn nghỉ lái xe do bên nào chịu,
-- nhân viên phục vụ, khứ hồi. In hợp đồng theo mẫu (mẫu pháp lý: cần xác minh).
-- =====================================================================
alter table public.charters
  add column contract_no    text,
  add column signed_on      date,
  add column customer_email text,
  add column customer_rep   text,          -- người đại diện bên thuê (nếu là công ty)
  add column distance_km    int check (distance_km is null or distance_km between 0 and 10000),
  add column payment_terms  text,
  add column toll_by        text check (toll_by is null or toll_by in ('A', 'B')),
  add column meals_by       text check (meals_by is null or meals_by in ('A', 'B')),
  add column attendant      text,          -- nhân viên phục vụ trên xe
  add column round_trip     boolean not null default true;
create unique index charters_contract_no_key on public.charters (tenant_id, contract_no);

-- Số hợp đồng kế tiếp: 0001/HĐVC-<hậu tố số lệnh> (hậu tố lấy ở Cấu hình → Lệnh vận chuyển; chưa có thì bỏ)
create function app.next_contract_no(p_tid uuid)
returns text
language sql volatile security definer set search_path = ''
as $$
  select lpad((coalesce(max(nullif(substring(contract_no from '^(\d+)'), '')::int), 0) + 1)::text, 4, '0') || '/HĐVC'
         || coalesce('-' || nullif((select value #>> '{}' from public.tenant_settings where tenant_id = p_tid and key = 'lenh.hau_to'), ''), '')
  from public.charters where tenant_id = p_tid
$$;
revoke execute on function app.next_contract_no(uuid) from public, anon, authenticated;

create function app.charter_defaults()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.contract_no is null or trim(new.contract_no) = '' then
    perform pg_advisory_xact_lock(hashtext('contract_no:' || new.tenant_id::text));
    new.contract_no := app.next_contract_no(new.tenant_id);
  end if;
  new.signed_on := coalesce(new.signed_on, app.local_today());
  return new;
end;
$$;
revoke execute on function app.charter_defaults() from public, anon, authenticated;
create trigger charters_defaults before insert on public.charters for each row execute function app.charter_defaults();

-- Đánh số cho hợp đồng đã có (theo thứ tự tạo)
update public.charters c set contract_no = lpad(x.n::text, 4, '0') || '/HĐVC'
       || coalesce('-' || nullif((select value #>> '{}' from public.tenant_settings s where s.tenant_id = c.tenant_id and key = 'lenh.hau_to'), ''), ''),
       signed_on = coalesce(c.signed_on, (c.created_at at time zone 'Asia/Ho_Chi_Minh')::date)
from (select id, row_number() over (partition by tenant_id order by created_at, code) n from public.charters) x
where x.id = c.id and c.contract_no is null;
alter table public.charters alter column contract_no set not null;

-- save_charter cũ thành lõi; hàm mới gọi lõi rồi ghi các trường bổ sung
alter function public.save_charter(uuid, jsonb, jsonb) rename to save_charter_core;
alter function public.save_charter_core(uuid, jsonb, jsonb) set schema app;
revoke execute on function app.save_charter_core(uuid, jsonb, jsonb) from public, anon, authenticated;

create function public.save_charter(p_id uuid, p jsonb, p_passengers jsonb)
returns jsonb
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_res jsonb;
  v_no text := nullif(trim(p ->> 'contract_no'), '');
begin
  if v_no is not null and exists (select 1 from public.charters where tenant_id = v_tid and contract_no = v_no and id is distinct from p_id) then
    raise exception 'Số hợp đồng % đã có', v_no using errcode = '23505';
  end if;
  v_res := app.save_charter_core(p_id, p, p_passengers);
  begin
    update public.charters set
      contract_no = coalesce(v_no, contract_no),
      signed_on = coalesce(nullif(p ->> 'signed_on', '')::date, signed_on),
      customer_email = nullif(trim(p ->> 'customer_email'), ''),
      customer_rep = nullif(trim(p ->> 'customer_rep'), ''),
      distance_km = nullif(p ->> 'distance_km', '')::int,
      payment_terms = nullif(trim(p ->> 'payment_terms'), ''),
      toll_by = nullif(p ->> 'toll_by', ''),
      meals_by = nullif(p ->> 'meals_by', ''),
      attendant = nullif(trim(p ->> 'attendant'), ''),
      round_trip = coalesce((p ->> 'round_trip')::boolean, round_trip)
    where tenant_id = v_tid and id = (v_res ->> 'id')::uuid;
  exception when check_violation then
    raise exception 'Kiểm tra lại cự ly (0–10.000 km) và bên chịu chi phí' using errcode = '22023';
  end;
  return v_res || jsonb_build_object('contract_no', (select contract_no from public.charters where tenant_id = v_tid and id = (v_res ->> 'id')::uuid));
end;
$$;
revoke execute on function public.save_charter(uuid, jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.save_charter(uuid, jsonb, jsonb) to authenticated;
