-- =====================================================================
-- Giai đoạn 6.5 – Kết nối Zalo OA (làm sẵn, bật khi nhà xe có OA)
-- - Nhà xe bấm "Kết nối Zalo OA" → cấp quyền cho ứng dụng Zalo của nền tảng (OAuth v4, PKCE).
--   Mã truy cập Zalo chỉ nằm ở bảng zalo_connections (chỉ service_role đọc được), không bao giờ ra trình duyệt.
-- - Tin ZNS (gửi theo số điện thoại, mẫu do nhà xe đăng ký với Zalo):
--     've'   : xác nhận vé khi vé được đặt / thanh toán
--     'hang' : báo người nhận khi hàng đã đến
--   Chỉ xếp hàng chờ gửi khi nhà xe đã kết nối OA và bật mẫu tương ứng. Mỗi vé / mỗi kiện chỉ gửi 1 lần.
-- - Pháp lý / chi phí (cần xác minh): ZNS tính phí theo tin, mẫu phải được Zalo duyệt; nội dung chỉ là thông báo giao dịch.
-- =====================================================================

create table public.zalo_connections (
  tenant_id          uuid primary key references public.tenants (id),
  oa_id              text not null,
  oa_name            text,
  access_token       text not null,
  refresh_token      text not null,
  access_expires_at  timestamptz not null,
  connected_at       timestamptz not null default now(),
  connected_by       uuid
);
alter table public.zalo_connections enable row level security;
revoke all on public.zalo_connections from public, anon, authenticated;
grant select, insert, update, delete on public.zalo_connections to service_role;

-- Phiên cấp quyền OAuth đang chờ (state + code_verifier), sống 15 phút
create table public.zalo_oauth_states (
  state       text primary key,
  tenant_id   uuid not null references public.tenants (id),
  user_id     uuid not null,
  verifier    text not null,
  return_url  text not null,
  created_at  timestamptz not null default now()
);
create index zalo_oauth_states_tenant_idx on public.zalo_oauth_states (tenant_id, created_at);
alter table public.zalo_oauth_states enable row level security;
revoke all on public.zalo_oauth_states from public, anon, authenticated;
grant select, insert, update, delete on public.zalo_oauth_states to service_role;

create table public.zalo_templates (
  tenant_id    uuid not null references public.tenants (id),
  kind         text not null check (kind in ('ve', 'hang')),
  template_id  text not null check (template_id ~ '^[0-9A-Za-z_-]{1,50}$'),
  enabled      boolean not null default true,
  updated_at   timestamptz not null default now(),
  primary key (tenant_id, kind)
);
alter table public.zalo_templates enable row level security;
create policy zalo_templates_select on public.zalo_templates for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('settings.manage'));
revoke all on public.zalo_templates from public, anon, authenticated;
grant select on public.zalo_templates to authenticated;
grant select, insert, update, delete on public.zalo_templates to service_role;

create table public.zalo_messages (
  id          uuid primary key default gen_random_uuid(),
  tenant_id   uuid not null references public.tenants (id),
  kind        text not null check (kind in ('ve', 'hang')),
  ref_id      uuid not null,                 -- bookings.id / shipments.id
  phone       text not null,
  status      text not null default 'cho' check (status in ('cho', 'dang_gui', 'da_gui', 'loi')),
  attempts    int not null default 0,
  error       text,
  msg_id      text,
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  sent_at     timestamptz,
  unique (tenant_id, kind, ref_id),
  unique (tenant_id, id)
);
create index zalo_messages_queue_idx on public.zalo_messages (tenant_id, status, created_at);
alter table public.zalo_messages enable row level security;
create policy zalo_messages_select on public.zalo_messages for select to authenticated
  using (tenant_id = app.current_tenant_id() and app.has_permission('settings.manage'));
revoke all on public.zalo_messages from public, anon, authenticated;
grant select on public.zalo_messages to authenticated;
grant select, insert, update, delete on public.zalo_messages to service_role;

