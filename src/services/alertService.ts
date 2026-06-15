// ─────────────────────────────────────────────────────────────────────────────
// ALERT SERVICE — price target alerts
//
// Watches the live lowest listing for each active alert and DMs the owner when
// the price crosses the target (buy: lowest ≤ target; sell: lowest ≥ target).
// Alerts are one-shot — they deactivate after firing.
// ─────────────────────────────────────────────────────────────────────────────
import { EmbedBuilder } from 'discord.js';
import { log } from '../utils/logger';
import { sleep, humanPause } from '../utils/sleep';
import { roblox } from '../roblox/client';
import { getActiveAlerts, triggerAlert } from '../db/helpers';
import { dmOwner } from '../discord/notify';
import { colors, robux, itemUrl, thumbUrl } from '../discord/embeds';

export function startAlertWatcher(): void {
  log.info('ALERT', 'Price-alert watcher started');
  void loop();
}

async function loop(): Promise<void> {
  while (true) {
    try {
      await check();
    } catch (e) {
      log.error('ALERT', `Watcher error: ${(e as Error).message}`);
    }
    await sleep(180_000); // every 3 minutes
  }
}

async function check(): Promise<void> {
  const alerts = await getActiveAlerts();
  for (const a of alerts) {
    const listings = await roblox.getResellers(a.itemId, 1).catch(() => []);
    await humanPause();
    const lowest = listings[0]?.price;
    if (lowest == null) continue;

    const hit =
      (a.direction === 'buy' && lowest <= a.targetPrice) ||
      (a.direction === 'sell' && lowest >= a.targetPrice);
    if (!hit) continue;

    await triggerAlert(a.id, lowest);
    await dmOwner({
      embeds: [new EmbedBuilder()
        .setColor(a.direction === 'buy' ? colors.good : colors.warn)
        .setTitle(a.direction === 'buy' ? '🔔 Buy target hit' : '🔔 Sell target hit')
        .setURL(itemUrl(a.itemId))
        .setThumbnail(thumbUrl(a.itemId))
        .setDescription(
          `**${a.itemName || a.itemId}** is now at **${robux(lowest)}**\n` +
          `Your ${a.direction} target was ${robux(a.targetPrice)}.`)
        .setTimestamp()],
    });
    log.info('ALERT', `Fired ${a.direction} alert for ${a.itemName} at ${lowest}`);
  }
}
