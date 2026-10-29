# Stomiko

Clinic software for a private dental practice, built as a Telegram Mini App. [Русская версия](README.ru.md)

Most dental software is a booking calendar. Stomiko is built around the **cost chain** instead:

```
chair booking → visit closed from the dentist's phone → materials written off by the treatment card
   → cost of the visit → margin per service per month
```

There is no "write off" button anywhere — not in the UI, not in the API. Stock moves only when a visit is closed.

**Status:** MVP, built by Alrevion in August–September 2026 and demoed to dentists in Uzbekistan. We found no demand in
the region and stopped development. Published as part of our portfolio.

## Layout

| Package | What it is |
|---|---|
| `packages/core` | FEFO allocator and exact money arithmetic. Pure functions, no database access |
| `packages/db` | SQL migrations (Postgres / Supabase) — the source of truth for the schema |
| `apps/api` | Hono on Cloudflare Workers: Telegram sign-in, visit closing, reports |
| `apps/miniapp` | Telegram Mini App for the dentist. Four screens, no build step |

Patients book through a Telegram link; the dentist closes the visit on the phone and sees stock and margins.

## What is guaranteed, and how

| Property | How it holds |
|---|---|
| Closing a visit is never rejected for lack of stock | A shortage becomes a `shortfall` stock movement, not an error |
| Visit cost adds up to the last tiyin | Cost by share of batch, cumulative flooring, `bigint` without floats |
| An unknown price never pretends to be zero | Schema `CHECK unpriced = (cost is null)`; the margin shows "not calculated" |
| A retry after a network drop never writes off twice | Conditional `UPDATE … WHERE status='open'` inside `apply_visit_close` |
| Two parallel closes never take the same batch twice | Optimistic `qty_remaining` check plus `FOR UPDATE` in `id` order |
| Stock never drifts silently | `reconcile_batches()` runs on the stock screen, not only in tests |
| Tenant isolation | Repository layer `tenantScoped()`; Postgres RLS as defence in depth |

## Run

```bash
pnpm install
pnpm test
cp apps/api/.dev.vars.example apps/api/.dev.vars   # SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, TELEGRAM_BOT_TOKEN
cd apps/api && pnpm dev
```

## Known simplifications

- Demo binding: `DEMO_AUTO_JOIN=true` attaches the first Telegram user to the only practice. Must be off in production.
- The margin report spreads cost across services in proportion to revenue; exact split needs `visit_service_id` on stock movements.
- Supabase types are not generated while the schema still changes often.

---

© 2026 Alrevion. Source published for review; all rights reserved.
