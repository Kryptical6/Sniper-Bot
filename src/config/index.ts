// ─────────────────────────────────────────────────────────────────────────────
// CONFIG — environment loading & validation
// ─────────────────────────────────────────────────────────────────────────────
import 'dotenv/config';

function req(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`[CONFIG] Missing required env var: ${key}`);
  return v;
}

function opt(key: string, fallback: string): string {
  return process.env[key] ?? fallback;
}

export const config = {
  discord: {
    token: req('DISCORD_TOKEN'),
    clientId: req('DISCORD_CLIENT_ID'),
    ownerId: req('OWNER_ID'),
    devGuildId: process.env.DEV_GUILD_ID || undefined,
    feedChannelId: process.env.FEED_CHANNEL_ID || undefined,
  },
  databaseUrl: req('DATABASE_URL'),
  roblox: {
    cookie: req('ROBLOSECURITY'),
    userId: req('ROBLOX_USER_ID'),
  },
  poll: {
    intervalSeconds: parseInt(opt('POLL_INTERVAL_SECONDS', '15'), 10),
    // jitter applied as a fraction of the base interval (±30%)
    jitterFraction: 0.3,
  },
  dailyApprovalHourGmt: parseInt(opt('DAILY_APPROVAL_HOUR_GMT', '10'), 10),
} as const;
