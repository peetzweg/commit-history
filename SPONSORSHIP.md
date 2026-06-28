# Leaderboard Sponsorships

Everything for selling the ad slots on the commit-history.com leaderboard: pricing, the
Stripe setup (beginner step-by-step), and how to go live.

The ad slots are **spacer rows** inserted into the leaderboard after ranks **5, 25, 50, 75,
100** — they never replace a real developer. Higher up = more visible = more expensive. Sold in
**7-day terms** so you can reprice every week while you learn your real traffic.

---

## 1. Pricing tiers

A quick reality check first: the 165K Twitter impressions were the reach of **one post** — a
one-time spike, not weekly traffic, and not ad views. What a sponsor actually pays for is **weekly
views of their specific slot** = homepage visitors that week × the share who scroll deep enough to
see it. Almost everyone sees slot #5; almost nobody scrolls to #100. That's why slots get cheaper
with depth, and why 7-day terms matter — each week you measure the real number and reprice.

**Founding** = launch prices, deliberately low to fill all 5 slots fast and get logos on the board
(social proof sells the next buyer). **Standard** = where to move once you've measured a week of
real slot impressions.

| Slot | Position   | Tier     | Founding /wk | Standard /wk |
|------|------------|----------|--------------|--------------|
| 1    | after #5   | Prime    | **$60**      | $120–200     |
| 2    | after #25  | Premium  | **$35**      | $70          |
| 3    | after #50  | Standard | **$25**      | $45          |
| 4    | after #75  | Standard | **$18**      | $30          |
| 5    | after #100 | Basic    | **$12**      | $20          |

- All 5 sold at Founding: **~$150/wk (~$600/mo)**.
- All 5 sold at Standard: **~$285–365/wk (~$1.2–1.5K/mo)**.

**How to reprice with data:** target an effective **$25–50 CPM** (premium but fair for a GitHub
developer audience). After 2–3 weeks of a homepage view counter, recompute each slot as
`weekly_slot_views / 1000 × $35`. Raise underpriced slots, cut the ones nobody scrolls to.

**Who to pitch (lead with the 165K stat):** dev-tool startups (Raycast / Warp / Linear-likes),
hosting & CI companies, dev-focused VCs, and web3 infra.

---

## 2. Stripe setup — step by step (first time)

You'll create **one Product + one Payment Link per slot** (5 total). One link per slot is the
simplest possible mapping: each link's URL drops straight into that slot's `checkout_url`.

### A. One-time account setup
1. Go to <https://stripe.com> → **Start now / Sign up**. Create an account with your email.
2. You'll land in the **Dashboard**. Top-right has a **Test mode** toggle — leave it **ON** while
   you set everything up and test. Switch to live only when you're ready to take real money.
3. To take *real* payments you must **activate** the account: Dashboard → **Activate payments** (or
   the "Complete your profile" prompt). Stripe asks for business/personal details and a **bank
   account** for payouts. This verification can take a day or two — **start it now**, it doesn't
   block test-mode setup.

### B. Create a Product + Payment Link (do this 5 times, once per slot)
1. In the left sidebar: **Product catalog** → **+ Add product** (older UI: **Products → Add
   product**).
2. **Name** and **Description**: copy from the table in section 3 below (e.g. `Slot #5 on
   commit-history.com — Prime`).
3. **Pricing:**
   - Price = the slot's Founding price (e.g. `60.00`), currency USD.
   - Billing = **One time** (NOT recurring — one-time lets you reprice every 7 days freely).
   - Save the product.
4. Now make a link for it: left sidebar **Payment Links** → **+ New** (or **Create payment link**).
   - Pick the product you just created.
   - **Collect customer info** → make sure **email** is on (default).
   - **Add custom fields** (so you get the creative without a back-and-forth):
     - Text field labelled **"Company / display name"**
     - Text field labelled **"Destination URL (where the ad links to)"**
     - Text field labelled **"Logo image URL"** (optional — or just have them email the logo)
   - Optionally set **"After payment"** → show a confirmation message like "Thanks! We'll have your
     slot live within 24h once we've added your logo."
   - **Create link.** Stripe gives you a URL like `https://buy.stripe.com/test_abc123` (test mode)
     or `https://buy.stripe.com/abc123` (live). **Copy it** — this is the slot's `checkout_url`.
5. Repeat steps 1–4 for slots #25, #50, #75, #100.

