# Azakana

Multi-shop DM sales bot (Instagram + Facebook Messenger) with an owner app (French / Arabic).

```
Instagram / Facebook webhook → channels/instagram.ts | facebook.ts (shared Meta code in meta.ts)
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
5. Create the owner login: `npm run create-owner -- 1 99643383 <password> Iheb fr`
6. Connect accounts (dev mode):
   - Instagram: `npm run add-channel -- 1 instagram <IG_ACCOUNT_ID> <IG_TOKEN> 60 you@mail.com <TELEGRAM_CHAT_ID>`
   - Facebook: `npm run add-channel -- 1 facebook <PAGE_ID> <PAGE_TOKEN> 60`
7. `npm run dev` (API + bot) and `npm run dev:web` (owner app on :5173), expose with a tunnel (e.g. `ngrok http 3000`), then in the Meta app set the webhook to
   `https://<tunnel>/webhooks/instagram` (Instagram product) and `https://<tunnel>/webhooks/facebook` (Messenger product),
   with your `META_VERIFY_TOKEN`, and subscribe to **messages** only.

## Owner app (`web/`)

Phone + password login. Tabs: **Commandes** (status track, ship / deliver / cancel, call or WhatsApp the customer),
**Messages** (needs-attention first, take over / give back, reply from the app), **Catalogue** (+/- stock, add products
with variants, hide), **Réglages** (bot info, delivery, notifications, language).
`npm run build` compiles the API and the app; the server then serves the app at `/`.

Demo data for screenshots or prospect demos: `npm run demo` (wipes the DB). Login `99643383` / `demo1234`.

## Owner notifications

WhatsApp Cloud API from Azakana's own number, templates `azk_new_order` and `azk_attention` (text in
`src/notify/whatsapp.ts`, create them in WhatsApp Manager, category Utility). Paid per message.
Falls back to Telegram if WhatsApp isn't configured or a send fails. Attention alerts are throttled to 1 per conversation per 10 min.

## Hosting

Test: Neon free (Postgres) + Render free (sleeps after 15 min idle, ~1 min wake). Live: Railway Hobby (~$5/month, always on).
Build command `npm install && npm run build`, start command `npm run migrate && npm start`.

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

- Webhook fields and send endpoints (`channels/meta.ts`, `instagram.ts`, `facebook.ts`) against current Meta docs.
- Gemini model choice on real Tunisian conversations (`GEMINI_MODEL`).
- Recap / confirmation texts in `core/pipeline.ts` and `core/orders.ts` (French only for now).

## Next

- Phase 1 exit: replay 10–20 real pilot conversations through the bot on a test IG account.
- OAuth "Connect Instagram / Facebook" button (replaces `add-channel`).
- Product photos and customer photo matching.
