// ─────────────────────────────────────────────────────────────────────────────
// DB HELPERS — typed accessors over the schema
// ─────────────────────────────────────────────────────────────────────────────
import { query } from './index';
import { SniperConfig } from '../types';

// ─── Config ──────────────────────────────────────────────────────────────────
export async function getConfig(): Promise<SniperConfig> {
  const { rows } = await query(`SELECT * FROM sniper_config WHERE id = 1`);
  const r = rows[0];
  return {
    enabled: r.enabled,
    paused: r.paused,
    dailyCapRobux: r.daily_cap_robux,
    itemCapRobux: r.item_cap_robux,
    thresholdPercent: r.threshold_percent,
    floorRobux: r.floor_robux,
    confirmTimeoutSeconds: r.confirm_timeout_seconds,
    feedChannelId: r.feed_channel_id,
    feedIncludeEvents: r.feed_include_events,
    feedIncludeUgc: r.feed_include_ugc,
    pollIntervalSeconds: r.poll_interval_seconds,
    recommendAlertThreshold: r.recommend_alert_threshold,
  };
}

const COLUMN_MAP: Record<keyof SniperConfig, string> = {
  enabled: 'enabled',
  paused: 'paused',
  dailyCapRobux: 'daily_cap_robux',
  itemCapRobux: 'item_cap_robux',
  thresholdPercent: 'threshold_percent',
  floorRobux: 'floor_robux',
  confirmTimeoutSeconds: 'confirm_timeout_seconds',
  feedChannelId: 'feed_channel_id',
  feedIncludeEvents: 'feed_include_events',
  feedIncludeUgc: 'feed_include_ugc',
  pollIntervalSeconds: 'poll_interval_seconds',
  recommendAlertThreshold: 'recommend_alert_threshold',
};

export async function setConfig<K extends keyof SniperConfig>(
  key: K,
  value: SniperConfig[K]
): Promise<void> {
  const col = COLUMN_MAP[key];
  await query(
    `UPDATE sniper_config SET ${col} = $1, updated_at = NOW() WHERE id = 1`,
    [value]
  );
}

