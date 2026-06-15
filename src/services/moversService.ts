// ─────────────────────────────────────────────────────────────────────────────
// MOVERS SERVICE — daily demand/trend/price movers digest
//
// Snapshots RoliMons demand/trend/RAP each day, diffs against the previous
// snapshot, and DMs a digest of the biggest risers and fallers so trends can
// be spotted early. Run once per day from the scheduler.
// ─────────────────────────────────────────────────────────────────────────────
import { EmbedBuilder } from 'discord.js';
import { log } from '../utils/logger';
import { rolimons } from '../roblox/rolimons';
import { getMoverSnapshots, upsertMoverSnapshot } from '../db/helpers';
import { dmOwner } from '../discord/notify';
import { colors, robux } from '../discord/embeds';

interface Mover {
  id: number; name: string;
  oldRap: number; newRap: number; rapPct: number;
  demandDelta: number; trendDelta: number;
}

const DEMAND_LABEL = ['Terrible', 'Low', 'Normal', 'High', 'Amazing'];

export async function runMoversDigest(): Promise<void> {
  try {
    await rolimons.refresh(true);
    const prev = await getMoverSnapshots();
    const current = rolimons.all();

    const movers: Mover[] = [];
    if (prev.size > 0) {
      for (const it of current) {
        const p = prev.get(it.id);
        if (!p || p.rap <= 0) continue;
        const rapPct = ((it.rap - p.rap) / p.rap) * 100;
        const demandDelta = it.demand >= 0 && p.demand >= 0 ? it.demand - p.demand : 0;
        const trendDelta = it.trend >= 0 && p.trend >= 0 ? it.trend - p.trend : 0;
        if (Math.abs(rapPct) >= 8 || demandDelta !== 0) {
          movers.push({ id: it.id, name: it.name, oldRap: p.rap, newRap: it.rap, rapPct, demandDelta, trendDelta });
        }
      }
    }

    // Persist current state for tomorrow's diff regardless.
    for (const it of current) {
      await upsertMoverSnapshot({ itemId: it.id, name: it.name, rap: it.rap, demand: it.demand, trend: it.trend, value: it.value });
    }

    if (prev.size === 0) {
      log.info('MOVERS', 'Seeded first snapshot (no digest sent)');
      return;
    }
    if (movers.length === 0) {
      log.info('MOVERS', 'No significant movers today');
      return;
    }

    const risers = movers.filter(m => m.rapPct > 0 || m.demandDelta > 0)
      .sort((a, b) => b.rapPct - a.rapPct).slice(0, 8);
    const fallers = movers.filter(m => m.rapPct < 0 || m.demandDelta < 0)
      .sort((a, b) => a.rapPct - b.rapPct).slice(0, 8);

    const fmt = (m: Mover) => {
      const dem = m.demandDelta !== 0
        ? ` · demand ${m.demandDelta > 0 ? '↑' : '↓'}${Math.abs(m.demandDelta)}`
        : '';
      return `• **${m.name}** ${robux(m.oldRap)} → ${robux(m.newRap)} (${m.rapPct >= 0 ? '+' : ''}${m.rapPct.toFixed(1)}%)${dem}`;
    };

    const embed = new EmbedBuilder()
      .setColor(colors.brand)
      .setTitle('📈 Daily Market Movers')
      .setDescription('Biggest demand/price shifts since yesterday.')
      .setTimestamp();
    if (risers.length) embed.addFields({ name: '📈 Risers', value: risers.map(fmt).join('\n').slice(0, 1024), inline: false });
    if (fallers.length) embed.addFields({ name: '📉 Fallers', value: fallers.map(fmt).join('\n').slice(0, 1024), inline: false });

    await dmOwner({ embeds: [embed] });
    log.info('MOVERS', `Sent digest (${risers.length} risers, ${fallers.length} fallers)`);
  } catch (e) {
    log.error('MOVERS', `Digest failed: ${(e as Error).message}`);
  }
}
