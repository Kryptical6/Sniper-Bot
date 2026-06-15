// ─────────────────────────────────────────────────────────────────────────────
// ROBLOX CLIENT
//
// Authenticated wrapper around the Roblox web APIs used by the bot:
//   - balance        (economy)
//   - resellers      (lowest live listings for a limited)
//   - resale-data    (RAP / recent sales)
//   - purchase       (buy a specific reseller listing)
//
// Design notes:
//   - Roblox requires an X-CSRF-TOKEN on state-changing calls. The token is
//     returned in a 403 response header the first time; we cache and refresh it.
//   - We respect 429s with exponential backoff and surface rate-limit info.
//   - Requests carry a normal browser-like UA and small human pauses upstream.
// ─────────────────────────────────────────────────────────────────────────────
import axios, { AxiosInstance, AxiosError } from 'axios';
import axiosRetry from 'axios-retry';
import { config } from '../config';
import { log } from '../utils/logger';
import { sleep } from '../utils/sleep';
import { Listing } from '../types';

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export class PurchaseError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PurchaseError';
  }
}

class RobloxClient {
  private http: AxiosInstance;
  private csrfToken: string | null = null;

  constructor() {
    this.http = axios.create({
      timeout: 10_000,
      headers: {
        Cookie: `.ROBLOSECURITY=${config.roblox.cookie}`,
        'User-Agent': USER_AGENT,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      validateStatus: () => true, // we handle status codes manually
    });

    // Retry transient network/5xx errors with backoff (429 handled separately).
    axiosRetry(this.http, {
      retries: 3,
      retryDelay: axiosRetry.exponentialDelay,
      retryCondition: e =>
        axiosRetry.isNetworkError(e) || (e.response?.status ?? 0) >= 500,
    });
  }

  // ─── CSRF ──────────────────────────────────────────────────────────────────
  private async ensureCsrf(): Promise<string> {
    if (this.csrfToken) return this.csrfToken;
    // A POST to logout with no token returns a fresh token in the header.
    const res = await this.http.post('https://auth.roblox.com/v2/logout');
    const token = res.headers['x-csrf-token'];
    if (!token) throw new Error('Unable to obtain CSRF token (cookie may be invalid)');
    this.csrfToken = token;
    log.debug('ROBLOX', 'CSRF token acquired');
    return token;
  }

  // ─── Auth check ──────────────────────────────────────────────────────────────
  async whoami(): Promise<{ id: number; name: string }> {
    const res = await this.http.get('https://users.roblox.com/v1/users/authenticated');
    if (res.status === 401) throw new Error('ROBLOSECURITY cookie is invalid or expired');
    return { id: res.data.id, name: res.data.name };
  }

  // ─── Balance ─────────────────────────────────────────────────────────────────
  async getBalance(): Promise<number> {
    const url = `https://economy.roblox.com/v1/users/${config.roblox.userId}/currency`;
    const res = await this.backoffGet(url);
    return res.data.robux as number;
  }

  // ─── Inventory (owned limiteds) ─────────────────────────────────────────────
  /**
   * Lists the buying account's collectible (limited) inventory, paginated.
   * Each entry includes the live RAP and what the account originally paid.
   */
  async getCollectibleInventory(): Promise<{
    assetId: number; userAssetId: number; name: string;
    rap: number; originalPrice: number | null; serialNumber: number | null;
  }[]> {
    const out: any[] = [];
    let cursor = '';
    do {
      const url =
        `https://inventory.roblox.com/v1/users/${config.roblox.userId}/assets/collectibles` +
        `?sortOrder=Asc&limit=100&cursor=${cursor}`;
      const res = await this.backoffGet(url);
      if (res.status !== 200 || !Array.isArray(res.data?.data)) break;
      for (const d of res.data.data) {
        out.push({
          assetId: d.assetId,
          userAssetId: d.userAssetId,
          name: d.name,
          rap: d.recentAveragePrice ?? 0,
          originalPrice: d.originalPrice ?? null,
          serialNumber: d.serialNumber ?? null,
        });
      }
      cursor = res.data.nextPageCursor ?? '';
    } while (cursor);
    return out;
  }

  // ─── Purchase transaction history ───────────────────────────────────────────
  /**
   * Builds a map of assetId → Robux paid from the account's purchase history,
   * so we can show cost basis for items bought before the bot existed.
   * Keeps the most recent purchase price per asset. Pages back a few hundred
   * transactions (Roblox keeps a limited window).
   */
  async getPurchaseCostMap(maxPages = 6): Promise<Map<number, number>> {
    const map = new Map<number, number>();
    let cursor = '';
    for (let page = 0; page < maxPages; page++) {
      const url =
        `https://economy.roblox.com/v2/users/${config.roblox.userId}/transactions` +
        `?transactionType=Purchase&limit=100&cursor=${cursor}`;
      const res = await this.backoffGet(url);
      if (res.status !== 200 || !Array.isArray(res.data?.data)) break;
      for (const t of res.data.data) {
        const assetId = t.details?.id;
        const amount = t.currency?.amount;
        // Only Robux-denominated asset purchases; keep the most recent (first seen).
        if (assetId && typeof amount === 'number' && amount > 0 && !map.has(assetId)) {
          map.set(Number(assetId), amount);
        }
      }
      cursor = res.data.nextPageCursor ?? '';
      if (!cursor) break;
      await sleep(300);
    }
    return map;
  }

  // ─── Resale data (RAP + recent sales) ───────────────────────────────────────
  async getResaleData(itemId: number): Promise<{ rap: number; sales: number } | null> {
    const url = `https://economy.roblox.com/v1/assets/${itemId}/resale-data`;
    const res = await this.backoffGet(url);
    if (res.status !== 200) return null;
    return {
      rap: res.data.recentAveragePrice ?? 0,
      // sum of last data points' volume, if present
      sales: Array.isArray(res.data.salesVolume) ? res.data.salesVolume.length : 0,
    };
  }

  // ─── Product id (needed to purchase) ────────────────────────────────────────
  async getProductId(itemId: number): Promise<number | null> {
    const url = `https://economy.roblox.com/v2/assets/${itemId}/details`;
    const res = await this.backoffGet(url);
    if (res.status !== 200) return null;
    return res.data?.ProductId ?? res.data?.productId ?? null;
  }

  /** Fuller resale detail: RAP plus the most recent sale price points. */
  async getResaleDetail(itemId: number): Promise<{ rap: number; recentPrices: number[] } | null> {
    const url = `https://economy.roblox.com/v1/assets/${itemId}/resale-data`;
    const res = await this.backoffGet(url);
    if (res.status !== 200) return null;
    const points: number[] = Array.isArray(res.data?.priceDataPoints)
      ? res.data.priceDataPoints.map((p: any) => p.value).filter((v: any) => typeof v === 'number')
      : [];
    return { rap: res.data.recentAveragePrice ?? 0, recentPrices: points.slice(-6).reverse() };
  }

  // ─── Resellers (live listings, cheapest first) ──────────────────────────────
  async getResellers(itemId: number, limit = 10): Promise<Listing[]> {
    const url =
      `https://economy.roblox.com/v1/assets/${itemId}/resellers?limit=${limit}&cursor=`;
    const res = await this.backoffGet(url);
    if (res.status !== 200 || !Array.isArray(res.data?.data)) return [];
    return res.data.data
      .map((d: any) => ({
        userAssetId: d.userAssetId,
        sellerId: d.seller?.id,
        price: d.price,
        serialNumber: d.serialNumber ?? null,
      }))
      .sort((a: Listing, b: Listing) => a.price - b.price);
  }

  // ─── Purchase ────────────────────────────────────────────────────────────────
  /**
   * Buys a specific reseller listing.
   * @throws PurchaseError on a logical failure (price changed, sold out, funds…)
   */
  async purchase(opts: {
    productId: number;      // collectibleProductId / productId of the item
    userAssetId: number;    // the specific copy being bought
    expectedPrice: number;  // guards against price changes
    sellerId: number;
  }): Promise<void> {
    const token = await this.ensureCsrf();
    const url = `https://economy.roblox.com/v1/purchases/products/${opts.productId}`;
    const body = {
      expectedCurrency: 1,        // 1 = Robux
      expectedPrice: opts.expectedPrice,
      expectedSellerId: opts.sellerId,
      userAssetId: opts.userAssetId,
    };

    let res = await this.http.post(url, body, { headers: { 'X-CSRF-TOKEN': token } });

    // Token expired mid-flight → refresh once and retry.
    if (res.status === 403 && res.headers['x-csrf-token']) {
      this.csrfToken = res.headers['x-csrf-token'];
      res = await this.http.post(url, body, {
        headers: { 'X-CSRF-TOKEN': this.csrfToken as string },
      });
    }

    if (res.status === 429) throw new PurchaseError('Rate limited by Roblox', 'RATE_LIMITED');
    if (res.status !== 200) {
      throw new PurchaseError(`HTTP ${res.status}: ${JSON.stringify(res.data)}`, 'HTTP_ERROR');
    }

    const data = res.data;
    if (data?.purchased === true) return;

    // Roblox returns 200 with purchased:false + a reason on logical failures.
    const reason = data?.errorMsg || data?.statusType || data?.reason || 'unknown';
    const code =
      /price/i.test(reason) ? 'PRICE_CHANGED'
      : /sold|owned|available/i.test(reason) ? 'SOLD_OUT'
      : /funds|robux/i.test(reason) ? 'INSUFFICIENT_FUNDS'
      : 'DECLINED';
    throw new PurchaseError(reason, code);
  }

  // ─── Selling (resale listing) ───────────────────────────────────────────────
  //
  // ⚠️ Roblox's resale API moved to the "collectibles" system. Listing a copy
  // now needs the item's collectibleItemId and the copy's collectibleInstanceId
  // (NOT the classic assetId / userAssetId). We resolve those from inventory,
  // then PATCH the resale price. These two endpoints are the most likely to
  // change over time — they're isolated here so a fix is one-spot.

  /** Resolves collectibleItemId for an asset (needed for resale calls). */
  async getCollectibleItemId(itemId: number): Promise<string | null> {
    const url = `https://apis.roblox.com/marketplace-items/v1/items/details`;
    const token = await this.ensureCsrf();
    const res = await this.http.post(url, { itemIds: [itemId] }, {
      headers: { 'X-CSRF-TOKEN': token },
    });
    if (res.status !== 200) return null;
    const entry = Array.isArray(res.data) ? res.data[0] : res.data?.[0];
    return entry?.collectibleItemId ?? null;
  }

  /** Finds the collectibleInstanceId for a specific owned copy (by userAssetId). */
  async getCollectibleInstanceId(itemId: number, userAssetId: number): Promise<string | null> {
    const collectibleItemId = await this.getCollectibleItemId(itemId);
    if (!collectibleItemId) return null;
    const url =
      `https://apis.roblox.com/marketplace-sales/v1/item/${collectibleItemId}/resellable-instances` +
      `?ownerType=User&ownerId=${config.roblox.userId}&limit=100`;
    const res = await this.backoffGet(url);
    if (res.status !== 200) return null;
    const copy = (res.data?.itemInstances ?? []).find(
      (c: any) => String(c.serialNumber) && c.collectibleItemInstanceId &&
        (c.userAssetId == null || c.userAssetId === userAssetId)
    );
    return copy?.collectibleItemInstanceId ?? res.data?.itemInstances?.[0]?.collectibleItemInstanceId ?? null;
  }

  /**
   * Lists an owned copy for resale at `price` Robux.
   * @returns true on success.
   */
  async listForResale(itemId: number, userAssetId: number, price: number): Promise<boolean> {
    const collectibleItemId = await this.getCollectibleItemId(itemId);
    const instanceId = await this.getCollectibleInstanceId(itemId, userAssetId);
    if (!collectibleItemId || !instanceId) throw new Error('Could not resolve collectible ids for resale');

    const token = await this.ensureCsrf();
    const url =
      `https://apis.roblox.com/marketplace-sales/v1/item/${collectibleItemId}` +
      `/resellable-instance/${instanceId}/resale`;
    const res = await this.http.post(url, { price }, { headers: { 'X-CSRF-TOKEN': token } });
    if (res.status === 403 && res.headers['x-csrf-token']) {
      this.csrfToken = res.headers['x-csrf-token'];
      const retry = await this.http.post(url, { price }, { headers: { 'X-CSRF-TOKEN': this.csrfToken as string } });
      return retry.status === 200;
    }
    return res.status === 200;
  }

  /** Takes a copy off sale (cancels its resale listing). @returns true on success. */
  async cancelResale(itemId: number, userAssetId: number): Promise<boolean> {
    const collectibleItemId = await this.getCollectibleItemId(itemId);
    const instanceId = await this.getCollectibleInstanceId(itemId, userAssetId);
    if (!collectibleItemId || !instanceId) throw new Error('Could not resolve collectible ids for cancel');

    const token = await this.ensureCsrf();
    const url =
      `https://apis.roblox.com/marketplace-sales/v1/item/${collectibleItemId}` +
      `/resellable-instance/${instanceId}/resale`;
    const res = await this.http.delete(url, { headers: { 'X-CSRF-TOKEN': token } });
    if (res.status === 403 && res.headers['x-csrf-token']) {
      this.csrfToken = res.headers['x-csrf-token'];
      const retry = await this.http.delete(url, { headers: { 'X-CSRF-TOKEN': this.csrfToken as string } });
      return retry.status === 200 || retry.status === 204;
    }
    return res.status === 200 || res.status === 204;
  }

  /**
   * True if the given copy is still listed for sale (used by the unsold watcher).
   * Pages beyond the cheapest 100 so an expensive listing is not mistaken for a
   * completed sale just because it is buried below cheaper copies.
   */
  async isStillListed(itemId: number, userAssetId: number, maxPages = 10): Promise<boolean> {
    let cursor = '';
    for (let page = 0; page < maxPages; page++) {
      const url =
        `https://economy.roblox.com/v1/assets/${itemId}/resellers?limit=100&cursor=${encodeURIComponent(cursor)}`;
      const res = await this.backoffGet(url);
      if (res.status !== 200 || !Array.isArray(res.data?.data)) return true;
      if (res.data.data.some((d: any) => d.userAssetId === userAssetId)) return true;
      cursor = res.data.nextPageCursor ?? '';
      if (!cursor) return false;
      await sleep(250);
    }
    // Unknown after the page limit: prefer not marking it sold incorrectly.
    return true;
  }

  // ─── Internal: GET with 429 backoff ─────────────────────────────────────────
  private async backoffGet(url: string, attempt = 0): Promise<any> {
    const res = await this.http.get(url);
    if (res.status === 429 && attempt < 4) {
      const wait = 1000 * Math.pow(2, attempt) + Math.random() * 500;
      log.warn('ROBLOX', `429 on GET, backing off ${Math.round(wait)}ms`);
      await sleep(wait);
      return this.backoffGet(url, attempt + 1);
    }
    return res;
  }
}

export const roblox = new RobloxClient();
