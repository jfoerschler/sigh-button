# Sigh

A button you press when work is being work. A press adds to the count without
recording anything about you. The count is shared, and it resets every day.

Open it on a bad afternoon and find out that eleven other people pressed it too.

## What is stored

Three things, and nothing else:

1. A room id (which group you are in)
2. A date
3. A per-day, per-room hash of a random id your browser generated, with a count

That is the entire database. No names, no email addresses, no accounts of any kind, no IP
addresses, and no timestamp finer than the day. Press times are left out deliberately,
because "who else was online at 9:47pm" is identifying on a small team.

## How anonymity actually works

Your browser generates a random id once and keeps it in local storage. The id itself
never leaves your machine. What gets sent is `SHA256(id + today + room)`.

Salting by the day gives a different stored value every day, so the server cannot tell
whether Monday's third presser is also Tuesday's fifth. Salting by the room makes the
same browser uncorrelatable across two groups.

There is deliberately no sign-in. A shared phrase identifies the *group*, which is a much
weaker thing than identifying the *person*. Signing in with a work account and storing a
hash of your email would not be anonymous at all: with a few dozen known coworkers,
anyone holding those hashes and a staff directory can recompute every one of them in
about a second. Hashes only protect high-entropy inputs, which is why the design uses a
random id instead of an identity.

## What this does not protect against

- **Cloudflare sits in front as CDN and rate limiter**, and sees request metadata the way
  any CDN does. It is not storing it for us, and we do not receive it.
- **Supabase hosts the database**, so they hold the rows described above.
- **The person running this can read the database.** That is [jfoerschler](https://github.com/jfoerschler/sigh-button).
  Nothing stops them. What protects you is that the rows do not identify anyone.
- **Small counts are revealing.** A count of 1 on a team of six is barely anonymous, so
  counts below three are never displayed.
- **Anyone with the phrase can inflate the number.** The headline figure counts distinct
  people rather than presses, which makes mashing pointless, but a determined person can
  still be dishonest.

## What it will never be used for

Assessing any person or any team. There is no manager view and no export, and no
per-person data exists to build one from. Everyone with the phrase sees the same number.

This is a counter. It is not an HR instrument or a complaint channel: nobody gets
notified, nothing gets escalated, and nothing here reaches anyone who could act on it.

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
