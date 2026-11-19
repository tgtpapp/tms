-- =====================================================================
-- Chữ ký đã có sẵn họ tên: bản in bỏ dòng họ tên in bên dưới chữ ký (tránh ghi 2 lần).
-- who = 'giam_doc' (chữ ký giám đốc, người có settings.manage đặt) hoặc user_id (chính người đó đặt).
-- =====================================================================
create table public.signature_settings (
  tenant_id  uuid not null references public.tenants (id),
  who        text not null check (who = 'giam_doc' or who ~ '^[0-9a-f-]{36}$'),
  has_name   boolean not null default false,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, who)
);
create trigger signature_settings_touch before update on public.signature_settings for each row execute function app.touch_updated_at();
alter table public.signature_settings enable row level security;
revoke all on public.signature_settings from public, anon, authenticated;
grant select on public.signature_settings to authenticated;
grant select, insert, update, delete on public.signature_settings to service_role;
create policy signature_settings_select on public.signature_settings for select to authenticated
  using (tenant_id = app.current_tenant_id());

create function public.set_signature_has_name(p_who text, p_has_name boolean)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not (case when p_who = 'giam_doc' then app.has_permission('settings.manage') else p_who = auth.uid()::text end) then
    raise exception 'Không có quyền đổi cài đặt chữ ký này' using errcode = '42501';
  end if;
  insert into public.signature_settings (tenant_id, who, has_name) values (v_tid, p_who, coalesce(p_has_name, false))
  on conflict (tenant_id, who) do update set has_name = excluded.has_name;
end;
$$;
revoke execute on function public.set_signature_has_name(text, boolean) from public, anon, authenticated;
grant execute on function public.set_signature_has_name(text, boolean) to authenticated;
