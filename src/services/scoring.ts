// ─────────────────────────────────────────────────────────────────────────────
// SCORING
//
// A single 0–100 score blending the four factors the owner cares about:
//   - ROI potential   (projected value vs current price)
//   - Demand          (RoliMons demand rating)
//   - Sale activity   (does it actually sell / liquid?)
//   - Affordability   (can we buy it with current balance?)
//
// Weights are tuned so a strong-demand item priced well below its projection,
// that actually sells, and is affordable, lands ~85–100.
// ─────────────────────────────────────────────────────────────────────────────
import { RoliItem } from '../types';

const WEIGHTS = {
  roi: 0.40,
  demand: 0.25,
  activity: 0.20,
  affordability: 0.15,
};

export interface ScoreBreakdown {
  total: number;
  roi: number;
  demand: number;
  activity: number;
  affordability: number;
  discountPercent: number;
}

/**
 * @param price        the live listing price we'd pay
 * @param item         RoliMons market data
 * @param balance      current Robux balance (for affordability)
 * @param recentSales  number of recent sales data points (liquidity proxy)
 */
export function scoreItem(
  price: number,
  item: RoliItem,
  balance: number,
  recentSales: number
): ScoreBreakdown {
  const projected = item.value > 0 ? item.value : item.rap;
  const reference = Math.max(projected, item.rap, 1);

  // ROI: how far below reference value is the price. 0% → 0, 50%+ under → 100.
  const discountPercent = ((reference - price) / reference) * 100;
  const roi = clamp((discountPercent / 50) * 100, 0, 100);

  // Demand: RoliMons demand is -1 (unassigned) .. 4 (amazing).
  const demand = item.demand < 0 ? 35 : (item.demand / 4) * 100;

  // Activity: more recent sales = more liquid. Saturates around 8 data points.
  const activity = clamp((recentSales / 8) * 100, 0, 100);

  // Affordability: fully affordable → 100, exactly at balance → ~50, over → 0.
  const affordability =
    balance <= 0 ? 0 : clamp((1 - price / Math.max(balance, 1)) * 100 + 50, 0, 100);

  // Projected items are flagged risky on RoliMons → dampen the ROI contribution.
  const roiAdj = item.projected ? roi * 0.6 : roi;

  const total =
    roiAdj * WEIGHTS.roi +
    demand * WEIGHTS.demand +
    activity * WEIGHTS.activity +
    affordability * WEIGHTS.affordability;

  return {
    total: Math.round(total * 10) / 10,
    roi: Math.round(roiAdj),
    demand: Math.round(demand),
    activity: Math.round(activity),
    affordability: Math.round(affordability),
    discountPercent: Math.round(discountPercent * 10) / 10,
  };
}

// ─── Resale pricing (fee-aware) ──────────────────────────────────────────────
/** Roblox marketplace fee on limited resales (seller receives 1 - FEE). */
export const MARKETPLACE_FEE = 0.30;

export interface SellSuggestion {
  listPrice: number;   // price to list at
  netProceeds: number; // what you actually receive after the fee
  profit: number;      // netProceeds - cost
}

/**
 * Suggests a resale price that nets `marginPct`% profit over `cost` after fee.
 *   net = list * (1 - FEE);  want net = cost * (1 + margin/100)
 *   → list = cost * (1 + margin/100) / (1 - FEE)
 * Capped so we never suggest above RAP (which rarely sells).
 */
export function suggestSellPrice(cost: number, marginPct: number, rap: number): SellSuggestion {
  const target = (cost * (1 + marginPct / 100)) / (1 - MARKETPLACE_FEE);
  const listPrice = Math.max(1, Math.min(Math.round(target), rap > 0 ? Math.round(rap) : target));
  const netProceeds = Math.round(listPrice * (1 - MARKETPLACE_FEE));
  return { listPrice, netProceeds, profit: netProceeds - cost };
}

/** Net proceeds for an arbitrary list price after the marketplace fee. */
export function netAfterFee(listPrice: number): number {
  return Math.round(listPrice * (1 - MARKETPLACE_FEE));
}

export function buyTag(score: number): '🟢 Strong Buy' | '🟡 Hold' | '🔴 Avoid' {
  if (score >= 75) return '🟢 Strong Buy';
  if (score >= 50) return '🟡 Hold';
  return '🔴 Avoid';
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
