// ─────────────────────────────────────────────────────────────────────────────
// SNIPE ENGINE
//
// The polling loop. Each tick (jittered interval):
//   1. Guard: master enabled, not paused, today approved, under daily cap.
//   2. Build the scan set: watchlist items first, then a sample of the
//      RoliMons universe (so broad coverage without hammering Roblox).
//   3. For each item: pull cheapest live listing, compare to RAP threshold
//      and floor, score it, and if it qualifies → prompt the owner via DM.
//   4. The owner's Buy button triggers the actual purchase (see interactions).
//
// Caution-first: nothing is ever bought without an explicit Buy click, and the
// per-item / daily caps are enforced before a prompt is even sent.
// ─────────────────────────────────────────────────────────────────────────────
import { config } from '../config';
import { log } from '../utils/logger';
import { sleep, jitteredMs, humanPause } from '../utils/sleep';
import { roblox } from '../roblox/client';
import { rolimons } from '../roblox/rolimons';
import {
  getConfig, getTodaysApproval, listWatch, getWatchFloorMap, recordAttempt,
} from '../db/helpers';
import { scoreItem, blendedValue } from './scoring';
import { snipeAlertEmbed } from '../discord/embeds';
import { dmOwner } from '../discord/notify';
import { SnipeCandidate } from '../types';

let running = false;
// In-flight prompts: userAssetId → candidate, so the Buy handler has context.
export const pendingPrompts = new Map<number, SnipeCandidate>();

/** How many universe items to sample per tick (besides the watchlist). */
const UNIVERSE_SAMPLE = 40;

export function startSnipeEngine(): void {
  if (running) return;
  running = true;
  log.info('SNIPE', 'Engine started');
  void loop();
}

export function stopSnipeEngine(): void {
  running = false;
}

async function loop(): Promise<void> {
  while (running) {
    try {
      await tick();
    } catch (e) {
      log.error('SNIPE', `Tick error: ${(e as Error).message}`);
    }
    const cfg = await safeInterval();
    await sleep(jitteredMs(cfg, config.poll.jitterFraction));
  }
}

async function safeInterval(): Promise<number> {
  try {
    return (await getConfig()).pollIntervalSeconds;
  } catch {
    return config.poll.intervalSeconds;
  }
}

async function tick(): Promise<void> {
  const cfg = await getConfig();
  if (!cfg.enabled || cfg.paused) return;

  const appr = await getTodaysApproval();
  if (appr?.status !== 'approved') return;
  if (appr.spentRobux >= cfg.dailyCapRobux) {
    log.debug('SNIPE', 'Daily cap reached — skipping tick');
    return;
  }

  await rolimons.refresh();
  const balance = await roblox.getBalance().catch(() => 0);
  const remaining = cfg.dailyCapRobux - appr.spentRobux;

  // Build scan set: watchlist (priority) + a rotating universe sample.
  const watch = await listWatch();
  const watchIds = watch.map(w => w.itemId);
  const floorMap = await getWatchFloorMap();
  const universe = rolimons.all().map(i => i.id);
  const sample = sampleArray(universe.filter(id => !watchIds.includes(id)), UNIVERSE_SAMPLE);
  const scanIds = [...watchIds, ...sample];

  for (const itemId of scanIds) {
    if (!running) break;
    const meta = rolimons.get(itemId);
    if (!meta) continue;

    const listings = await roblox.getResellers(itemId, 1).catch(() => []);
    await humanPause();
    const cheapest = listings[0];
    if (!cheapest) continue;

    const rap = meta.rap || 0;
    if (rap <= 0) continue;

    const discountPercent = ((rap - cheapest.price) / rap) * 100;

    // Threshold OR floor logic. Per-item floor (if set on the watchlist)
    // overrides the global floor for that item.
    const perItemFloor = floorMap.has(itemId) ? floorMap.get(itemId) : undefined;
    const effectiveFloor = perItemFloor != null ? perItemFloor : cfg.floorRobux;
    const meetsThreshold = discountPercent >= cfg.thresholdPercent;
    const meetsFloor = effectiveFloor != null && cheapest.price <= effectiveFloor;
    if (!meetsThreshold && !meetsFloor) continue;

    // Hard guards before we even prompt.
    if (cfg.itemCapRobux != null && cheapest.price > cfg.itemCapRobux) {
      await recordAttempt({
        itemId, itemName: meta.name, userAssetId: cheapest.userAssetId,
        listedPrice: cheapest.price, rapAtTime: rap, discountPercent,
        outcome: 'capped', reason: `Above item cap (${cfg.itemCapRobux})`,
      });
      continue;
    }
    if (cheapest.price > remaining) {
      await recordAttempt({
        itemId, itemName: meta.name, userAssetId: cheapest.userAssetId,
        listedPrice: cheapest.price, rapAtTime: rap, discountPercent,
        outcome: 'capped', reason: `Exceeds remaining daily budget (${remaining})`,
      });
      continue;
    }
    if (pendingPrompts.has(cheapest.userAssetId)) continue;

    const resale = await roblox.getResaleData(itemId).catch(() => null);
    const breakdown = scoreItem(cheapest.price, meta, balance, resale?.sales ?? 0);

    const candidate: SnipeCandidate = {
      itemId,
      name: meta.name,
      listing: cheapest,
      rap,
      projectedValue: blendedValue(meta) || rolimons.effectiveValue(meta),
      demand: meta.demand,
      discountPercent: Math.round(discountPercent * 10) / 10,
      score: breakdown.total,
    };

    await promptOwner(candidate, appr.spentRobux, cfg.dailyCapRobux);
  }
}

async function promptOwner(c: SnipeCandidate, spentToday: number, cap: number): Promise<void> {
  const attemptId = await recordAttempt({
    itemId: c.itemId, itemName: c.name, userAssetId: c.listing.userAssetId,
    listedPrice: c.listing.price, rapAtTime: c.rap, projectedAtTime: c.projectedValue,
    discountPercent: c.discountPercent, score: c.score, outcome: 'prompted',
  });
  (c as any).attemptId = attemptId;

  pendingPrompts.set(c.listing.userAssetId, c);
  const msg = await dmOwner(snipeAlertEmbed(c, spentToday, cap));
  if (!msg) {
    pendingPrompts.delete(c.listing.userAssetId);
    return;
  }
  log.info('SNIPE', `Prompted owner: ${c.name} @ ${c.listing.price} (${c.discountPercent}% under RAP)`);
}

function sampleArray<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const out: T[] = [];
  const used = new Set<number>();
  while (out.length < n) {
    const i = Math.floor(Math.random() * arr.length);
    if (used.has(i)) continue;
    used.add(i);
    out.push(arr[i]);
  }
  return out;
}
