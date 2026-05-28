# saasmail

Self-hosted email server on Cloudflare Workers. See README.md for full documentation.

## Serendipia Mail fork — divergences from upstream

This instance (Serendipia Mail) is tuned to run on the **Cloudflare Workers
Free plan**. It deliberately diverges from upstream saasmail in a few places.
When reading README.md or the onboarding skill, prefer the rules below — they
override upstream where they conflict.

- **No Cloudflare Queues.** Queues require the Workers Paid plan. Sequence
  emails are dispatched **inline by the cron trigger** (`handleScheduled` in
  `worker/src/lib/sequence-processor.ts`) and at enrollment time, not via a
  producer/consumer queue. The cron claims each due row (`pending` →
  `queued`), processes it, and resets to `pending` on an unexpected throw so
  the next tick retries. Throughput is capped at `MAX_EMAILS_PER_RUN` per
  tick — lower the cron interval in `wrangler.jsonc` for more.
- **Durable Objects use the SQLite backend** (`new_sqlite_classes`), which is
  available on the Free plan. `NotificationsHub` only uses WebSocket
  hibernation + D1, so realtime notifications still work.
- **Outbound provider is Resend.** Set `RESEND_API_KEY` as a secret. The
  Cloudflare Email Sending (`send_email` / `EMAIL`) path is left in place but
  unused.
- **Do NOT reintroduce Queues** or a Workers-Paid-only feature without
  flagging it — it breaks the free-plan deploy.

### Deliverability / compliance / analytics added in this fork

- `suppressions` table + `worker/src/lib/suppression.ts` — global suppression
  list (bounce / complaint / unsubscribe / manual), severity-ranked upserts.
  Enforced in `send-router` and `sequence-processor`.
- Public `/u/:token` — RFC 8058 one-click unsubscribe (HMAC-signed token).
- `List-Unsubscribe` + `List-Unsubscribe-Post` headers on bulk sends.
- Inbound bounce detection (`worker/src/lib/detect-bounce.ts`) and
  `POST /webhooks/resend` both feed the suppression list.
- `email_events` table + `/t/o/:token` (open pixel) and `/t/c/:token`
  (click redirect); per-message stats at `GET /api/stats/sent-email/:id`.

### Extra secrets (beyond upstream)

- `UNSUBSCRIBE_TOKEN_SECRET` — **required** for marketing sends. HMAC key for
  unsubscribe + tracking tokens. Generate with `openssl rand -hex 32`.
- `RESEND_WEBHOOK_SECRET` — only if wiring the Resend webhook (`whsec_…`).

## Development

- Use `yarn` for all dependency commands (not npm)
- Backend: Hono + Zod OpenAPI routes in `worker/src/routers/`
- Frontend: React + Tailwind in `src/`
- Database: Drizzle ORM with D1 in `worker/src/db/`
- Run `yarn tsc --noEmit` to type-check before committing
- Run `yarn test` for tests

## Skills

- `/saasmail-onboarding` — Interactive setup wizard for deploying a new saasmail instance
