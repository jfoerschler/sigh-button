-- Run in the Supabase SQL editor when the Worker reports "permission denied for function".
--
-- Postgres error 42501 has two plausible causes and they need opposite fixes:
--   a) the grants in schema.sql never applied, so nobody can execute the functions
--   b) the Worker is presenting the anon key, and anon was revoked on purpose
--
-- This tells you which.

select
  p.proname          as function,
  r.rolname          as role,
  has_function_privilege(r.rolname, p.oid, 'EXECUTE') as can_execute
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
cross join (values ('anon'), ('authenticated'), ('service_role')) as r(rolname)
where n.nspname = 'public'
  and p.proname in ('push', 'history', 'create_room')
order by p.proname, r.rolname;

-- Reading it:
--
--   service_role can_execute = true   -> the grants are correct. The secret is holding
--                                        the anon key, not the service role key. Replace
--                                        SUPABASE_SERVICE_KEY and redeploy. Nothing to
--                                        change in the database.
--
--   service_role can_execute = false  -> the grants did not apply. Re-run the grant block
--                                        at the bottom of schema.sql, reproduced here:

-- revoke all on function push(text, text)              from public, anon, authenticated;
-- revoke all on function history(text, int)            from public, anon, authenticated;
-- revoke all on function create_room(text, text, text) from public, anon, authenticated;
--
-- grant execute on function push(text, text)              to service_role;
-- grant execute on function history(text, int)            to service_role;
-- grant execute on function create_room(text, text, text) to service_role;

-- If this returns no rows at all, the functions do not exist in the public schema and
-- schema.sql did not finish. Re-run it in full.
