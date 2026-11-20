-- =====================================================================
-- Giá dầu thị trường (như app cũ): giá bán lẻ Petrolimex vùng 1, tự cập nhật 2 lần / ngày (GitHub Actions đọc bảng giá
-- rồi gọi app.svc_set_fuel_market); lưu lịch sử mỗi lần giá đổi. Nhà xe nhập tay được khi chưa tự cập nhật
-- (giá nhập tay mới hơn thì dùng giá nhập tay).
-- Cấp dầu từ bồn: tính theo giá niêm yết (mặc định, như app cũ) hoặc giá bình quân bồn – chọn ở Thiết lập.
-- =====================================================================
create table public.fuel_market_prices (       -- dữ liệu thị trường dùng chung, không thuộc nhà xe nào
  id            bigint generated always as identity primary key,
  effective_at  timestamptz not null,          -- thời điểm giá có hiệu lực (lần kiểm tra thấy giá đổi)
  prices        jsonb not null,                -- {"DO 0,05S-II": 26340, ...} đ/lít
  prev          jsonb not null default '{}',   -- giá trước của các mặt hàng đã đổi
  source        text,
  region        smallint not null default 1,
  checked_at    timestamptz not null default now()
);
create index fuel_market_prices_time_idx on public.fuel_market_prices (effective_at desc);
alter table public.fuel_market_prices enable row level security;
revoke all on public.fuel_market_prices from public, anon, authenticated;
grant select on public.fuel_market_prices to authenticated;
grant select, insert, update, delete on public.fuel_market_prices to service_role;
create policy fuel_market_prices_select on public.fuel_market_prices for select to authenticated using (true);

/** Ghi giá mới đọc được (việc định kỳ). Giá đổi → thêm dòng (kèm giá trước); không đổi → chỉ ghi giờ kiểm tra. */
create function app.svc_set_fuel_market(p_prices jsonb, p_source text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  l public.fuel_market_prices;
  v_prev jsonb := '{}';
  k text;
begin
  if jsonb_typeof(p_prices) <> 'object' or not exists (select 1 from jsonb_each(p_prices)) then
    raise exception 'Bảng giá trống' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(p_prices) x where jsonb_typeof(x.value) <> 'number' or x.value::numeric < 5000 or x.value::numeric > 100000) then
    raise exception 'Giá không hợp lệ' using errcode = '22023';
  end if;
  select * into l from public.fuel_market_prices order by effective_at desc, id desc limit 1;
  if found and l.prices = p_prices then
    update public.fuel_market_prices set checked_at = now(), source = coalesce(p_source, source) where id = l.id;
    return 'same';
  end if;
  if found then
    for k in select jsonb_object_keys(p_prices) loop
      if l.prices ? k and l.prices -> k <> p_prices -> k then v_prev := v_prev || jsonb_build_object(k, l.prices -> k); end if;
    end loop;
  end if;
  insert into public.fuel_market_prices (effective_at, prices, prev, source) values (now(), p_prices, v_prev, p_source);
  return 'changed';
end;
$$;
revoke execute on function app.svc_set_fuel_market(jsonb, text) from public, anon, authenticated;
grant execute on function app.svc_set_fuel_market(jsonb, text) to service_role;

-- Giá đang có lúc chuyển sang (bảng giá Petrolimex vùng 1 hiệu lực 19/11/2026 15:59, app cũ đã lấy)
insert into public.fuel_market_prices (effective_at, prices, prev, source)
values ('2026-11-19 15:59+07', '{"E10 RON95-III": 19100, "E5 RON92-II": 18570, "DO 0,001S-V": 28140, "DO 0,05S-II": 26340}',
        '{"E10 RON95-III": 19840, "E5 RON92-II": 19390, "DO 0,001S-V": 28620, "DO 0,05S-II": 26820}', 'Petrolimex (webgia.com)');

-- ---------------------------------------------------------------- Thiết lập nhà xe
alter table public.fuel_settings add column issue_price_mode text not null default 'tt' check (issue_price_mode in ('tt', 'bq'));
alter table public.fuel_settings add column market_manual jsonb;    -- {gia:{…}, truoc:{…}, hieu_luc, cap_nhat}: giá nhập tay
alter table public.fuel_entries add column market_price boolean not null default false;   -- đơn giá lấy theo giá niêm yết

/** Nhập tay giá bán lẻ (khi chưa tự cập nhật được). */
create function public.save_fuel_market_manual(p_prices jsonb, p_effective_at timestamptz)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_cur jsonb;
  v_prev jsonb := '{}';
  k text;
  m jsonb;
  a public.fuel_market_prices;
begin
  if v_tid is null or not app.has_permission('fuel.edit') then
    raise exception 'Không có quyền sửa nhiên liệu' using errcode = '42501';
  end if;
  if jsonb_typeof(p_prices) <> 'object' or not exists (select 1 from jsonb_each(p_prices)) then
    raise exception 'Nhập ít nhất một giá' using errcode = '22023';
  end if;
  if exists (select 1 from jsonb_each(p_prices) x where jsonb_typeof(x.value) <> 'number' or x.value::numeric < 5000 or x.value::numeric > 100000) then
    raise exception 'Giá phải từ 5.000 đến 100.000 đ/lít' using errcode = '22023';
  end if;
  select market_manual into m from public.fuel_settings where tenant_id = v_tid;
  select * into a from public.fuel_market_prices order by effective_at desc, id desc limit 1;
  v_cur := case when m is not null and (a.id is null or (m ->> 'cap_nhat')::timestamptz > a.checked_at) then m -> 'gia' else a.prices end;
  for k in select jsonb_object_keys(p_prices) loop
    if v_cur ? k and v_cur -> k <> p_prices -> k then v_prev := v_prev || jsonb_build_object(k, v_cur -> k); end if;
  end loop;
  insert into public.fuel_settings (tenant_id, market_manual) values (v_tid, jsonb_build_object('gia', p_prices, 'truoc', v_prev,
    'hieu_luc', coalesce(p_effective_at, now()), 'cap_nhat', now()))
  on conflict (tenant_id) do update set market_manual = excluded.market_manual;
end;
$$;
revoke execute on function public.save_fuel_market_manual(jsonb, timestamptz) from public, anon, authenticated;
grant execute on function public.save_fuel_market_manual(jsonb, timestamptz) to authenticated;

do $$
declare v text;
begin
  select pg_get_functiondef('public.save_fuel(uuid, jsonb)'::regprocedure) into v;
  v := replace(v, 'invoice_no, note, files)', 'invoice_no, note, files, market_price)');
  v := replace(v, 'coalesce(array(select jsonb_array_elements_text(p -> ''files'')), ''{}''))',
                  'coalesce(array(select jsonb_array_elements_text(p -> ''files'')), ''{}''), coalesce((p ->> ''market_price'')::boolean, false))');
  v := replace(v, 'files = excluded.files;', 'files = excluded.files, market_price = excluded.market_price;');
  if v not like '%market_price = excluded.market_price%' or v not like '%files, market_price)%' then raise exception 'Không sửa được save_fuel'; end if;
  execute v;
end;
$$;
