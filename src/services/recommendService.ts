// ─────────────────────────────────────────────────────────────────────────────
// RECOMMEND SERVICE
//
// Produces ranked buy recommendations from the RoliMons universe filtered to
// what the owner can actually afford, scored by the shared scoring model.
//
//   - computeRecommendations(): on-demand list (used by /recommend & digest)
//   - realtime alerts: a lightweight scan that DMs the owner when a fresh
//     "good deal" (score >= configured threshold) appears, throttled per item.
// ─────────────────────────────────────────────────────────────────────────────
import { log } from '../utils/logger';
import { rolimons } from '../roblox/rolimons';
import { roblox } from '../roblox/client';
import { getConfig } from '../db/helpers';
import { query } from '../db';
import { scoreItem, ScoreBreakdown } from './scoring';
import { realtimeRecEmbed, recommendEmbed } from '../discord/embeds';
import { dmOwner } from '../discord/notify';
import { RoliItem } from '../types';
import { sleep } from '../utils/sleep';

export interface Pick {
  item: RoliItem;
  price: number;
  breakdown: ScoreBreakdown;
}

/**
 * Ranks affordable limiteds. Uses RoliMons RAP as the price proxy for breadth
 * (live reseller lookups for the whole universe would be too many requests);
 * the top picks are good candidates for a closer look or /snipe watch.
 */
export async function computeRecommendations(limit = 8): Promise<{ picks: Pick[]; balance: number }> {
  await rolimons.refresh();
  const balance = await roblox.getBalance().catch(() => 0);

  const picks: Pick[] = [];
  for (const item of rolimons.all()) {
    const price = item.rap; // proxy; refined on demand for the shortlist below
    if (price <= 0 || price > balance) continue;       // affordability filter
    if (item.demand < 1) continue;                      // skip unrated/terrible demand
    const breakdown = scoreItem(price, item, balance, estimateActivity(item));
    picks.push({ item, price, breakdown });
  }

  picks.sort((a, b) => b.breakdown.total - a.breakdown.total);
  const shortlist = picks.slice(0, limit);

  // Refine the shortlist with live cheapest listing for accuracy.
  for (const p of shortlist) {
    const listings = await roblox.getResellers(p.item.id, 1).catch(() => []);
    if (listings[0]) {
      p.price = listings[0].price;
      p.breakdown = scoreItem(p.price, p.item, balance, estimateActivity(p.item));
    }
    await sleep(400);
  }
  shortlist.sort((a, b) => b.breakdown.total - a.breakdown.total);

  return { picks: shortlist, balance };
}

export function buildRecommendEmbed(picks: Pick[], balance: number) {
  return recommendEmbed(picks, balance);
}

// ─── Real-time alerts ────────────────────────────────────────────────────────
const RECENT_ALERT_HOURS = 6;

export function startRecommendAlerts(): void {
  log.info('RECOMMEND', 'Real-time alert scanner started');
  void loop();
}

async function loop(): Promise<void> {
  while (true) {
    try {
      await scanForAlerts();
    } catch (e) {
      log.error('RECOMMEND', `Alert scan error: ${(e as Error).message}`);
    }
    await sleep(300_000); // every 5 minutes
  }
}

async function scanForAlerts(): Promise<void> {
  const cfg = await getConfig();
  const { picks } = await computeRecommendations(5);
  for (const p of picks) {
    if (p.breakdown.total < cfg.recommendAlertThreshold) continue;
    if (await recentlyAlerted(p.item.id)) continue;

    await query(
      `INSERT INTO recommendations (item_id, name, score, reasons, alerted)
       VALUES ($1,$2,$3,$4,TRUE)`,
      [p.item.id, p.item.name, p.breakdown.total, JSON.stringify(p.breakdown)]
    );
    await dmOwner(realtimeRecEmbed(p.item, p.price, p.breakdown));
    log.info('RECOMMEND', `Alerted on ${p.item.name} (${p.breakdown.total})`);
  }
}

async function recentlyAlerted(itemId: number): Promise<boolean> {
  const { rows } = await query(
    `SELECT 1 FROM recommendations
     WHERE item_id = $1 AND alerted = TRUE
       AND created_at > NOW() - INTERVAL '${RECENT_ALERT_HOURS} hours' LIMIT 1`,
    [itemId]
  );
  return rows.length > 0;
}

/** Rough liquidity proxy from RoliMons flags when live sales aren't fetched. */
function estimateActivity(item: RoliItem): number {
  let s = 2;
  if (item.hyped) s += 3;
  if (item.trend >= 3) s += 2;
  if (item.demand >= 3) s += 2;
  return s;
}
