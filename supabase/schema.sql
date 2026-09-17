-- Sigh: schema, row level security, and the two functions the Worker calls.
--
-- Everything the application is allowed to do lives in the two SECURITY DEFINER
-- functions at the bottom. The tables themselves are unreachable: RLS is enabled with no
-- policies, so anon and authenticated are denied by default. Only the Worker, holding the
-- service role key, can execute the functions.
--
-- Run this in the Supabase SQL editor.

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists rooms (
  -- room_key is SHA256(phrase + pepper), computed in the Worker. The plaintext phrase
  -- never reaches Postgres, so it cannot appear in query logs, and a dump of this table
  -- is not dictionary-attackable without the Worker's pepper.
  id         uuid primary key default gen_random_uuid(),
  room_key   text unique not null check (room_key ~ '^[a-f0-9]{64}$'),
  label      text,
  timezone   text not null default 'America/New_York',
  created_at timestamptz not null default now()
);

create table if not exists pushes (
  -- device_hash is SHA256(random browser id + day + room id), computed in the browser.
  -- Rotating on the day breaks linkage between days; including the room breaks linkage
  -- between groups. There is deliberately no timestamp finer than the day: press times
  -- are re-identifying on a small team.
  room_id     uuid not null references rooms(id) on delete cascade,
  day         date not null,
  device_hash text not null check (device_hash ~ '^[a-f0-9]{64}$'),
  count       int  not null default 0 check (count >= 0),
  primary key (room_id, day, device_hash)
);

create index if not exists pushes_room_day_idx on pushes (room_id, day);

-- ---------------------------------------------------------------------------
-- Lock the tables
-- ---------------------------------------------------------------------------

alter table rooms  enable row level security;
alter table pushes enable row level security;

-- No policies are created on purpose. RLS with zero policies denies everything to anon
-- and authenticated. This is defense in depth: the Worker uses the service role, which
-- bypasses RLS, so this is what protects the data if the anon key is ever exposed.

revoke all on rooms  from anon, authenticated;
revoke all on pushes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- push: record one press, return the collective figures
-- ---------------------------------------------------------------------------

create or replace function push(p_room_key text, p_device_hash text)
returns json
language plpgsql
security definer
set search_path = public   -- pinned: a SECURITY DEFINER function without this can be
                           -- hijacked by a caller-controlled search_path
as $$
declare
  v_room      rooms%rowtype;
  v_day       date;
  v_is_new    boolean;
  v_uniques   int;
  v_total     bigint;
  v_daily_cap constant int := 25;
