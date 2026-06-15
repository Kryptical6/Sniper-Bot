// ─────────────────────────────────────────────────────────────────────────────
// BUY SERVICE — executes a confirmed snipe purchase with all guards re-checked
// ─────────────────────────────────────────────────────────────────────────────
import { log } from '../utils/logger';
import { config } from '../config';
import { roblox, PurchaseError } from '../roblox/client';
import {
  getConfig, getTodaysApproval, reserveDailySpend, releaseDailySpend,
  recordAttempt, updateAttemptOutcome, recordPurchase, recordHolding,
} from '../db/helpers';
import { SnipeCandidate } from '../types';

export interface BuyResult {
  ok: boolean;
  detail: string;
}

/**
 * Re-validates every guard at click time (state may have changed since the
 * prompt), confirms the listing is still live at the expected price, then buys.
 */
export async function executeBuy(c: SnipeCandidate): Promise<BuyResult> {
  const cfg = await getConfig();
  if (!cfg.enabled || cfg.paused) return fail(c, 'Auto-buy is disabled or paused.');

  const appr = await getTodaysApproval();
  if (appr?.status !== 'approved') return fail(c, 'Sniping is not approved today.');

  const remaining = cfg.dailyCapRobux - appr.spentRobux;
  if (c.listing.price > remaining) return fail(c, `Over remaining daily budget (${remaining} R$).`);
  if (cfg.itemCapRobux != null && c.listing.price > cfg.itemCapRobux) {
    return fail(c, `Over per-item cap (${cfg.itemCapRobux} R$).`);
  }

  // Confirm the listing is still the cheapest & at the expected price.
  const live = await roblox.getResellers(c.itemId, 3).catch(() => []);
  const stillThere = live.find(l => l.userAssetId === c.listing.userAssetId);
  if (!stillThere) {
    await setOutcome(c, 'missed', 'Listing gone before confirm');
    return { ok: false, detail: 'Listing was already gone.' };
  }
  if (stillThere.price !== c.listing.price) {
    return fail(c, `Price changed (now ${stillThere.price} R$). Not buying.`);
  }

  const productId = await roblox.getProductId(c.itemId);
  if (!productId) return fail(c, 'Could not resolve product id.');

  if (config.dryRun) {
    await setOutcome(c, 'dry_run', 'Dry run enabled; purchase not sent');
    return { ok: false, detail: 'Dry run enabled; purchase was not sent to Roblox.' };
  }

  const reserved = await reserveDailySpend(c.listing.price, cfg.dailyCapRobux);
  if (!reserved) return fail(c, 'Daily budget was used by another purchase before this click.');

  try {
    await roblox.purchase({
      productId,
      userAssetId: c.listing.userAssetId,
      expectedPrice: c.listing.price,
      sellerId: c.listing.sellerId,
    });
  } catch (e) {
    const pe = e as PurchaseError;
    await releaseDailySpend(c.listing.price);
    await setOutcome(c, 'failed', `${pe.code}: ${pe.message}`);
    log.warn('BUY', `Failed ${c.name}: ${pe.code} ${pe.message}`);
    return { ok: false, detail: `${pe.code} — ${pe.message}` };
  }

  // Success — record spend and purchase.
  const attemptId = c.attemptId ?? await recordAttempt({
    itemId: c.itemId, itemName: c.name, userAssetId: c.listing.userAssetId,
    listedPrice: c.listing.price, rapAtTime: c.rap, projectedAtTime: c.projectedValue,
    discountPercent: c.discountPercent, score: c.score, outcome: 'bought',
  });
  if (c.attemptId) await updateAttemptOutcome(c.attemptId, 'bought');
  await recordPurchase({
    attemptId, itemId: c.itemId, itemName: c.name, robuxSpent: c.listing.price,
    rapAtTime: c.rap, userAssetId: c.listing.userAssetId,
  });
  // Register as a holding so it shows up in the Sell dashboard.
  await recordHolding({
    itemId: c.itemId, itemName: c.name,
    userAssetId: c.listing.userAssetId, costRobux: c.listing.price,
  });

  log.info('BUY', `Bought ${c.name} for ${c.listing.price} R$`);
  return { ok: true, detail: `Bought for ${c.listing.price.toLocaleString()} R$ (RAP ${c.rap.toLocaleString()}).` };
}

async function fail(c: SnipeCandidate, detail: string): Promise<BuyResult> {
  await setOutcome(c, 'failed', detail);
  return { ok: false, detail };
}

async function setOutcome(c: SnipeCandidate, outcome: string, reason?: string): Promise<void> {
  if (c.attemptId) {
    await updateAttemptOutcome(c.attemptId, outcome, reason);
    return;
  }
  await recordAttempt({
    itemId: c.itemId, itemName: c.name, userAssetId: c.listing.userAssetId,
    listedPrice: c.listing.price, rapAtTime: c.rap, projectedAtTime: c.projectedValue,
    discountPercent: c.discountPercent, score: c.score, outcome, reason,
  });
}
