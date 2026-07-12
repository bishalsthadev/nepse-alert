# nepse-alert

A personal **NEPSE (Nepal Stock Exchange)** assistant — price/threshold alerts, portfolio
tracking, market news, and a technical screener — delivered **Telegram-first** with a
read/write **web dashboard**. Runs entirely on **Cloudflare Workers** (free tier).

## Features

- **Price alerts** — buy/sell thresholds, % moves, volume spikes → pushed to Telegram
- **Portfolio** — record holdings, track live value and P/L
- **News signals** — latest NEPSE headlines, dividends, IPOs (scraped from ShareSansar)
- **Technical screener** — SMA / EMA / RSI / MACD over accumulated daily history
- **Web dashboard** — market overview + searchable stock picker, holding & alert forms
  (personal data gated by an access key)

## Architecture

100% Cloudflare, 100% TypeScript, no servers to run:

| Concern | Tech |
|---|---|
| Compute | Cloudflare Workers |
| Scheduling | Cron Triggers (Mon–Fri, NPT market hours) |
| Database | Cloudflare D1 (SQLite), behind a swappable `src/db` repo layer |
| Cache | Cloudflare KV (latest prices + alert dedupe) |
| Telegram | grammY (webhook) |
| Scraping | native `HTMLRewriter` |

NEPSE has no official public API; live data is fetched via its token-authenticated
endpoints (the token is derived in pure TS — see `src/nepse/token.ts`). News comes from
ShareSansar. Historical OHLC accumulates from the daily EOD job.

## Project layout

```
src/
  index.ts          Worker entry: HTTP routes (dashboard, API, webhook) + cron dispatch
  env.ts            Bindings & secrets
  nepse/            NEPSE client, token derivation, securities sync, news scraper
  bot/              grammY Telegram bot + commands
  alerts/           alert rule evaluation + dispatch
  screener/         indicators (SMA/EMA/RSI/MACD) + screen logic
  jobs/             EOD OHLC persistence, news digest
  db/               D1 repository layer (only code that touches the DB)
  web/              dashboard HTML + JSON API
migrations/         D1 schema
```

## Setup

```bash
npm install
# Create resources (once) and wire the printed IDs into wrangler.toml:
npx wrangler d1 create nepse_alert
npx wrangler kv namespace create CACHE
npx wrangler d1 migrations apply nepse_alert --remote

# Secrets:
printf '%s' '<botfather-token>'  | npx wrangler secret put TELEGRAM_BOT_TOKEN
printf '%s' '<random-string>'    | npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
printf '%s' '<your-telegram-id>' | npx wrangler secret put OWNER_TELEGRAM_ID   # locks bot to you
printf '%s' '<web-passphrase>'   | npx wrangler secret put WEB_ACCESS_KEY      # gates web portfolio

npx wrangler deploy

# Register the Telegram webhook:
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d "url=https://<your-domain>/telegram/<TELEGRAM_WEBHOOK_SECRET>" \
  -d "secret_token=<TELEGRAM_WEBHOOK_SECRET>" \
  --data-urlencode 'allowed_updates=["message"]'
```

## Bot commands

`/price` `/watch` `/unwatch` `/watchlist` · `/alert` `/alerts` `/delalert` ·
`/buy` `/sell` `/portfolio` `/pnl` · `/news` `/ta` `/screen`

## Notes

- Trading days are **Mon–Fri**, 11:00–15:00 NPT.
- The screener needs ~20 trading days of accumulated history per symbol to produce signals.
- For educational/personal use; not affiliated with NEPSE. Data accuracy not guaranteed.
