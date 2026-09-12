-- Çoklu kişi ve departman görevlendirmesi. Mevcut verileri korur.
alter table public.tasks
  add column if not exists assignment_type text not null default 'people'
    check (assignment_type in ('people', 'department')),
  add column if not exists assigned_member_ids jsonb not null default '[]'::jsonb,
  add column if not exists assigned_department text;

create table if not exists public.task_assignees (
  task_id uuid not null references public.tasks(id) on delete cascade,
  member_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (task_id, member_id)
);

alter table public.task_assignees enable row level security;

create policy "Authenticated users can read task assignees"
  on public.task_assignees for select to authenticated using (true);
create policy "Managers can manage task assignees"
  on public.task_assignees for all to authenticated using (true) with check (true);

notify pgrst, 'reload schema';
