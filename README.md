# Sigh

A button you press when work is being work. It records that *someone* pressed it, never
who. The count is shared and resets every day.

The point is not the venting. The point is opening it on a bad afternoon and finding out
that eleven other people pressed it too.

## What is stored

Three things, and nothing else:

1. A room id (which group you are in)
2. A date
3. A per-day, per-room hash of a random id your browser generated, with a count

That is the entire database. To be explicit about what is *not* there: no names, no
email addresses, no BU credentials, no IP addresses, and no timestamps more precise than
the day. Press times are left out on purpose, because "who else was online at 9:47pm" is
identifying on a small team.

## How anonymity actually works

Your browser generates a random id once and keeps it in local storage. It is never sent.
What gets sent is `SHA256(id + today + room)`.

Salting by the day means the stored value is different every day, so the server cannot
tell whether Monday's third presser is Tuesday's fifth. Salting by the room means the
same browser is uncorrelatable across two different groups.

There is deliberately no sign-in. A shared phrase identifies the *group*, which is a
different thing from identifying the *person*. Signing in with BU credentials and storing
a hash of your email would not be anonymous: with a few dozen known coworkers, anyone
holding those hashes and a staff directory can recompute all of them in about a second.
Hashes only protect high-entropy inputs, which is why the design uses a random id instead
of an identity.

## What this does not protect against

Said plainly, because a tool like this is worth less than nothing if it overclaims:

- **Cloudflare sits in front as CDN and rate limiter**, and sees request metadata the way
  any CDN does. It is not storing it for us, and we do not receive it.
- **Supabase hosts the database**, so they hold the rows described above.
- **The person running this can read the database.** That is Jonathan Foerschler. The
  rows do not identify anyone, which is the protection; it is not that access is
  impossible.
- **Small counts are revealing.** A count of 1 on a team of six is not very anonymous, so
  counts below three are not displayed at all.
- **Anyone with the phrase can inflate the number.** The headline figure counts distinct
  people rather than presses, which makes mashing pointless, but nothing here stops a
  determined person from being dishonest.

## What it will never be used for

Assessing any person or any team. There is no manager view, no export, and no per-person
data to build one from. Everyone with the phrase sees exactly the same number.

This is not an HR instrument and not a complaint channel. Nobody is notified, nothing is
escalated, and nothing here reaches anyone who could act on it. It is a counter.

## Layout

- `web/` is the static page, served by GitHub Pages. No build step, no dependencies. What
  is committed is exactly what runs, so you can read it.
- `worker/` is a Cloudflare Worker at `/api/*` that holds the database key and applies
  rate limits.
- `supabase/` holds the schema and the two database functions.

## Running it yourself

See `docs/SETUP.md` once the build is complete.

## License

MIT
