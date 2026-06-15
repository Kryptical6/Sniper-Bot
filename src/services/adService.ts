// ─────────────────────────────────────────────────────────────────────────────
// AD SERVICE — Rolimons trade-ad posting
//
// Manual posting from the /rolimons-ad dashboard, plus an optional per-entry
// "auto re-advertise" rotation. Rolimons limits posting to one ad per ~15 min
// per account, so a single global cooldown gates every post (manual or auto).
// ─────────────────────────────────────────────────────────────────────────────
import { config } from '../config';
import { log } from '../utils/logger';
import { sleep } from '../utils/sleep';
import { rolimons } from '../roblox/rolimons';
import type { AdTag } from '../roblox/rolimons';
import {
  getAd, listAds, markAdPosted, lastAdPostTime,
} from '../db/helpers';

export const AD_COOLDOWN_MS = 15 * 60 * 1000;

export interface AdResult { ok: boolean; detail: string; }

/** Milliseconds until the next ad may be posted (0 = ready now). */
export async function cooldownRemainingMs(): Promise<number> {
  const last = await lastAdPostTime();
  if (!last) return 0;
  return Math.max(0, AD_COOLDOWN_MS - (Date.now() - last.getTime()));
}

/** Posts a single configured ad, respecting the global cooldown. */
export async function postAd(adId: string): Promise<AdResult> {
  if (!config.rolimons.token) return { ok: false, detail: 'ROLIMONS_TOKEN not set — add it to .env to post ads.' };

  const remaining = await cooldownRemainingMs();
  if (remaining > 0) {
    return { ok: false, detail: `On cooldown — try again in ${Math.ceil(remaining / 60000)} min.` };
  }

  const ad = await getAd(adId);
  if (!ad) return { ok: false, detail: 'Ad entry not found.' };

  try {
    await rolimons.postTradeAd([ad.offerItemId], ad.requestItemIds, ad.requestTags as AdTag[]);
  } catch (e) {
    return { ok: false, detail: (e as Error).message };
  }
  await markAdPosted(adId);
  log.info('AD', `Posted trade ad for ${ad.offerItemName}`);
  return { ok: true, detail: `Posted ad for **${ad.offerItemName}**. Next post available in 15 min.` };
}

// ─── Auto-rotation ───────────────────────────────────────────────────────────
export function startAdRotation(): void {
  if (!config.rolimons.token) {
    log.info('AD', 'Rotation idle (no ROLIMONS_TOKEN)');
    return;
  }
  log.info('AD', 'Auto-advertise rotation started');
  void loop();
}

async function loop(): Promise<void> {
  while (true) {
    try {
      await rotateOnce();
    } catch (e) {
      log.error('AD', `Rotation error: ${(e as Error).message}`);
    }
    await sleep(60_000); // check each minute; posting itself is cooldown-gated
  }
}

async function rotateOnce(): Promise<void> {
  if ((await cooldownRemainingMs()) > 0) return;

  const auto = (await listAds()).filter(a => a.autoReadvertise);
  if (auto.length === 0) return;

  // Pick the least-recently-advertised entry (never-posted first).
  auto.sort((a, b) => {
    const ta = a.lastPostedAt?.getTime() ?? 0;
    const tb = b.lastPostedAt?.getTime() ?? 0;
    return ta - tb;
  });
  const next = auto[0];
  const result = await postAd(next.id);
  if (!result.ok) log.warn('AD', `Auto-post skipped: ${result.detail}`);
}
