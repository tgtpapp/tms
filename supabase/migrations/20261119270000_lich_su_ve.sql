-- Lịch sử 1 đơn vé (hiện ở tab "Lịch sử" khi bấm vào ghế): mọi lần sửa vé / đơn + các lần thu, hoàn tiền.
-- Ai bán vé hoặc điều hành xem được; sai nhà xe → không tìm thấy.
create function public.ticket_history(p_booking_id uuid)
returns jsonb
language plpgsql stable security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_ids text[];
begin
  if v_tid is null or not (app.has_permission('ticket.sell') or app.has_permission('trip.manage')) then
    raise exception 'Không có quyền' using errcode = '42501';
  end if;
  if not exists (select 1 from public.bookings where tenant_id = v_tid and id = p_booking_id) then
    raise exception 'Không tìm thấy' using errcode = 'P0002';
  end if;
  v_ids := array(select id::text from public.seat_inventory where tenant_id = v_tid and booking_id = p_booking_id) || p_booking_id::text;
  return coalesce((
    select jsonb_agg(e order by e ->> 'at')
    from (
      select jsonb_build_object('at', a.created_at, 'actor', u.full_name, 'entity', a.entity, 'action', a.action,
                                'old', a.detail -> 'old', 'new', a.detail -> 'new') as e
      from public.audit_logs a
      left join public.app_users u on u.tenant_id = v_tid and u.id = a.actor_id
      where a.tenant_id = v_tid and a.entity in ('seat_inventory', 'bookings') and a.entity_id = any (v_ids)
      union all
      select jsonb_build_object('at', t.created_at, 'actor', u.full_name, 'entity', 'tien', 'action', t.kind, 'note', t.note,
                                'amount', (select coalesce(sum(l.debit - l.credit), 0) from public.ledger_lines l
                                           where l.tenant_id = v_tid and l.txn_id = t.id and l.account in ('tien_mat', 'ngan_hang')),
                                'method', (select string_agg(distinct l.account, ',') from public.ledger_lines l
                                           where l.tenant_id = v_tid and l.txn_id = t.id and l.account in ('tien_mat', 'ngan_hang')))
      from public.ledger_transactions t
      left join public.app_users u on u.tenant_id = v_tid and u.id = t.created_by
      where t.tenant_id = v_tid and t.booking_id = p_booking_id
    ) x
  ), '[]'::jsonb);
end;
$$;
revoke execute on function public.ticket_history(uuid) from public, anon, authenticated;
grant execute on function public.ticket_history(uuid) to authenticated;
