# Azakana backend (Phase 1: Instagram bot core)

Multi-shop DM sales bot. Instagram first; Facebook = one more adapter.

```
Instagram webhook → channels/instagram.ts (signature, parse, drop echoes)
  → core/pipeline.ts
      ingest: tenant lookup (shop_channels) → dedupe (unique message id)
      processConversation: advisory lock → batch pending msgs → bare oui/non in code
        → Gemini (function calling) → orders.ts validates → reply saved, then sent
      sweep: retries, crashed messages, failed sends, token expiry
  → Postgres
```

## Setup

1. Install Node 20+ and get a Postgres (Supabase / Neon, or local).
2. `npm install`
3. `cp .env.example .env` and fill it in.
4. `npm run migrate` then `npm run seed` (demo perfume shop).
5. Connect an Instagram account (dev mode):
   `npm run add-channel -- 1 <IG_ACCOUNT_ID> <ACCESS_TOKEN> 60 you@mail.com <TELEGRAM_CHAT_ID>`
6. `npm run dev`, expose with a tunnel (e.g. `ngrok http 3000`), then in the Meta app set the webhook to
   `https://<tunnel>/webhooks/instagram` with your `META_VERIFY_TOKEN`, and subscribe to **messages** only.

## Tests

`npm test` replays the plan's test set (§8) on a real Postgres with a fake model and fake channel.
Needs a database `azakana_test` (or set `TEST_DATABASE_URL`). **The test DB is wiped on every run.**

Covered: price question, full derja order, duplicate webhook, bare oui / non, oui with nothing pending,
2 messages in 1 s, out of stock, wrong variant, invalid phone, two customers on the last item,
stock gone between recap and oui, photo only, owner take-over, Gemini down, crash after dedupe,
failed send, same person on IG + FB, AI usage tracking.

## Hard rules enforced in code (not the prompt)

- Prices and stock only from the DB. The recap is written by code.
- Bare "oui" confirms only in `awaiting_confirmation`; otherwise it goes to the model, which can't confirm.
- Confirmation = one transaction with `SELECT ... FOR UPDATE` on variants.
- Phone: 8 Tunisian digits, `+216` and spaces stripped.
- Per-shop daily AI cap (`shops.daily_ai_cap`).

## Verify before going live

- Instagram webhook fields and send endpoint (`channels/instagram.ts`) against current Meta docs.
- Gemini model choice on real Tunisian conversations (`GEMINI_MODEL`).
- Recap / confirmation texts in `core/pipeline.ts` and `core/orders.ts` (French only for now).

## Next

- Phase 1 exit: replay 10–20 real pilot conversations through the bot on a test IG account.
- 1b: `channels/facebook.ts`.
- 2–3: owner app (orders, catalog table, take-over button), OAuth "Connect Instagram".
