// ─────────────────────────────────────────────────────────────────────────────
// ANALYSIS — profit-possibility & buy-timing predictions
//
// Pure-ish helpers that turn RoliMons + Roblox market data into human-readable
// guidance. Used by the inventory view and the /search command. These are
// heuristics, not financial advice — they summarise demand, trend, projection
// risk and the price-vs-value spread (fee-aware).
// ─────────────────────────────────────────────────────────────────────────────
import { RoliItem } from '../types';
import { MARKETPLACE_FEE, priceOutlook, suggestSellPrice, blendedValue, isVolatile } from './scoring';

export interface ProfitPossibility {
  label: '🟢 High' | '🟡 Medium' | '🟠 Low' | '🔴 None';
  netIfFlip: number;   // proceeds after fee if sold at target value
  profit: number;      // netIfFlip - buyPrice
  pct: number;         // profit as % of buyPrice
}

/**
 * Profit if you bought at `buyPrice` and resold at `targetValue` (after fee).
 * targetValue is typically the projected value, falling back to RAP.
 */
export function profitPossibility(buyPrice: number, targetValue: number): ProfitPossibility {
  const net = Math.round(targetValue * (1 - MARKETPLACE_FEE));
  const profit = net - buyPrice;
  const pct = buyPrice > 0 ? (profit / buyPrice) * 100 : 0;
  const label: ProfitPossibility['label'] =
    pct >= 25 ? '🟢 High' : pct >= 8 ? '🟡 Medium' : pct > 0 ? '🟠 Low' : '🔴 None';
  return { label, netIfFlip: net, profit, pct: Math.round(pct * 10) / 10 };
}

// ─── Trade evaluation ────────────────────────────────────────────────────────
export interface TradeSide {
  items: RoliItem[];
  value: number;   // summed blended value
  rap: number;     // summed RAP
  demand: number;  // summed demand (rated items only)
}

export interface TradeVerdict {
  give: TradeSide;
  receive: TradeSide;
  valueDiff: number;     // receive.value - give.value
  valuePct: number;      // diff as % of give.value
  rapDiff: number;
  verdict: '✅ Win' | '⚖️ Fair' | '❌ Loss';
  notes: string[];
}

function sumSide(items: RoliItem[]): TradeSide {
  return {
    items,
    value: items.reduce((s, i) => s + (blendedValue(i) || i.rap || 0), 0),
    rap: items.reduce((s, i) => s + (i.rap || 0), 0),
    demand: items.reduce((s, i) => s + (i.demand > 0 ? i.demand : 0), 0),
  };
}

/** Evaluates a proposed trade (items you give vs receive) by blended value. */
export function evaluateTrade(giveItems: RoliItem[], receiveItems: RoliItem[]): TradeVerdict {
  const give = sumSide(giveItems);
  const receive = sumSide(receiveItems);
  const valueDiff = receive.value - give.value;
  const valuePct = give.value > 0 ? Math.round((valueDiff / give.value) * 1000) / 10 : 0;
  const rapDiff = receive.rap - give.rap;

  const verdict: TradeVerdict['verdict'] =
    valuePct >= 5 ? '✅ Win' : valuePct <= -5 ? '❌ Loss' : '⚖️ Fair';

  const notes: string[] = [];
  if (receive.demand > give.demand) notes.push('You gain on demand — easier to re-trade what you receive.');
  else if (receive.demand < give.demand) notes.push('You lose on demand — what you receive may be harder to move.');
  if (receiveItems.some(i => i.projected)) notes.push('⚠️ Some received items are **projected** — their value may be inflated.');
  if (receiveItems.length > giveItems.length) notes.push('You receive more items (an "overpay") — good if they hold value.');
  if (Math.abs(valuePct) < 5) notes.push('Value is close to even — decide on demand and how badly you want the items.');

  return { give, receive, valueDiff, valuePct, rapDiff, verdict, notes };
}

export interface SellGuidance {
  suggestedPrice: number; // realistic list price (≤ RAP for liquidity)
  net: number;            // proceeds after fee
  advice: string;         // sell-now vs wait
  waitWorthIt: boolean;
}

/**
 * What to list an owned copy for, and whether holding might pay off.
 * Suggests near RAP for a realistic sale, but flags upside when the item is
 * rising / projected higher with healthy demand.
 */