### C. Test it (test mode)
- Open one of your payment links and pay with Stripe's **test card**: number `4242 4242 4242
  4242`, any future expiry, any CVC, any ZIP. No real money moves.
- Confirm the payment shows in Dashboard → **Payments**.

### D. Go live
- Flip **Test mode OFF**, then **re-create the products and links in live mode** (test and live are
  separate — test links don't work for real cards). Use the new **live** `buy.stripe.com/...` URLs
  as your `checkout_url` values.

> Note: there's no code/API/webhook to set up for this. It's all dashboard + Payment Links. (When
> manual fulfillment gets old, "Path B" automates it with a webhook — see section 6.)

---

## 3. Product names + descriptions (copy-paste)

| Product name | Description (shown at checkout) |
|---|---|
| **Slot #5 on commit-history.com — Prime** | The #1 sponsor position: pinned right beneath the top 5 developers on the all-time GitHub commit leaderboard — the first thing every visitor sees. 7-day placement, your logo + link. We'll request your creative right after checkout. |
| **Slot #25 on commit-history.com — Premium** | Premium sponsor placement inside the leaderboard at rank 25 on commit-history.com, in front of a developer audience browsing the all-time GitHub commit rankings. 7-day placement, your logo + link. |
| **Slot #50 on commit-history.com** | Standard sponsor placement at rank 50 in the commit-history.com leaderboard. 7 days of exposure to developers exploring GitHub commit history. Your logo + link. |
| **Slot #75 on commit-history.com** | Sponsor placement at rank 75 in the commit-history.com leaderboard. 7-day developer-audience placement with your logo + link. |
| **Slot #100 on commit-history.com** | Entry-level sponsor placement at rank 100 in the commit-history.com leaderboard. 7 days, your logo + link — a low-cost way to reach a developer audience. |

---

## 4. Wire it up in the app

1. **Run the migration** (creates the `ad_slots` + `sponsorships` tables and seeds the 5 slots with
   the founding prices):
   ```bash
   npm run db:migrate
   ```
2. **Paste each Payment Link** into its slot. The CTA ("Sponsor this spot · $X/wk →") appears on the
   leaderboard the moment a slot has a `checkout_url`:
   ```sql
   UPDATE ad_slots SET checkout_url = 'https://buy.stripe.com/...' WHERE after_rank = 5;
   UPDATE ad_slots SET checkout_url = 'https://buy.stripe.com/...' WHERE after_rank = 25;
   UPDATE ad_slots SET checkout_url = 'https://buy.stripe.com/...' WHERE after_rank = 50;
   UPDATE ad_slots SET checkout_url = 'https://buy.stripe.com/...' WHERE after_rank = 75;
   UPDATE ad_slots SET checkout_url = 'https://buy.stripe.com/...' WHERE after_rank = 100;
   ```
   (Run SQL via the Neon console → SQL editor, or `npm run db:studio` if configured.)

---

## 5. Running it week to week

**When someone buys** (Stripe emails you the payment + the custom fields), add their creative. It
auto-expires after 7 days:
```sql
INSERT INTO sponsorships (id, after_rank, status, label, image_url, link_url, active_from, active_until)
VALUES (
  'acme-2026-06-28',          -- any unique id (e.g. company + date)
  5,                          -- which slot they bought
  'active',                   -- flip to 'active' once you've reviewed the creative
  'Acme — ship faster',       -- the row text
  'https://acme.com/logo.png',-- logo (or NULL)
  'https://acme.com',         -- where the ad links to
  now(),
  now() + interval '7 days'   -- auto-expires; the slot frees itself
);
```

**To reprice a slot** (no redeploy — takes effect on next page load):
```sql
UPDATE ad_slots SET price_weekly = 90 WHERE after_rank = 5;
```

**To pull a sponsor early / handle a refund:**
```sql
UPDATE sponsorships SET status = 'cancelled' WHERE id = 'acme-2026-06-28';
```

**To disable a slot entirely** (hide it from the board):
```sql
UPDATE ad_slots SET enabled = false WHERE after_rank = 100;
```

---

## 6. Later: Path B (automated)

When manual fulfillment gets tedious, the `sponsorships` table is already the exact shape a Stripe
webhook needs — no schema change. Path B adds:
- `npm i stripe`
- a "create checkout session" server function (with an availability check so a slot can't be
  double-sold),
- a webhook route that writes the `sponsorships` row on `checkout.session.completed` and clears it
  on expiry/cancellation.

Until then, the Payment Link + manual SQL flow above is all you need.
