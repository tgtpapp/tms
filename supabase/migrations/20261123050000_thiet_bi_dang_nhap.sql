-- =====================================================================
-- Quản lý thiết bị đăng nhập (như Zalo): mỗi người xem các thiết bị đang đăng nhập tài khoản CỦA MÌNH
-- (trình duyệt / máy, địa chỉ IP, lúc đăng nhập, lần dùng gần nhất) và đăng xuất từng thiết bị hoặc tất cả thiết bị khác.
-- Đăng xuất = xóa phiên đăng nhập: thiết bị đó không gia hạn được nữa; app trên thiết bị đó tự kiểm tra và thoát ngay.
-- Chỉ dùng bảng phiên chuẩn của Supabase Auth (có ở cả bản Cloud và bản tự cài).
-- =====================================================================
create function public.my_sessions()
returns table (id uuid, created_at timestamptz, last_active timestamptz, user_agent text, ip text, is_current boolean)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.created_at, coalesce(s.refreshed_at, s.updated_at, s.created_at), s.user_agent, host(s.ip),
         s.id::text = coalesce(auth.jwt() ->> 'session_id', '')
  from auth.sessions s
  where s.user_id = auth.uid() and (s.not_after is null or s.not_after > now())
  order by (s.id::text = coalesce(auth.jwt() ->> 'session_id', '')) desc, coalesce(s.refreshed_at, s.updated_at, s.created_at) desc
$$;

/** Phiên của thiết bị đang dùng còn hiệu lực không (bị đăng xuất từ thiết bị khác thì false) */
create function public.session_alive()
returns boolean
language sql stable security definer set search_path = ''
as $$
  select auth.jwt() ->> 'session_id' is null
      or exists (select 1 from auth.sessions where id::text = auth.jwt() ->> 'session_id' and user_id = auth.uid())
$$;

/** Đăng xuất 1 thiết bị của chính mình */
create function public.sign_out_session(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
begin
  if auth.uid() is null then raise exception 'Chưa đăng nhập' using errcode = '42501'; end if;
  delete from auth.sessions where id = p_id and user_id = auth.uid();
  if not found then raise exception 'Không tìm thấy thiết bị' using errcode = 'P0002'; end if;
end;
$$;

/** Đăng xuất mọi thiết bị khác (giữ thiết bị đang dùng). Trả về số thiết bị đã đăng xuất. */
create function public.sign_out_other_sessions()
returns int
language plpgsql security definer set search_path = ''
as $$
declare n int;
begin
  if auth.uid() is null then raise exception 'Chưa đăng nhập' using errcode = '42501'; end if;
  delete from auth.sessions where user_id = auth.uid() and id::text <> coalesce(auth.jwt() ->> 'session_id', '');
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.my_sessions(), public.session_alive(), public.sign_out_session(uuid), public.sign_out_other_sessions()
  from public, anon, authenticated;
grant execute on function public.my_sessions(), public.session_alive(), public.sign_out_session(uuid), public.sign_out_other_sessions()
  to authenticated;