export function sellGuidance(args: {
  meta: RoliItem | undefined; rap: number; cost: number | null; marginPct: number;
}): SellGuidance {
  const { meta, rap, cost, marginPct } = args;
  const projected = meta ? blendedValue(meta) || rap : rap;
  // suggestSellPrice targets a net margin over basis but caps at RAP so it
  // actually sells; basis is our cost when known, else RAP.
  const { listPrice, netProceeds } = suggestSellPrice(cost ?? rap, marginPct, rap);

  const rising = meta?.trend === 3 || (projected > rap * 1.1);
  const highDemand = (meta?.demand ?? -1) >= 3;
  const falling = meta?.trend === 0 || (meta?.projected ?? false);

  let advice: string;
  let waitWorthIt = false;
  if (falling) {
    advice = `💸 Sell soon — price looks weak; list around ${listPrice.toLocaleString()} R$.`;
  } else if (rising && highDemand) {
    advice = `⏳ Holding may pay off — rising with strong demand (projected ${projected.toLocaleString()} R$). Wait, or list high.`;
    waitWorthIt = true;
  } else if (rising) {
    advice = `🟡 Mild upside — could creep up; list near ${listPrice.toLocaleString()} R$ or wait a bit.`;
    waitWorthIt = true;
  } else {
    advice = `✅ Fine to list now at ~${listPrice.toLocaleString()} R$.`;
  }

  return { suggestedPrice: listPrice, net: netProceeds, advice, waitWorthIt };
}

export interface ItemAnalysis {
  meta: RoliItem | undefined;
  rap: number;
  projected: number;
  lowestPrice: number | null;
  recentPrices: number[];
  demand: number;
  outlook: string;            // price-direction prediction
  possibility: ProfitPossibility | null; // based on buying at lowestPrice
  discountPercent: number | null;        // lowest vs RAP
  buyAdvice: string;          // when / whether to buy
  dropLikely: boolean;        // prediction: price likely to drop further
  volatile: boolean;          // price unreliable/unstable → widen margins
}

/**
 * Builds a full analysis from the pieces the caller fetches (kept I/O-free so
 * it's easy to test and reuse).
 */
export function analyzeItem(args: {
  meta: RoliItem | undefined;
  rap: number;
  lowestPrice: number | null;
  recentPrices: number[];
}): ItemAnalysis {
  const { meta, rap, lowestPrice, recentPrices } = args;
  // Blended fair value is the basis for profit math (RAP + projected, discounted).
  const projected = meta ? blendedValue(meta) || rap : rap;
  const demand = meta?.demand ?? -1;
  const outlook = priceOutlook(meta);
  const volatile = isVolatile(meta);

  const discountPercent =
    lowestPrice != null && rap > 0 ? Math.round(((rap - lowestPrice) / rap) * 1000) / 10 : null;

  const possibility =
    lowestPrice != null ? profitPossibility(lowestPrice, projected) : null;

  // Is the price likely to keep dropping (i.e. wait before buying)?
  const trendDown = meta?.trend === 0;                 // RoliMons "Lowering"
  const recentDown =
    recentPrices.length >= 2 && recentPrices[0] < recentPrices[recentPrices.length - 1];
  const highDemand = (meta?.demand ?? -1) >= 3;
  const dropLikely = (trendDown || recentDown) && !highDemand;

  // Compose buy advice.
  let buyAdvice: string;
  if (meta?.projected) {
    buyAdvice = '🛑 Avoid — flagged as projected (price likely inflated/unstable).';
  } else if (lowestPrice == null) {
    buyAdvice = 'No live listings right now — check back later.';
  } else if (possibility && possibility.label === '🟢 High' && !dropLikely) {
    buyAdvice = `✅ Buy now — listed ${discountPercent}% under RAP with strong flip upside.`;
  } else if (dropLikely) {
    buyAdvice = '⏳ Wait — price trending down; a lower entry is likely soon.';
  } else if (demand >= 3) {
    buyAdvice = '✅ Good entry — high demand supports the price; buy on any dip under RAP.';
  } else if (possibility && possibility.profit > 0) {
    buyAdvice = '🟡 Reasonable — modest upside; only buy comfortably below RAP.';
  } else {
    buyAdvice = '🔴 Skip — little or no margin at the current price.';
  }

  return {
    meta, rap, projected, lowestPrice, recentPrices, demand, outlook,
    possibility, discountPercent, buyAdvice, dropLikely, volatile,
  };
}
