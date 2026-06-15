// ─────────────────────────────────────────────────────────────────────────────
// DAILY APPROVAL SCHEDULER
//
// At the configured hour (GMT) each day, DM the owner a go/no-go prompt. Until
// they press Approve, isSnipingAllowedToday() returns false and the engine
// stays idle. Also runs a digest of the day's top recommendations alongside.
// ─────────────────────────────────────────────────────────────────────────────
import cron from 'node-cron';
import { config } from '../config';
import { log } from '../utils/logger';
import { roblox } from '../roblox/client';
import { getConfig, listWatch, ensureTodaysApprovalRow } from '../db/helpers';
import { dailyApprovalEmbed } from '../discord/embeds';
import { dmOwner } from '../discord/notify';
import { computeRecommendations, buildRecommendEmbed } from '../services/recommendService';
import { runMoversDigest } from '../services/moversService';

export function startDailyApprovalScheduler(): void {
  const hour = config.dailyApprovalHourGmt;
  // cron in UTC (== GMT). Minute 0 of the configured hour.
  const expr = `0 ${hour} * * *`;
  cron.schedule(expr, () => void sendDailyPrompt(), { timezone: 'UTC' });
  log.info('SCHEDULER', `Daily approval scheduled at ${hour}:00 GMT (${expr})`);
}

export async function sendDailyPrompt(): Promise<void> {
  try {
    const [cfg, balance, watch] = await Promise.all([
      getConfig(),
      roblox.getBalance().catch(() => 0),
      listWatch(),
    ]);

    const msg = await dmOwner(dailyApprovalEmbed(balance, cfg.dailyCapRobux, watch.length));
    await ensureTodaysApprovalRow(msg?.id);
    log.info('SCHEDULER', 'Sent daily approval prompt');

    // Morning digest of recommendations.
    const { picks, balance: bal } = await computeRecommendations(8);
    if (picks.length) await dmOwner(buildRecommendEmbed(picks, bal));

    // Daily market movers digest.
    await runMoversDigest();
  } catch (e) {
    log.error('SCHEDULER', `Daily prompt failed: ${(e as Error).message}`);
  }
}
