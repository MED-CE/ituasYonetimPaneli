-- İTÜAS Otonom Tekne Takımı - Supabase Veritabanı Kurulum Dosyası (XP ve WhatsApp Hariç)

-- 1. PROFILES
create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text unique,
  full_name text not null,
  role text not null default 'Üye',
  department text,
  email text unique,
  phone text,
  active boolean default true,
  created_at timestamptz default now()
);

alter table public.profiles enable row level security;
create policy "Herkes profilleri görebilir" on public.profiles for select using (true);
create policy "Kullanıcı kendi profilini güncelleyebilir" on public.profiles for update using (auth.uid() = id);
create policy "Yöneticiler profil ekleyebilir/düzenleyebilir" on public.profiles for all using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'Yönetici')
);

-- 2. TEAM SETTINGS
create table if not exists public.team_settings (
  id int primary key default 1,
  teamName text default 'İTÜAS Otonom Tekne Takımı',
  motto text default 'Daha İyi Bir Dünya İçin Mühendislik'
);
alter table public.team_settings enable row level security;
create policy "Herkes ayarları görebilir" on public.team_settings for select using (true);
create policy "Yöneticiler ayarları değiştirebilir" on public.team_settings for all using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'Yönetici')
);
-- Varsayılan ayar satırını ekleyelim
insert into public.team_settings (id) values (1) on conflict (id) do nothing;


-- 3. EVENTS
create table if not exists public.events (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  event_date date not null,
  start_time time,
  end_time time,
  location text,
  event_type text,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);
alter table public.events enable row level security;
create policy "Herkes etkinlikleri görebilir" on public.events for select using (true);
create policy "Yönetici ve Kaptan etkinlik ekleyebilir/silebilir" on public.events for all using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('Yönetici', 'Kaptan'))
);

-- 4. EVENT ATTENDANCE
create table if not exists public.event_attendance (
  id uuid primary key default gen_random_uuid(),
  event_id uuid references public.events(id) on delete cascade,
  member_id uuid references public.profiles(id) on delete cascade,
  planned_status text,
  real_status text,
  updated_at timestamptz default now(),
  unique(event_id, member_id)
);
alter table public.event_attendance enable row level security;
create policy "Herkes katılımı görebilir" on public.event_attendance for select using (true);
create policy "Kullanıcı kendi katılımını belirtebilir" on public.event_attendance for insert with check (auth.uid() = member_id);
create policy "Kullanıcı kendi katılımını güncelleyebilir" on public.event_attendance for update using (auth.uid() = member_id);
create policy "Yönetici herkesin katılımını güncelleyebilir" on public.event_attendance for all using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role = 'Yönetici')
);

-- 5. ANNOUNCEMENTS
create table if not exists public.announcements (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  body text,
  priority text default 'Normal',
  pinned boolean default false,
  author_id uuid references public.profiles(id),
  created_at timestamptz default now()
);
alter table public.announcements enable row level security;
create policy "Herkes duyuruları görebilir" on public.announcements for select using (true);
create policy "Yetkililer duyuru yayınlayabilir" on public.announcements for all using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('Yönetici', 'Kaptan', 'Mentor'))
);

-- 6. TASKS
create table if not exists public.tasks (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  description text,
  assigned_id uuid references public.profiles(id),
  due_date date,
  priority text default 'Düşük',
  status text default 'Bekliyor',
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);
alter table public.tasks enable row level security;
create policy "Herkes görevleri görebilir" on public.tasks for select using (true);
create policy "Yetkililer görev oluşturabilir" on public.tasks for insert with check (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('Yönetici', 'Kaptan', 'Mentor'))
);
create policy "Görevliler kendi görevini veya yöneticiler her görevi güncelleyebilir" on public.tasks for update using (
  auth.uid() = assigned_id or exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('Yönetici', 'Kaptan', 'Mentor'))
);
create policy "Yetkililer görev silebilir" on public.tasks for delete using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('Yönetici', 'Kaptan', 'Mentor'))
);

