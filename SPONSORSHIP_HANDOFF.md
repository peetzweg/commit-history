# Sponsorship work — where we left off

_Last touched 2026-06-28. Pick this up next session._

## TL;DR

Two parallel tracks for putting a sponsor row in the leaderboard:

1. **DB-driven ad slots (this branch, `feat/sponsorships`)** — the "real" system: sellable
   slots + Stripe. Built and visually verified, but **deliberately not shipped** — too risky to
   wire Stripe under time pressure. Parked here.
2. **Hardcoded self-promo (separate branch off `main`)** — a single, static "support me" row in
   the top slot. No DB, no Stripe. This is what we're actually shipping first.

## What's built on `feat/sponsorships` (this branch)

- **Schema** (`src/lib/db/schema.ts`): `ad_slots` (one row per purchasable position, keyed by
  `after_rank`; has `tier`, `price_weekly`, `checkout_url`, `enabled`) and `sponsorships` (a sold
  booking: `status`, creative `label`/`image_url`/`link_url`, `active_from`/`active_until`, Stripe
  ids). Migration: `drizzle/0004_careless_joystick.sql`.
- **Query** (`src/lib/commit-history.ts`): `queryAdSlots()` returns every enabled slot with its
  current active + in-window sponsor (or null). `getStartPageData` now also returns `adSlots`.
- **UI** (`src/routes/index.tsx`): `SponsorRow` renders between leaderboard ranks — sold (logo +
  label + "Sponsored", `rel="sponsored nofollow"`), unsold (dashed "Sponsor this spot · $X/wk" →
  Stripe link), or nothing if a slot has no `checkout_url`. A slot only shows when there's a real
  user below it.
- **Docs**: `SPONSORSHIP.md` — pricing + Stripe step-by-step.

## State of the world

- **Migration 0004 is NOT applied to production.** It was applied + seeded with demo data only on
  a throwaway Neon branch for the visual check. Prod schema is untouched (only the suspend
  migration `0003` is on prod).
- Verified visually on the Neon branch: both the unsold "Sponsor this spot" CTA and the sold
  "Sponsored" row render correctly between ranks. Looked good.
- The suspend feature (separate work) is merged to `main` via PR #14.

## Next steps when we resume the DB track

1. Decide final slot ranks + weekly prices (default idea: 5, 25, 50, 75, 100 — pricier higher up).
2. Create the Stripe Payment Links, store each in the slot's `checkout_url`.
3. Apply `0004` to prod, seed the real `ad_slots` rows.
4. (Path B) Add the Stripe webhook to write `sponsorships` rows on `checkout.session.completed`
   (status `pending_review`), then flip to `active` after eyeballing the creative.

## Notes

- `backups/` holds a local `pg_dump` of prod (gitignored — never commit it).
- Local preview against a non-prod DB needs a Neon branch connection string (the app's Neon HTTP
  driver can't talk to a plain local Postgres).
