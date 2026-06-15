// ─────────────────────────────────────────────────────────────────────────────
// SHARED TYPES
// ─────────────────────────────────────────────────────────────────────────────

/** Persisted sniper configuration (single row, id = 1). */
export interface SniperConfig {
  enabled: boolean;            // master auto-buy switch
  paused: boolean;             // manual kill switch
  dailyCapRobux: number;       // max spend per day
  itemCapRobux: number | null; // max spend per single item (null = no cap)
  thresholdPercent: number;    // % below RAP required to trigger (e.g. 30)
  floorRobux: number | null;   // absolute price floor (null = disabled)
  confirmTimeoutSeconds: number | null; // null = wait forever
  feedChannelId: string | null;
  feedIncludeEvents: boolean;
  feedIncludeUgc: boolean;
  pollIntervalSeconds: number;
  recommendAlertThreshold: number; // min score for real-time DM
  sellDefaultMarginPct: number;    // desired net profit % over cost
  unsoldNotifyHours: number;       // nag if a listing hasn't sold
}

/** A copy we own that can be (or has been) listed for resale. */
export interface SaleListing {
  id: string;
  itemId: number;
  itemName: string;
  userAssetId: number;
  costRobux: number;
  listPrice: number | null;
  netEstimate: number | null;
  status: 'held' | 'listed' | 'sold' | 'cancelled';
}

/** RoliMons item market data. */
export interface RoliItem {
  id: number;
  name: string;
  acronym: string;
  rap: number;
  value: number;          // projected value (-1 when no projection)
  defaultValue: number;
  demand: number;         // -1..4
  trend: number;          // -1..4
  projected: boolean;
  hyped: boolean;
  rare: boolean;
}

/** A live reseller listing pulled from Roblox. */
export interface Listing {
  userAssetId: number;
  sellerId: number;
  price: number;
  serialNumber: number | null;
}

/** A scored snipe candidate ready for a buy decision. */
export interface SnipeCandidate {
  attemptId?: string;
  promptedAt: number;
  itemId: number;
  name: string;
  listing: Listing;
  rap: number;
  projectedValue: number;
  demand: number;
  discountPercent: number; // how far below RAP
  score: number;
}

export type Demand = -1 | 0 | 1 | 2 | 3 | 4;
