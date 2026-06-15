// ─────────────────────────────────────────────────────────────────────────────
// SLEEP + JITTER helpers — used to make poll cadence look organic
// ─────────────────────────────────────────────────────────────────────────────
export const sleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms));

/** Returns ms for a base interval (seconds) with ±fraction random jitter. */
export function jitteredMs(baseSeconds: number, fraction: number): number {
  const base = baseSeconds * 1000;
  const delta = base * fraction;
  return Math.round(base - delta + Math.random() * delta * 2);
}

/** Small random human-like pause, e.g. between sequential requests. */
export const humanPause = (): Promise<void> =>
  sleep(250 + Math.floor(Math.random() * 600));
