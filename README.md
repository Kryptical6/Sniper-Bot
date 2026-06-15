# RBX Sniper Bot

A cautious, owner-only Discord bot that watches the Roblox limited market: it
posts new limiteds to a feed, recommends underpriced items by RoliMons data,
and (with layered safeguards) snipes deals listed below RAP — only ever buying
after you click **Buy**.

> ⚠️ **Heads up:** Automated purchasing on Roblox violates Roblox's Terms of
> Service and can put your account at risk. This bot stays low-profile (rate
> limiting, jittered timing, human-like pacing) but cannot make automation
> "safe" or invisible. Use a buying account you're willing to risk and
> understand the trade-off.

## Safety model

1. **Daily approval** — every day at 10:00 GMT the bot DMs you a go/no-go
   prompt. Until you press **Approve**, nothing is scanned or bought. No reply =
   full pause.
2. **Per-snipe confirmation** — every snipe waits for an explicit **Buy** click.
   No timeout by default; enable one with `/snipe set-timeout`.
3. **Daily cap** — hard spend ceiling per day (default **1,000 R$**).
4. **Per-item cap** — items above it are skipped before you're even prompted.
5. **Kill switch** — `/snipe pause` stops everything instantly.

Every guard is re-checked at click time, and the listing is re-validated (still
live, same price) before the purchase fires.

## Setup

1. `npm install`
2. Copy `.env.example` → `.env` and fill it in:
   - `DISCORD_TOKEN`, `DISCORD_CLIENT_ID`, `OWNER_ID` (your Discord user id)
   - `DATABASE_URL` (Railway Postgres)
   - `ROBLOSECURITY` (your `.ROBLOSECURITY` cookie), `ROBLOX_USER_ID`
   - `FEED_CHANNEL_ID` (optional; can also set via `/feed set-channel`)
3. `npm run register` — register slash commands (set `DEV_GUILD_ID` for instant
   registration during development).
4. `npm run build && npm start` (or `npm run dev`).

## Commands

| Command | Purpose |
| --- | --- |
| `/snipe config` / `status` | View settings / today's state |
| `/snipe enable` / `disable` / `pause` / `resume` | Master controls |
| `/snipe set-daily-cap` / `set-item-cap` | Spend limits |
| `/snipe set-threshold` / `set-floor` | Trigger criteria (% below RAP / price floor) |
| `/snipe set-timeout` | Per-snipe confirm timeout (0 = forever) |
| `/snipe watch` / `unwatch` / `watchlist` | Priority item watchlist |
| `/balance` | Live Robux + today's spend |
| `/recommend` | Top scored picks right now |
| `/stats [today\|week\|all]` | Spend, win rate, value acquired |
| `/history [limit]` | Recent snipe attempts |
| `/feed set-channel` / `toggle-events` / `toggle-ugc` | New-limiteds feed |

## Deploy (Railway)

- Add a PostgreSQL plugin; `DATABASE_URL` is provided automatically.
- Set the env vars above in the Railway service.
- Start command: `npm run build && npm start` (worker service — no HTTP port).

## Architecture

```
src/
  config/         env loading
  db/             pool + schema + typed helpers
  roblox/         authenticated Roblox client + RoliMons client
  services/       scoring, snipe engine, buy, feed, recommendations
  discord/        embeds, commands, registration, interaction router, notify
  scheduler/      daily approval cron + morning digest
  utils/          logger, sleep/jitter
  index.ts        wiring
```
