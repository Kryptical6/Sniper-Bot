// ─────────────────────────────────────────────────────────────────────────────
// ROLIMONS CLIENT
//
// RoliMons publishes a free itemdetails endpoint with RAP, projected value,
// demand and trend ratings for every limited. We poll it on an interval and
// cache the parsed map in memory — it only changes a few times per hour.
//
// itemdetails shape:  { items: { "<id>": [name, acronym, rap, value,
//   defaultValue, demand, trend, projected, hyped, rare] } }
// ─────────────────────────────────────────────────────────────────────────────
import axios from 'axios';
import { config } from '../config';
import { log } from '../utils/logger';
import { RoliItem } from '../types';

const ITEM_DETAILS_URL = 'https://api.rolimons.com/items/v1/itemdetails';
const CREATE_AD_URL = 'https://www.rolimons.com/tradeadsapi/createtradead';
const REFRESH_MS = 60_000; // RoliMons asks callers not to poll faster than 60s

/** Valid request-side tags accepted by Rolimons trade ads. */
export const AD_TAGS = ['any', 'demand', 'rares', 'robux', 'upgrade', 'downgrade', 'rap', 'wishlist', 'projecteds', 'adds'] as const;
export type AdTag = typeof AD_TAGS[number];

class RolimonsClient {
  private cache = new Map<number, RoliItem>();
  private lastFetch = 0;

  async refresh(force = false): Promise<void> {
    if (!force && Date.now() - this.lastFetch < REFRESH_MS) return;
    try {
      const res = await axios.get(ITEM_DETAILS_URL, { timeout: 10_000 });
      const items = res.data?.items as Record<string, any[]>;
      if (!items) return;
      this.cache.clear();
      for (const [idStr, a] of Object.entries(items)) {
        const id = Number(idStr);
        this.cache.set(id, {
          id,
          name: a[0],
          acronym: a[1],
          rap: a[2],
          value: a[3],
          defaultValue: a[4],
          demand: a[5],
          trend: a[6],
          projected: a[7] === 1,
          hyped: a[8] === 1,
          rare: a[9] === 1,
        });
      }
      this.lastFetch = Date.now();
      log.debug('ROLIMONS', `Cached ${this.cache.size} items`);
    } catch (e) {
      log.warn('ROLIMONS', `Refresh failed: ${(e as Error).message}`);
    }
  }

  get(itemId: number): RoliItem | undefined {
    return this.cache.get(itemId);
  }

  /** Effective projected value, falling back to RAP when no projection. */
  effectiveValue(item: RoliItem): number {
    return item.value > 0 ? item.value : item.rap;
  }

  all(): RoliItem[] {
    return [...this.cache.values()];
  }

  get size(): number {
    return this.cache.size;
  }

  /**
   * Posts a trade ad on Rolimons.
   *
   * ⚠️ Uses the unofficial createtradead endpoint, authenticated with the
   * _RoliVerification cookie. Rolimons limits posting to ~1 ad / 15 min per
   * account; callers must enforce that. offerItemIds and requestItemIds are
   * Roblox catalog ids; requestTags are from AD_TAGS. Each side allows up to 4
   * items; offer + request entries are padded with -1 (Rolimons' "empty" slot).
   *
   * @returns true on success.
   */
  async postTradeAd(
    offerItemIds: number[],
    requestItemIds: number[],
    requestTags: AdTag[],
  ): Promise<boolean> {
    if (!config.rolimons.token) throw new Error('ROLIMONS_TOKEN not set — cannot post ads');

    const pad = (arr: number[]) => {
      const out = arr.slice(0, 4);
      while (out.length < 4) out.push(-1);
      return out;
    };

    const body = {
      player_id: Number(config.roblox.userId),
      offer_item_ids: pad(offerItemIds),
      request_item_ids: pad(requestItemIds),
      request_tags: requestTags.slice(0, 4),
    };

    const res = await axios.post(CREATE_AD_URL, body, {
      timeout: 15_000,
      headers: {
        Cookie: `_RoliVerification=${config.rolimons.token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0',
        Origin: 'https://www.rolimons.com',
        Referer: 'https://www.rolimons.com/tradeads',
      },
      validateStatus: () => true,
    });

    if (res.status === 200 && res.data?.success !== false) return true;
    const msg = res.data?.message || res.data?.msg || `HTTP ${res.status}`;
    log.warn('ROLIMONS', `Trade ad rejected: ${msg}`);
    throw new Error(msg);
  }
}

export const rolimons = new RolimonsClient();