begin
  if p_room_key !~ '^[a-f0-9]{64}$' or p_device_hash !~ '^[a-f0-9]{64}$' then
    raise exception 'bad_request';
  end if;

  select * into v_room from rooms where room_key = p_room_key;
  if not found then
    -- Never auto-create. A typo that silently opened an empty room would show the user a
    -- count of zero, which in this app reads as "you are the only one".
    raise exception 'no_room';
  end if;

  v_day := (now() at time zone v_room.timezone)::date;

  -- Whether this is the first press of the day decides if a rank is returned. Checking
  -- before the write rather than reading xmax out of the upsert: the system-column trick
  -- is shorter, but this repo is meant to be readable by the people it counts.
  select not exists (
    select 1 from pushes
     where room_id = v_room.id and day = v_day and device_hash = p_device_hash
  ) into v_is_new;

  insert into pushes as p (room_id, day, device_hash, count)
  values (v_room.id, v_day, p_device_hash, 1)
  on conflict (room_id, day, device_hash)
    do update set count = least(p.count + 1, v_daily_cap);

  select count(*), coalesce(sum(count), 0)
    into v_uniques, v_total
    from pushes where room_id = v_room.id and day = v_day;

  return json_build_object(
    -- Suppressed below three distinct people, server side rather than in the client:
    -- a client-side hide still ships the real number to the browser.
    'suppressed', v_uniques < 3,
    'uniques',    case when v_uniques >= 3 then v_uniques end,
    'total',      case when v_uniques >= 3 then v_total   end,
    -- Returned only on this device's first press of the day. A repeat press is already
    -- counted in uniques, so there is no new fact to report and nothing to reward.
    'rank',       case when v_is_new then v_uniques end,
    'day',        v_day,
    'timezone',   v_room.timezone
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- history: per day figures for the chart
-- ---------------------------------------------------------------------------

create or replace function history(p_room_key text, p_days int default 90)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_room rooms%rowtype;
  v_days int;
  v_today date;
  v_result json;
begin
  if p_room_key !~ '^[a-f0-9]{64}$' then
    raise exception 'bad_request';
  end if;

  select * into v_room from rooms where room_key = p_room_key;
  if not found then
    raise exception 'no_room';
  end if;

  v_days  := least(greatest(coalesce(p_days, 90), 1), 365);
  v_today := (now() at time zone v_room.timezone)::date;

  -- Every day in the window, including days nobody pressed. A gap and a zero mean
  -- different things, and the chart should not have to guess which it is looking at.
  --
  -- The three person threshold applies to today only.
  --
  -- What makes a count of one re-identifying is knowing who is at their desk right now:
  -- on a small team, "one person has sighed today" beside a half empty office names
  -- somebody. Once the day is over that pairing is gone.
  --
  -- What is left is the cost of hiding it. A day the chart will not draw is a day that
  -- looks like nobody was there, and the one or two people who did press are exactly the
  -- ones who needed it counted. So a past day discloses whatever it was, however quiet.
  --
  -- Still decided in here rather than in the client, because a client side hide has
  -- already shipped the real number to the browser.
  select json_agg(row_to_json(d) order by d.day)
    into v_result
    from (
      select
        day,
        disclose as shown,
        case when disclose then uniques end as uniques,
        case when disclose then total   end as total
      from (
        select
          g.day::date               as day,
          coalesce(agg.uniques, 0)  as uniques,
          coalesce(agg.total, 0)    as total,
          (g.day::date < v_today or coalesce(agg.uniques, 0) >= 3) as disclose
        from generate_series((v_today - (v_days - 1))::timestamp,
                                 v_today::timestamp,
                                 interval '1 day') as g(day)
        left join (
          select day, count(*) as uniques, coalesce(sum(count), 0) as total
            from pushes
           where room_id = v_room.id
           group by day
        ) agg on agg.day = g.day::date
      ) counted
    ) d;

  return json_build_object(
    'days',     coalesce(v_result, '[]'::json),
    'today',    v_today,
    'timezone', v_room.timezone
  );
end;
$$;

-- ---------------------------------------------------------------------------
-- create_room: called by the Worker's admin path, never by the page
-- ---------------------------------------------------------------------------

create or replace function create_room(p_room_key text, p_label text default null,
                                       p_timezone text default 'America/New_York')
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if p_room_key !~ '^[a-f0-9]{64}$' then
    raise exception 'bad_request';
  end if;
  -- Rejects a duplicate rather than returning the existing room, so a collision is
  -- visible instead of silently joining two groups together.
  insert into rooms (room_key, label, timezone)
  values (p_room_key, p_label, coalesce(p_timezone, 'America/New_York'))
  returning id into v_id;
  return json_build_object('id', v_id);
exception
  -- Named so the caller can say "that phrase is already taken" rather than reporting a
  -- server fault for something the person can simply fix.
  when unique_violation then
    raise exception 'room_exists';
end;
$$;

-- ---------------------------------------------------------------------------
-- Only the service role may execute these
-- ---------------------------------------------------------------------------

revoke all on function push(text, text)               from public, anon, authenticated;
revoke all on function history(text, int)             from public, anon, authenticated;
revoke all on function create_room(text, text, text)  from public, anon, authenticated;

grant execute on function push(text, text)              to service_role;
grant execute on function history(text, int)            to service_role;
grant execute on function create_room(text, text, text) to service_role;
