-- Reelizate — esquema de base de datos para Supabase.
-- Correr esto en el SQL editor del proyecto de Supabase (Project > SQL Editor)
-- una vez creado el proyecto. También hay que crear el bucket de Storage
-- "reel-files" (privado) desde la sección Storage del dashboard.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  subscription_status text not null default 'none', -- 'none' | 'active' | 'past_due' | 'canceled'
  plan text, -- 'standard' (5 videos/mes) | 'pro' (ilimitado) | null (sin suscripción)
  created_at timestamptz not null default now()
);

-- Se crea el profile automáticamente al registrarse.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email);
  return new;
end;
$$ language plpgsql security definer;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.handle_new_user();

-- Trabajos de usuarios suscriptos (autenticados).
create table if not exists video_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  original_filename text,
  input_path text,
  result_path text,
  status text not null default 'processing', -- 'processing' | 'done' | 'failed'
  transcript text,
  caption text,
  hashtags text[],
  report jsonb,
  created_at timestamptz not null default now()
);

-- La muestra gratis: 1 video por IP, sin necesidad de cuenta.
-- ip_hash es un hash (no la IP en texto plano) para no guardar PII sin necesidad.
create table if not exists trial_jobs (
  id uuid primary key default gen_random_uuid(),
  ip_hash text not null,
  original_filename text,
  input_path text,
  result_path text,
  status text not null default 'processing',
  transcript text,
  caption text,
  hashtags text[],
  report jsonb,
  created_at timestamptz not null default now()
);
create index if not exists trial_jobs_ip_hash_idx on trial_jobs(ip_hash);

-- Guiones generados (opcional guardar historial; no es estrictamente necesario
-- pero permite mostrarle al usuario sus guiones anteriores).
create table if not exists scripts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  topic text,
  content text,
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;
create policy "profiles: select own" on profiles for select using (auth.uid() = id);
create policy "profiles: update own" on profiles for update using (auth.uid() = id);

alter table video_jobs enable row level security;
create policy "video_jobs: select own" on video_jobs for select using (auth.uid() = user_id);
create policy "video_jobs: insert own" on video_jobs for insert with check (auth.uid() = user_id);

alter table scripts enable row level security;
create policy "scripts: select own" on scripts for select using (auth.uid() = user_id);
create policy "scripts: insert own" on scripts for insert with check (auth.uid() = user_id);

-- trial_jobs: no hay usuario logueado, así que no se puede filtrar por auth.uid().
-- El id de cada fila es un UUID random que actúa como "token" — solo quien lo
-- tiene (el navegador que subió el video) puede consultarlo, y no se puede
-- listar ni adivinar. Las filas las crea el backend con la service role key,
-- así que alcanza con permitir SELECT público por id.
alter table trial_jobs enable row level security;
create policy "trial_jobs: select by anyone (acts as capability token)" on trial_jobs for select using (true);
