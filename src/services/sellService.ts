// ─────────────────────────────────────────────────────────────────────────────
// SELL SERVICE
//
// Manual-trigger selling: the owner picks a held copy and a price (suggested,
// fee-aware) from the Sell dashboard, and we list it. A background watcher
// detects sales (copy no longer listed) and nags about stale listings.
// ─────────────────────────────────────────────────────────────────────────────
import { log } from '../utils/logger';
import { sleep } from '../utils/sleep';
import { roblox } from '../roblox/client';
import {
  getConfig, getListing, markListed, markSold, getStaleListings, touchNotified, getHoldings,
} from '../db/helpers';
import { netAfterFee } from './scoring';
import { dmOwner } from '../discord/notify';
import { EmbedBuilder } from 'discord.js';
import { colors, robux, itemUrl } from '../discord/embeds';

export interface ListResult { ok: boolean; detail: string; }

/** Lists a held copy for resale at the given price. */
export async function listSale(listingId: string, price: number): Promise<ListResult> {
  const listing = await getListing(listingId);
  if (!listing) return { ok: false, detail: 'Holding not found.' };
  if (listing.status !== 'held') return { ok: false, detail: `Already ${listing.status}.` };
  if (price < 1) return { ok: false, detail: 'Price must be at least 1 R$.' };

  try {
    const ok = await roblox.listForResale(listing.itemId, listing.userAssetId, price);
    if (!ok) return { ok: false, detail: 'Roblox rejected the listing.' };
  } catch (e) {
    log.warn('SELL', `List failed for ${listing.itemName}: ${(e as Error).message}`);
    return { ok: false, detail: (e as Error).message };
  }

  const net = netAfterFee(price);
  await markListed(listingId, price, net);
  log.info('SELL', `Listed ${listing.itemName} @ ${price} (net ~${net})`);
  return {
    ok: true,
    detail: `Listed **${listing.itemName}** at ${robux(price)} — nets ~${robux(net)} after fee (${net - listing.costRobux >= 0 ? '+' : ''}${robux(net - listing.costRobux)} vs cost).`,
  };
}

// ─── Unsold / sold watcher ───────────────────────────────────────────────────
export function startSellWatcher(): void {
  log.info('SELL', 'Listing watcher started');
  void loop();
}

async function loop(): Promise<void> {
  while (true) {
    try {
      await checkListings();
    } catch (e) {
      log.error('SELL', `Watcher error: ${(e as Error).message}`);
    }
    await sleep(600_000); // every 10 minutes
  }
}

async function checkListings(): Promise<void> {
  const cfg = await getConfig();

  // Detect completed sales: a listed copy that is no longer on the market sold.
  const listed = await getHoldings('listed');
  for (const l of listed) {
    const stillUp = await roblox.isStillListed(l.itemId, l.userAssetId).catch(() => true);
    if (!stillUp) {
      await markSold(l.id);
      const net = l.netEstimate ?? netAfterFee(l.listPrice ?? 0);
      await dmOwner({
        embeds: [new EmbedBuilder()
          .setColor(colors.good)
          .setTitle('💸 Sold')
          .setURL(itemUrl(l.itemId))
          .setDescription(`**${l.itemName}** sold for ${robux(l.listPrice ?? 0)} — netted ~${robux(net)} (${net - l.costRobux >= 0 ? '+' : ''}${robux(net - l.costRobux)} profit).`)
          .setTimestamp()],
      });
      log.info('SELL', `Detected sale: ${l.itemName}`);
    }
    await sleep(500);
  }

  // Nag about stale, still-unsold listings.
  const stale = await getStaleListings(cfg.unsoldNotifyHours);
  for (const l of stale) {
    await dmOwner({
      embeds: [new EmbedBuilder()
        .setColor(colors.warn)
        .setTitle('⌛ Still unsold')
        .setURL(itemUrl(l.itemId))
        .setDescription(`**${l.itemName}** listed at ${robux(l.listPrice ?? 0)} hasn't sold in ${cfg.unsoldNotifyHours}h.\nConsider repricing from the Sell dashboard.`)
        .setTimestamp()],
    });
    await touchNotified(l.id);
  }
}
