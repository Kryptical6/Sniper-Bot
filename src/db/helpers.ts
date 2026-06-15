// ─────────────────────────────────────────────────────────────────────────────
// DB HELPERS — typed accessors over the schema
// ─────────────────────────────────────────────────────────────────────────────
import { query } from './index';
import { SniperConfig, SaleListing } from '../types';

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
    sellDefaultMarginPct: r.sell_default_margin_pct,
    unsoldNotifyHours: r.unsold_notify_hours,
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
  sellDefaultMarginPct: 'sell_default_margin_pct',
  unsoldNotifyHours: 'unsold_notify_hours',
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

/**
 * Atomically reserves daily spend before a purchase is fired. This prevents two
 * near-simultaneous Buy clicks from both passing the same stale cap check.
 */
export async function reserveDailySpend(robux: number, cap: number): Promise<boolean> {
  const { rows } = await query(
    `UPDATE daily_approvals
       SET spent_robux = spent_robux + $2
     WHERE approval_date = $1
       AND status = 'approved'
       AND spent_robux + $2 <= $3
     RETURNING spent_robux`,
    [todayUtc(), robux, cap]
  );
  return rows.length > 0;
}

/** Releases a prior reservation when Roblox rejects the purchase. */
export async function releaseDailySpend(robux: number): Promise<void> {
  await query(
    `UPDATE daily_approvals
       SET spent_robux = GREATEST(0, spent_robux - $2)
     WHERE approval_date = $1`,
    [todayUtc(), robux]
  );
}

/** True only when today is explicitly approved (and sniping not paused). */
export async function isSnipingAllowedToday(): Promise<boolean> {
  const appr = await getTodaysApproval();
  return appr?.status === 'approved';
}

// ─── Watchlist ───────────────────────────────────────────────────────────────
export interface WatchEntry {
  itemId: number;
  name: string;
  floor: number | null;
}

export async function addWatch(itemId: number, name = '', floor: number | null = null): Promise<void> {
  await query(
    `INSERT INTO watchlist (item_id, name, floor_robux) VALUES ($1, $2, $3)
     ON CONFLICT (item_id) DO UPDATE SET
       active = TRUE,
       name = COALESCE(NULLIF($2,''), watchlist.name),
       floor_robux = COALESCE($3, watchlist.floor_robux)`,
    [itemId, name, floor]
  );
}

export async function setWatchFloor(itemId: number, floor: number | null): Promise<void> {
  await query(`UPDATE watchlist SET floor_robux = $2 WHERE item_id = $1`, [itemId, floor]);
}

export async function removeWatch(itemId: number): Promise<void> {
  await query(`DELETE FROM watchlist WHERE item_id = $1`, [itemId]);
}

export async function listWatch(): Promise<WatchEntry[]> {
  const { rows } = await query(
    `SELECT item_id, name, floor_robux FROM watchlist WHERE active = TRUE ORDER BY added_at`
  );
  return rows.map(r => ({
    itemId: Number(r.item_id),
    name: r.name,
    floor: r.floor_robux ?? null,
  }));
}

