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

// ─── Rolimons trade ads ──────────────────────────────────────────────────────
export interface AdEntry {
  id: string;
  offerItemId: number;
  offerItemName: string;
  requestItemIds: number[];
  requestTags: string[];
  autoReadvertise: boolean;
  lastPostedAt: Date | null;
}

function mapAd(r: any): AdEntry {
  return {
    id: r.id,
    offerItemId: Number(r.offer_item_id),
    offerItemName: r.offer_item_name,
    requestItemIds: (r.request_item_ids ?? []).map((x: any) => Number(x)),
    requestTags: r.request_tags ?? [],
    autoReadvertise: r.auto_readvertise,
    lastPostedAt: r.last_posted_at ? new Date(r.last_posted_at) : null,
  };
}

export async function upsertAd(a: {
  offerItemId: number; offerItemName: string;
  requestItemIds: number[]; requestTags: string[];
}): Promise<void> {
  await query(
    `INSERT INTO rolimons_ads (offer_item_id, offer_item_name, request_item_ids, request_tags)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (offer_item_id) DO UPDATE SET
       offer_item_name = COALESCE(NULLIF($2,''), rolimons_ads.offer_item_name),
       request_item_ids = $3, request_tags = $4`,
    [a.offerItemId, a.offerItemName, a.requestItemIds, a.requestTags]
  );
}

export async function removeAd(id: string): Promise<void> {
  await query(`DELETE FROM rolimons_ads WHERE id = $1`, [id]);
}

export async function listAds(): Promise<AdEntry[]> {
  const { rows } = await query(`SELECT * FROM rolimons_ads ORDER BY created_at`);
  return rows.map(mapAd);
}

export async function getAd(id: string): Promise<AdEntry | null> {
  const { rows } = await query(`SELECT * FROM rolimons_ads WHERE id = $1`, [id]);
  return rows[0] ? mapAd(rows[0]) : null;
}

export async function toggleAdAuto(id: string): Promise<boolean> {
  const { rows } = await query(
    `UPDATE rolimons_ads SET auto_readvertise = NOT auto_readvertise WHERE id = $1 RETURNING auto_readvertise`,
    [id]
  );
  return rows[0]?.auto_readvertise ?? false;
}

export async function markAdPosted(id: string): Promise<void> {
  await query(`UPDATE rolimons_ads SET last_posted_at = NOW() WHERE id = $1`, [id]);
}

/** Most recent post time across all ads (for the global 15-min cooldown). */
export async function lastAdPostTime(): Promise<Date | null> {
  const { rows } = await query(`SELECT MAX(last_posted_at) AS t FROM rolimons_ads`);
  return rows[0]?.t ? new Date(rows[0].t) : null;
}

export async function recentHistory(limit: number) {
  const { rows } = await query(
    `SELECT item_name, listed_price, rap_at_time, discount_percent, outcome, reason, created_at
     FROM snipe_attempts ORDER BY created_at DESC LIMIT $1`,
    [limit]
  );
  return rows;
}
