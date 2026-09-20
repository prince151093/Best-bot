-- Vehicle Life — Supabase PostgreSQL schema
-- Run this once in Supabase Dashboard → SQL Editor.

create table if not exists public.users (
  user_id text not null,
  guild_id text not null,
  messages bigint not null default 0,
  vc_seconds bigint not null default 0,
  vehicle_index integer not null default 0,
  last_vc_join bigint null,
  updated_at bigint not null default 0,
  constraint users_pkey primary key (guild_id, user_id),
  constraint users_messages_nonnegative check (messages >= 0),
  constraint users_vc_seconds_nonnegative check (vc_seconds >= 0),
  constraint users_vehicle_index_nonnegative check (vehicle_index >= 0)
);

create index if not exists users_leaderboard_idx
  on public.users (guild_id, vehicle_index desc, vc_seconds desc, messages desc);

-- The bot uses the Supabase service-role key server-side, so RLS is not required
-- for the bot to operate. Keep SUPABASE_SERVICE_ROLE_KEY secret.