-- 7. TASK ASSIGNEES (Çoklu görev atama için)
create table if not exists public.task_assignees (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks(id) on delete cascade,
  member_id uuid references public.profiles(id) on delete cascade,
  created_at timestamptz default now(),
  unique(task_id, member_id)
);
alter table public.task_assignees enable row level security;
create policy "Herkes atanmışları görebilir" on public.task_assignees for select using (true);
create policy "Yetkililer atanmış ekleyebilir" on public.task_assignees for all using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('Yönetici', 'Kaptan', 'Mentor'))
);

-- 8. WORKSHOP SESSIONS
create table if not exists public.workshop_sessions (
  id uuid primary key default gen_random_uuid(),
  member_id uuid references public.profiles(id) on delete cascade,
  check_in timestamptz not null default now(),
  check_out timestamptz,
  created_at timestamptz not null default now()
);
alter table public.workshop_sessions enable row level security;
create policy "Herkes atölye kayıtlarını görebilir" on public.workshop_sessions for select using (true);
create policy "Kullanıcı kendi girişini yapabilir" on public.workshop_sessions for insert with check (auth.uid() = member_id);
create policy "Kullanıcı kendi çıkışını güncelleyebilir" on public.workshop_sessions for update using (auth.uid() = member_id);
create policy "Yöneticiler her işlemi yapabilir" on public.workshop_sessions for all using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('Yönetici', 'Kaptan'))
);

-- 9. TASK COMPLETION REPORTS
create table if not exists public.task_completion_reports (
  id uuid primary key default gen_random_uuid(),
  task_id uuid references public.tasks(id) on delete cascade,
  completed_by uuid references public.profiles(id),
  completed_by_name text,
  work_done text not null,
  problems text,
  solution text,
  materials text,
  extra_note text,
  completed_at timestamptz default now(),
  created_at timestamptz default now()
);
alter table public.task_completion_reports enable row level security;
create policy "Herkes raporları görebilir" on public.task_completion_reports for select using (true);
create policy "Kullanıcı rapor ekleyebilir" on public.task_completion_reports for insert with check (auth.uid() = completed_by);
create policy "Yetkililer rapor düzenleyebilir/silebilir" on public.task_completion_reports for all using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and p.role in ('Yönetici', 'Kaptan', 'Mentor'))
);

-- 10. TASK COMPLETION ATTACHMENTS
create table if not exists public.task_completion_attachments (
  id uuid primary key default gen_random_uuid(),
  report_id uuid references public.task_completion_reports(id) on delete cascade,
  uploaded_by uuid references public.profiles(id),
  file_name text not null,
  file_url text not null,
  storage_path text not null,
  mime_type text,
  created_at timestamptz default now()
);
alter table public.task_completion_attachments enable row level security;
create policy "Herkes dosyaları görebilir" on public.task_completion_attachments for select using (true);
create policy "Kullanıcı dosya ekleyebilir" on public.task_completion_attachments for insert with check (auth.uid() = uploaded_by);

-- STORAGE BUCKETS (Ek olarak Supabase Storage'dan bu bucketı açmanız gerekir)
-- Bucket adı: task-completion-attachments

-- Gerekli Fonksiyonlar
create or replace function public.is_workshop_manager()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles
    where id = auth.uid() and role in ('Yönetici', 'Kaptan') and active is not false
  );
$$;

-- Trigger: Yeni kullanıcı kayıt olduğunda profiles tablosuna ekle
create or replace function public.handle_new_user() 
returns trigger as $$
begin
  insert into public.profiles (id, full_name, email, role, active)
  values (new.id, coalesce(new.raw_user_meta_data->>'full_name', 'Yeni Üye'), new.email, 'Üye', true);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Bildirimler için Realtime Aktifleştirme
alter publication supabase_realtime add table public.tasks;
alter publication supabase_realtime add table public.announcements;
alter publication supabase_realtime add table public.events;
alter publication supabase_realtime add table public.event_attendance;
alter publication supabase_realtime add table public.workshop_sessions;
alter publication supabase_realtime add table public.profiles;
alter publication supabase_realtime add table public.team_settings;