-- ---------------------------------------------------------------- Xếp tin chờ gửi
create function app.zalo_enqueue(p_tenant uuid, p_kind text, p_ref uuid, p_phone text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
begin
  if v_phone !~ '^0[0-9]{9}$' then return; end if;
  if not exists (select 1 from public.zalo_connections c where c.tenant_id = p_tenant) then return; end if;
  if not exists (select 1 from public.zalo_templates t where t.tenant_id = p_tenant and t.kind = p_kind and t.enabled) then return; end if;
  insert into public.zalo_messages (tenant_id, kind, ref_id, phone) values (p_tenant, p_kind, p_ref, v_phone)
  on conflict (tenant_id, kind, ref_id) do nothing;
end;
$$;
revoke execute on function app.zalo_enqueue(uuid, text, uuid, text) from public, anon, authenticated;

create function app.zalo_on_ticket()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status in ('dat', 'da_tt') and (tg_op = 'INSERT' or old.status not in ('dat', 'da_tt')) then
    perform app.zalo_enqueue(new.tenant_id, 've', new.booking_id,
      coalesce((select b.customer_phone from public.bookings b where b.tenant_id = new.tenant_id and b.id = new.booking_id), new.passenger_phone));
  end if;
  return null;
end;
$$;
create trigger seat_inventory_zalo after insert or update of status on public.seat_inventory
  for each row execute function app.zalo_on_ticket();

create function app.zalo_on_shipment()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  if new.status = 'den' and old.status <> 'den' then
    perform app.zalo_enqueue(new.tenant_id, 'hang', new.id, new.receiver_phone);
  end if;
  return null;
end;
$$;
create trigger shipments_zalo after update of status on public.shipments
  for each row execute function app.zalo_on_shipment();
revoke execute on function app.zalo_on_ticket(), app.zalo_on_shipment() from public, anon, authenticated;

-- ---------------------------------------------------------------- RPC cho màn hình Cấu hình
create function public.zalo_status()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tenant uuid := app.current_tenant_id();
  c record;
begin
  if v_tenant is null or not app.has_permission('settings.manage') then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;
  select oa_id, oa_name, connected_at into c from public.zalo_connections where tenant_id = v_tenant;
  return jsonb_build_object('connected', c.oa_id is not null, 'oa_id', c.oa_id, 'oa_name', c.oa_name, 'connected_at', c.connected_at,
    'waiting', (select count(*) from public.zalo_messages m where m.tenant_id = v_tenant and m.status in ('cho', 'dang_gui')),
    'failed', (select count(*) from public.zalo_messages m where m.tenant_id = v_tenant and m.status = 'loi'));
end;
$$;

create function public.zalo_disconnect()
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid := app.current_tenant_id();
begin
  if v_tenant is null or not app.has_permission('settings.manage') then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;
  delete from public.zalo_connections where tenant_id = v_tenant;
  insert into public.audit_logs (tenant_id, actor_id, action, entity, entity_id, detail)
  values (v_tenant, auth.uid(), 'zalo_disconnect', 'zalo_connections', v_tenant::text, '{}');
end;
$$;

create function public.save_zalo_template(p_kind text, p_template_id text, p_enabled boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid := app.current_tenant_id();
begin
  if v_tenant is null or not app.has_permission('settings.manage') then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;
  if p_kind not in ('ve', 'hang') then raise exception 'Loại tin không hợp lệ' using errcode = '22023'; end if;
  if coalesce(trim(p_template_id), '') = '' then
    delete from public.zalo_templates where tenant_id = v_tenant and kind = p_kind;
    return;
  end if;
  if trim(p_template_id) !~ '^[0-9A-Za-z_-]{1,50}$' then
    raise exception 'Mã mẫu ZNS chỉ gồm chữ, số, gạch' using errcode = '22023';
  end if;
  insert into public.zalo_templates (tenant_id, kind, template_id, enabled) values (v_tenant, p_kind, trim(p_template_id), coalesce(p_enabled, true))
  on conflict (tenant_id, kind) do update set template_id = excluded.template_id, enabled = excluded.enabled, updated_at = now();
end;
$$;

-- Gửi lại tin lỗi
create function public.zalo_retry_failed()
returns int
language plpgsql security definer set search_path = ''
as $$
declare
  v_tenant uuid := app.current_tenant_id();
  n int;
begin
  if v_tenant is null or not app.has_permission('settings.manage') then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;
  update public.zalo_messages set status = 'cho', attempts = 0, error = null where tenant_id = v_tenant and status = 'loi';
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.zalo_status(), public.zalo_disconnect(), public.save_zalo_template(text, text, boolean),
  public.zalo_retry_failed() from public, anon;
grant execute on function public.zalo_status(), public.zalo_disconnect(), public.save_zalo_template(text, text, boolean),
  public.zalo_retry_failed() to authenticated;

-- ---------------------------------------------------------------- Hàm nội bộ cho Edge Function
-- Nhận tối đa p_limit tin để gửi (khóa hàng, không gửi trùng khi 2 lần gửi chạy cùng lúc)
create function public.svc_zalo_claim(p_tenant uuid, p_limit int)
returns setof public.zalo_messages
language sql security definer set search_path = ''
as $$
  update public.zalo_messages m set status = 'dang_gui', attempts = m.attempts + 1, claimed_at = now()
  where m.id in (
    select q.id from public.zalo_messages q
    where q.tenant_id = p_tenant
      and (q.status = 'cho' or (q.status = 'dang_gui' and q.claimed_at < now() - interval '5 minutes'))
      and q.attempts < 5
    order by q.created_at
    limit least(greatest(p_limit, 1), 50)
    for update skip locked)
  returning m.*;
$$;

-- Người gọi thuộc nhà xe nào (Edge Function dùng phiên đăng nhập để biết nhà xe)
create function public.my_tenant_id()
returns uuid
language sql stable security definer set search_path = ''
as $$ select app.current_tenant_id() $$;

revoke execute on function public.svc_zalo_claim(uuid, int), public.my_tenant_id() from public, anon, authenticated;
grant execute on function public.svc_zalo_claim(uuid, int) to service_role;
grant execute on function public.my_tenant_id() to authenticated;
