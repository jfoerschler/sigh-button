-- Run this if the database was created before quiet past days were charted.
--
-- The three person threshold now applies to today only. A past day returns whatever it
-- was, including a day with one person on it; today is still withheld below three.
-- schema.sql already contains this for fresh installs.
--
-- Nothing is dropped and no data changes. This replaces one function.

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
