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
import { log } from '../utils/logger';
import { RoliItem } from '../types';

const ITEM_DETAILS_URL = 'https://api.rolimons.com/items/v1/itemdetails';
const REFRESH_MS = 60_000; // RoliMons asks callers not to poll faster than 60s

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
}

export const rolimons = new RolimonsClient();
