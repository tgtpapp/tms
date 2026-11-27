-- Trợ lý giọng nói tự học câu nói (không dùng AI): câu trợ lý chưa hiểu → hỏi lại lái xe là lệnh nào → lưu câu gốc gắn với lệnh đó,
-- dùng chung cho cả nhà xe (lần sau nói câu tương tự là hiểu ngay).
-- - Câu có từ tục tĩu: không lưu (kiểm ở trình duyệt và kiểm lại ở đây).
-- - Admin của nhà xe (Chủ nhà xe / Quản trị) xem và xóa được câu đã học (phòng học sai).
-- - Lệnh ghi dữ liệu vẫn hỏi xác nhận như cũ (ở trình duyệt), nên câu học sai không ghi nhầm.

create table public.voice_phrases (
  tenant_id    uuid not null references public.tenants (id),
  id           uuid not null default gen_random_uuid(),
  phrase_key   text not null check (phrase_key ~ '^[a-z0-9]+( [a-z0-9]+){0,29}$' and length(phrase_key) <= 200),   -- câu đã bỏ dấu, chữ thường (để so khớp)
  phrase       text not null check (length(phrase) between 1 and 200),                                             -- câu gốc lái xe nói
  intent       text not null check (intent in ('diem_toi', 'thu_ho', 'chuyen', 'nhac_lai', 'don', 'tra', 'vang', 'hoan_tac', 'giao', 'do_dau',
                                                'chi_phi', 'su_co', 'tre_gio', 'nhan', 'goi',
                                                'nhac:mo', 'nhac:tiep', 'nhac:truoc', 'nhac:dung', 'nhac:phat', 'nhac:to', 'nhac:nho', 'nhac:tat')),
  uses         int not null default 1,
  created_by   uuid,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  primary key (tenant_id, id),
  unique (tenant_id, phrase_key)
);
create index voice_phrases_created_idx on public.voice_phrases (tenant_id, created_at desc);
alter table public.voice_phrases enable row level security;
revoke all on public.voice_phrases from public, anon, authenticated;
grant select on public.voice_phrases to authenticated;
grant select, insert, update, delete on public.voice_phrases to service_role;
-- Mọi người trong nhà xe đọc được (trợ lý trên máy lái xe cần để so khớp); ghi / xóa chỉ qua hàm
create policy voice_phrases_select on public.voice_phrases for select to authenticated using (tenant_id = app.current_tenant_id());

/** Câu có từ tục tĩu (so trên chữ có dấu, chữ thường; "đèo", "đủ"… không bị nhầm vì giữ nguyên dấu) */
create function app.voice_bad(p text)
returns boolean
language sql immutable set search_path = ''
as $$
  select coalesce(lower(normalize(p, NFC)), '') ~ ('(^|[^[:alnum:]])('
    || 'đm|đmm|dm|dmm|đcm|dcm|đkm|dkm|đcmm|vcl|vkl|vl|vãi lồn|vãi l|clgt|cl|cc|đéo|đếch|địt|đjt|djt|đụ|đù má|đù|lồn|buồi|cặc|đĩ|đỉ|'
    || 'mẹ mày|má mày|con mẹ|mẹ kiếp|bố mày|thằng chó|con chó|đồ chó|chó chết|óc chó|khốn nạn|súc vật|ngu như|fuck|shit|bitch'
    || ')($|[^[:alnum:]])')
$$;
revoke execute on function app.voice_bad(text) from public, anon;
grant execute on function app.voice_bad(text) to authenticated, service_role;

/** Lưu câu vừa học (gọi sau khi lái xe xác nhận câu đó là lệnh nào). Trả: 'luu' | 'co_roi' | 'bo_qua' (từ tục / quá giới hạn) */
create function public.voice_learn(p_phrase text, p_key text, p_intent text)
returns text
language plpgsql security definer set search_path = ''
as $$
declare
  v_tid uuid := app.current_tenant_id();
  v_phrase text := left(trim(coalesce(p_phrase, '')), 200);
  v_key text := trim(coalesce(p_key, ''));
begin
  if v_tid is null or auth.uid() is null then raise exception 'Không có quyền' using errcode = '42501'; end if;
  if v_phrase = '' or v_key !~ '^[a-z0-9]+( [a-z0-9]+){0,29}$' or length(v_key) > 200 then raise exception 'Câu không hợp lệ' using errcode = '22023'; end if;
  if p_intent is null or p_intent not in ('diem_toi', 'thu_ho', 'chuyen', 'nhac_lai', 'don', 'tra', 'vang', 'hoan_tac', 'giao', 'do_dau', 'chi_phi', 'su_co',
      'tre_gio', 'nhan', 'goi', 'nhac:mo', 'nhac:tiep', 'nhac:truoc', 'nhac:dung', 'nhac:phat', 'nhac:to', 'nhac:nho', 'nhac:tat') then
    raise exception 'Lệnh không hợp lệ' using errcode = '22023';
  end if;
  if app.voice_bad(v_phrase) or app.voice_bad(v_key) then return 'bo_qua'; end if;
  -- chống ghi tràn: mỗi người tối đa 100 câu / ngày, mỗi nhà xe tối đa 2.000 câu
  if (select count(*) from public.voice_phrases where tenant_id = v_tid and created_by = auth.uid() and created_at > now() - interval '1 day') >= 100
     or (select count(*) from public.voice_phrases where tenant_id = v_tid) >= 2000 then
    return 'bo_qua';
  end if;
  insert into public.voice_phrases (tenant_id, phrase_key, phrase, intent, created_by) values (v_tid, v_key, v_phrase, p_intent, auth.uid())
  on conflict (tenant_id, phrase_key) do nothing;
  if found then return 'luu'; end if;
  return 'co_roi';
end;
$$;
revoke execute on function public.voice_learn(text, text, text) from public, anon, authenticated;
grant execute on function public.voice_learn(text, text, text) to authenticated, service_role;

/** Đếm lượt dùng câu đã học (trợ lý hiểu nhờ câu này) */
create function public.voice_used(p_id uuid)
returns void
language sql security definer set search_path = ''
as $$
  update public.voice_phrases set uses = uses + 1, last_used_at = now() where tenant_id = app.current_tenant_id() and id = p_id and auth.uid() is not null
$$;
revoke execute on function public.voice_used(uuid) from public, anon, authenticated;
grant execute on function public.voice_used(uuid) to authenticated, service_role;

/** Admin xóa câu học sai */
create function public.voice_forget(p_id uuid)
returns void
language plpgsql security definer set search_path = ''
as $$
declare v_tid uuid := app.current_tenant_id();
begin
  if v_tid is null or not app.is_tenant_admin() then raise exception 'Chỉ Admin của nhà xe' using errcode = '42501'; end if;
  delete from public.voice_phrases where tenant_id = v_tid and id = p_id;
  if not found then raise exception 'Không tìm thấy câu' using errcode = 'P0002'; end if;
end;
$$;
revoke execute on function public.voice_forget(uuid) from public, anon, authenticated;
grant execute on function public.voice_forget(uuid) to authenticated, service_role;
