// ─────────────────────────────────────────────────────────────────────────────
// FEED SERVICE
//
// Detects newly-listed limiteds and posts them to the configured channel.
// "New" = an item id present in the current RoliMons universe that we have
// never posted before (tracked in feed_posts). On first boot we seed the table
// silently so we don't spam the channel with the entire back-catalogue.
// ─────────────────────────────────────────────────────────────────────────────
import { log } from '../utils/logger';
import { rolimons } from '../roblox/rolimons';
import { roblox } from '../roblox/client';
import { getConfig, alreadyPosted, markPosted } from '../db/helpers';
import { query } from '../db';
import { feedEmbed } from '../discord/embeds';
import { postToFeed } from '../discord/notify';
import { sleep } from '../utils/sleep';

let seeded = false;

export function startFeedService(): void {
  log.info('FEED', 'Service started');
  void loop();
}

async function loop(): Promise<void> {
  // First pass seeds existing items so only genuinely new ones post later.
  await rolimons.refresh(true);
  if (!seeded) {
    await seedExisting();
    seeded = true;
  }
  while (true) {
    try {
      await scan();
    } catch (e) {
      log.error('FEED', `Scan error: ${(e as Error).message}`);
    }
    await sleep(90_000); // feed cadence — gentle
  }
}

async function seedExisting(): Promise<void> {
  const items = rolimons.all();
  for (const it of items) {
    await markPosted(it.id, it.name);
  }
  log.info('FEED', `Seeded ${items.length} existing limiteds (no posts sent)`);
}

async function scan(): Promise<void> {
  const cfg = await getConfig();
  const channelId = cfg.feedChannelId;
  if (!channelId) return;

  await rolimons.refresh();
  for (const it of rolimons.all()) {
    if (await alreadyPosted(it.id)) continue;

    const listings = await roblox.getResellers(it.id, 1).catch(() => []);
    const price = listings[0]?.price ?? null;

    const msg = await postToFeed(channelId, feedEmbed(it, price));
    await markPosted(it.id, it.name, msg?.id);
    log.info('FEED', `Posted new limited: ${it.name} (${it.id})`);
    await sleep(1500); // avoid burst-posting
  }
}

/** Re-seed helper exposed for an admin reset if ever needed. */
export async function resetFeedSeed(): Promise<void> {
  await query(`TRUNCATE feed_posts`);
  seeded = false;
}
