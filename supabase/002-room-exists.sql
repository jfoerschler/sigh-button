-- Run this if the database was created before the admin page existed.
-- Adds a named error for a duplicate phrase so the page can say "already taken" instead
-- of reporting a server fault. schema.sql already contains this for fresh installs.

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
  when unique_violation then
    raise exception 'room_exists';
end;
$$;