// ─── Daily approval ──────────────────────────────────────────────────────────
function todayUtc(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function getTodaysApproval(): Promise<{
  status: 'pending' | 'approved' | 'paused';
  spentRobux: number;
} | null> {
  const { rows } = await query(
    `SELECT status, spent_robux FROM daily_approvals WHERE approval_date = $1`,
    [todayUtc()]
  );
  if (!rows[0]) return null;
  return { status: rows[0].status, spentRobux: rows[0].spent_robux };
}

export async function ensureTodaysApprovalRow(dmMessageId?: string): Promise<void> {
  await query(
    `INSERT INTO daily_approvals (approval_date, dm_message_id)
     VALUES ($1, $2)
     ON CONFLICT (approval_date) DO UPDATE SET dm_message_id = COALESCE($2, daily_approvals.dm_message_id)`,
    [todayUtc(), dmMessageId ?? null]
  );
}

export async function setApprovalStatus(status: 'approved' | 'paused'): Promise<void> {
  await query(
    `INSERT INTO daily_approvals (approval_date, status, decided_at)
     VALUES ($1, $2, NOW())
     ON CONFLICT (approval_date) DO UPDATE SET status = $2, decided_at = NOW()`,
    [todayUtc(), status]
  );
}

export async function addDailySpend(robux: number): Promise<void> {
  await query(
    `UPDATE daily_approvals SET spent_robux = spent_robux + $2 WHERE approval_date = $1`,
    [todayUtc(), robux]
  );
}

/** True only when today is explicitly approved (and sniping not paused). */
export async function isSnipingAllowedToday(): Promise<boolean> {
  const appr = await getTodaysApproval();
  return appr?.status === 'approved';
}

// ─── Watchlist ───────────────────────────────────────────────────────────────
export async function addWatch(itemId: number, name = ''): Promise<void> {
  await query(
    `INSERT INTO watchlist (item_id, name) VALUES ($1, $2)
     ON CONFLICT (item_id) DO UPDATE SET active = TRUE, name = COALESCE(NULLIF($2,''), watchlist.name)`,
    [itemId, name]
  );
}

export async function removeWatch(itemId: number): Promise<void> {
  await query(`DELETE FROM watchlist WHERE item_id = $1`, [itemId]);
}

export async function listWatch(): Promise<{ itemId: number; name: string }[]> {
  const { rows } = await query(
    `SELECT item_id, name FROM watchlist WHERE active = TRUE ORDER BY added_at`
  );
  return rows.map(r => ({ itemId: Number(r.item_id), name: r.name }));
}

// ─── Attempts & purchases ────────────────────────────────────────────────────
export interface AttemptInput {
  itemId: number;
  itemName: string;
  userAssetId?: number;
  listedPrice: number;
  rapAtTime?: number;
  projectedAtTime?: number;
  discountPercent?: number;
  score?: number;
  outcome: string;
  reason?: string;
}

export async function recordAttempt(a: AttemptInput): Promise<string> {
  const { rows } = await query(
    `INSERT INTO snipe_attempts
       (item_id, item_name, user_asset_id, listed_price, rap_at_time,
        projected_at_time, discount_percent, score, outcome, reason)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     RETURNING id`,
    [a.itemId, a.itemName, a.userAssetId ?? null, a.listedPrice, a.rapAtTime ?? null,
     a.projectedAtTime ?? null, a.discountPercent ?? null, a.score ?? null, a.outcome, a.reason ?? null]
  );
  return rows[0].id;
}

export async function recordPurchase(p: {
  attemptId: string;
  itemId: number;
  itemName: string;
  robuxSpent: number;
  rapAtTime?: number;
  userAssetId?: number;
}): Promise<void> {
  await query(
    `INSERT INTO purchase_history
       (attempt_id, item_id, item_name, robux_spent, rap_at_time, user_asset_id)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [p.attemptId, p.itemId, p.itemName, p.robuxSpent, p.rapAtTime ?? null, p.userAssetId ?? null]
  );
}

// ─── Feed dedup ──────────────────────────────────────────────────────────────
export async function alreadyPosted(itemId: number): Promise<boolean> {
  const { rows } = await query(`SELECT 1 FROM feed_posts WHERE item_id = $1`, [itemId]);
  return rows.length > 0;
}

export async function markPosted(itemId: number, name: string, messageId?: string): Promise<void> {
  await query(
    `INSERT INTO feed_posts (item_id, name, discord_message_id) VALUES ($1,$2,$3)
     ON CONFLICT (item_id) DO NOTHING`,
    [itemId, name, messageId ?? null]
  );
}

// ─── Stats ───────────────────────────────────────────────────────────────────
export async function getStats(period: 'today' | 'week' | 'all') {
  const clause =
    period === 'today' ? `created_at >= date_trunc('day', NOW())`
    : period === 'week' ? `created_at >= NOW() - INTERVAL '7 days'`
    : `TRUE`;
  const pClause =
    period === 'today' ? `confirmed_at >= date_trunc('day', NOW())`
    : period === 'week' ? `confirmed_at >= NOW() - INTERVAL '7 days'`
    : `TRUE`;

  const attempts = await query(
    `SELECT outcome, COUNT(*)::int AS n FROM snipe_attempts WHERE ${clause} GROUP BY outcome`
  );
  const purchases = await query(
    `SELECT COUNT(*)::int AS n, COALESCE(SUM(robux_spent),0)::int AS spent,
            COALESCE(SUM(rap_at_time),0)::int AS rap_value
     FROM purchase_history WHERE ${pClause}`
  );

  const byOutcome: Record<string, number> = {};
  for (const r of attempts.rows) byOutcome[r.outcome] = r.n;

  return {
    byOutcome,
    bought: purchases.rows[0].n as number,
    spent: purchases.rows[0].spent as number,
    rapValue: purchases.rows[0].rap_value as number,
  };
}

export async function recentHistory(limit: number) {
  const { rows } = await query(
    `SELECT item_name, listed_price, rap_at_time, discount_percent, outcome, reason, created_at
     FROM snipe_attempts ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}
