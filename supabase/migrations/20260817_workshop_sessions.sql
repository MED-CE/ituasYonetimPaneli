-- Istanbulls 6064: Atölye giriş / çıkış oturumları
create table if not exists public.workshop_sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid not null references public.profiles(id) on delete cascade,
  check_in timestamptz not null default now(),
  check_out timestamptz,
  created_at timestamptz not null default now(),
  constraint workshop_session_valid_range check (check_out is null or check_out >= check_in)
);

create unique index if not exists workshop_one_open_session_per_member
  on public.workshop_sessions (member_id) where check_out is null;
create index if not exists workshop_sessions_member_check_in_idx
  on public.workshop_sessions (member_id, check_in desc);

alter table public.workshop_sessions enable row level security;

-- SECURITY DEFINER avoids depending on the caller's ability to read every profile row.
create or replace function public.is_workshop_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('Yönetici', 'Kaptan') and active is not false
  );
$$;

grant execute on function public.is_workshop_manager() to authenticated;

drop policy if exists "workshop_select_own_or_manager" on public.workshop_sessions;
create policy "workshop_select_own_or_manager" on public.workshop_sessions
  for select to authenticated using (member_id = auth.uid() or public.is_workshop_manager());

-- Only the database function below can create/close sessions. This blocks forged
-- member IDs and client-supplied times while allowing an admin to read all records.
create or replace function public.toggle_workshop_session()
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  open_session public.workshop_sessions;
  saved_session public.workshop_sessions;
begin
  if auth.uid() is null then
    raise exception 'Oturum açmalısın';
  end if;
  if not exists (select 1 from public.profiles where id = auth.uid() and active is not false) then
    raise exception 'Aktif üye hesabı bulunamadı';
  end if;

  select * into open_session from public.workshop_sessions
  where member_id = auth.uid() and check_out is null
  order by check_in desc limit 1 for update;

  if found then
    update public.workshop_sessions set check_out = now()
    where id = open_session.id returning * into saved_session;
    return jsonb_build_object('action', 'checked_out', 'session', to_jsonb(saved_session));
  end if;

  insert into public.workshop_sessions (member_id, check_in)
  values (auth.uid(), now()) returning * into saved_session;
  return jsonb_build_object('action', 'checked_in', 'session', to_jsonb(saved_session));
end;
$$;

grant execute on function public.toggle_workshop_session() to authenticated;

-- Optional but recommended for live admin/member status updates.
alter publication supabase_realtime add table public.workshop_sessions;