/** Map of itemId → per-item floor for fast lookup in the engine. */
export async function getWatchFloorMap(): Promise<Map<number, number | null>> {
  const { rows } = await query(`SELECT item_id, floor_robux FROM watchlist WHERE active = TRUE`);
  const m = new Map<number, number | null>();
  for (const r of rows) m.set(Number(r.item_id), r.floor_robux ?? null);
  return m;
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

export async function updateAttemptOutcome(
  id: string,
  outcome: string,
  reason?: string
): Promise<void> {
  await query(
    `UPDATE snipe_attempts
       SET outcome = $2,
           reason = $3
     WHERE id = $1`,
    [id, outcome, reason ?? null]
  );
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

// ─── Sale listings (auto-sell) ───────────────────────────────────────────────
function mapListing(r: any): SaleListing {
  return {
    id: r.id,
    itemId: Number(r.item_id),
    itemName: r.item_name,
    userAssetId: Number(r.user_asset_id),
    costRobux: r.cost_robux,
    listPrice: r.list_price,
    netEstimate: r.net_estimate,
    status: r.status,
  };
}

/** Records a freshly-bought copy as a holding available to sell. */
export async function recordHolding(h: {
  itemId: number; itemName: string; userAssetId: number; costRobux: number;
}): Promise<void> {
  await query(
    `INSERT INTO sale_listings (item_id, item_name, user_asset_id, cost_robux, status)
     VALUES ($1,$2,$3,$4,'held')
     ON CONFLICT (user_asset_id) DO NOTHING`,
    [h.itemId, h.itemName, h.userAssetId, h.costRobux]
  );
}

export async function getHoldings(status?: SaleListing['status']): Promise<SaleListing[]> {
  const { rows } = status
    ? await query(`SELECT * FROM sale_listings WHERE status = $1 ORDER BY created_at DESC`, [status])
    : await query(`SELECT * FROM sale_listings WHERE status IN ('held','listed') ORDER BY created_at DESC`);
  return rows.map(mapListing);
}

export async function getListing(id: string): Promise<SaleListing | null> {
  const { rows } = await query(`SELECT * FROM sale_listings WHERE id = $1`, [id]);
  return rows[0] ? mapListing(rows[0]) : null;
}

export async function markListed(id: string, listPrice: number, netEstimate: number): Promise<void> {
  await query(
    `UPDATE sale_listings SET status='listed', list_price=$2, net_estimate=$3, listed_at=NOW()
     WHERE id=$1`,
    [id, listPrice, netEstimate]
  );
}

export async function markSold(id: string): Promise<void> {
  await query(`UPDATE sale_listings SET status='sold', sold_at=NOW() WHERE id=$1`, [id]);
}

export async function markCancelled(id: string): Promise<void> {
  await query(`UPDATE sale_listings SET status='cancelled' WHERE id=$1`, [id]);
}

/** Listings still unsold past the nag window and not yet (re)notified. */
export async function getStaleListings(hours: number): Promise<SaleListing[]> {
  const { rows } = await query(
    `SELECT * FROM sale_listings
     WHERE status='listed'
       AND listed_at < NOW() - ($1 || ' hours')::interval
       AND (notified_at IS NULL OR notified_at < NOW() - ($1 || ' hours')::interval)
     ORDER BY listed_at`,
    [hours]
  );
  return rows.map(mapListing);
}

export async function touchNotified(id: string): Promise<void> {
  await query(`UPDATE sale_listings SET notified_at=NOW() WHERE id=$1`, [id]);
}

export async function getRealizedPnl(): Promise<{ sold: number; proceeds: number; cost: number }> {
  const { rows } = await query(
    `SELECT COUNT(*)::int AS sold,
            COALESCE(SUM(net_estimate),0)::int AS proceeds,
            COALESCE(SUM(cost_robux),0)::int AS cost
     FROM sale_listings WHERE status='sold'`
  );
  return { sold: rows[0].sold, proceeds: rows[0].proceeds, cost: rows[0].cost };
}

// ─── Profile / inventory / history ───────────────────────────────────────────
/** Map of itemId → most recent cost we paid (for the inventory view). */
export async function getCostByItem(): Promise<Map<number, number>> {
  const { rows } = await query(
    `SELECT DISTINCT ON (item_id) item_id, cost_robux
     FROM sale_listings ORDER BY item_id, created_at DESC`
  );
  const m = new Map<number, number>();
  for (const r of rows) m.set(Number(r.item_id), r.cost_robux);
  return m;
}

/** Map of userAssetId → cost we paid, used for per-copy inventory basis. */
export async function getCostByUserAsset(): Promise<Map<number, number>> {
  const { rows } = await query(
    `SELECT user_asset_id, cost_robux
     FROM sale_listings`
  );
  const m = new Map<number, number>();
  for (const r of rows) m.set(Number(r.user_asset_id), r.cost_robux);
  return m;
}

/** Buy/sell history: every acquired copy with its outcome. */
export async function getTradeHistory(limit = 25): Promise<{
  itemId: number; itemName: string; cost: number;
  status: string; listPrice: number | null; netEstimate: number | null;
  soldAt: Date | null; createdAt: Date;
}[]> {
  const { rows } = await query(
    `SELECT item_id, item_name, cost_robux, status, list_price, net_estimate, sold_at, created_at
     FROM sale_listings ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows.map(r => ({
    itemId: Number(r.item_id),
    itemName: r.item_name,
    cost: r.cost_robux,
    status: r.status,
    listPrice: r.list_price,
    netEstimate: r.net_estimate,
    soldAt: r.sold_at ? new Date(r.sold_at) : null,
    createdAt: new Date(r.created_at),
  }));
}

// ─── Price alerts ────────────────────────────────────────────────────────────
export interface PriceAlert {
  id: string;
  itemId: number;
  itemName: string;
  direction: 'buy' | 'sell';
  targetPrice: number;
  active: boolean;
  lastPrice: number | null;
}

function mapAlert(r: any): PriceAlert {
  return {
    id: r.id, itemId: Number(r.item_id), itemName: r.item_name,
    direction: r.direction, targetPrice: r.target_price,
    active: r.active, lastPrice: r.last_price,
  };
}

export async function addAlert(a: {
  itemId: number; itemName: string; direction: 'buy' | 'sell'; targetPrice: number;
}): Promise<void> {
  await query(
    `INSERT INTO price_alerts (item_id, item_name, direction, target_price)
     VALUES ($1,$2,$3,$4)`,
    [a.itemId, a.itemName, a.direction, a.targetPrice]
  );
}

export async function removeAlert(id: string): Promise<void> {
  await query(`DELETE FROM price_alerts WHERE id = $1`, [id]);
}

export async function listAlerts(): Promise<PriceAlert[]> {
  const { rows } = await query(`SELECT * FROM price_alerts ORDER BY active DESC, created_at DESC`);
  return rows.map(mapAlert);
}

export async function getActiveAlerts(): Promise<PriceAlert[]> {
  const { rows } = await query(`SELECT * FROM price_alerts WHERE active = TRUE`);
  return rows.map(mapAlert);
}

export async function triggerAlert(id: string, price: number): Promise<void> {
  await query(
    `UPDATE price_alerts SET active = FALSE, triggered_at = NOW(), last_price = $2 WHERE id = $1`,
    [id, price]
  );
}

// ─── Movers snapshots ────────────────────────────────────────────────────────
export interface MoverSnapshot { itemId: number; rap: number; demand: number; trend: number; value: number; }

export async function getMoverSnapshots(): Promise<Map<number, MoverSnapshot>> {
  const { rows } = await query(`SELECT item_id, rap, demand, trend, value FROM movers_snapshots`);
  const m = new Map<number, MoverSnapshot>();
  for (const r of rows) m.set(Number(r.item_id), {
    itemId: Number(r.item_id), rap: r.rap, demand: r.demand, trend: r.trend, value: r.value,
  });
  return m;
}

export async function upsertMoverSnapshot(s: {
  itemId: number; name: string; rap: number; demand: number; trend: number; value: number;
}): Promise<void> {
  await query(
    `INSERT INTO movers_snapshots (item_id, name, rap, demand, trend, value, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,NOW())
     ON CONFLICT (item_id) DO UPDATE SET
       name=$2, rap=$3, demand=$4, trend=$5, value=$6, updated_at=NOW()`,
    [s.itemId, s.name, s.rap, s.demand, s.trend, s.value]
  );
}

export async function recentHistory(limit: number) {
  const { rows } = await query(
    `SELECT item_name, listed_price, rap_at_time, discount_percent, outcome, reason, created_at
     FROM snipe_attempts ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}
