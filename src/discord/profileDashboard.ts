// ─────────────────────────────────────────────────────────────────────────────
// PROFILE DASHBOARD — /profile (and /history)
//
// customId namespace: p:*
// ─────────────────────────────────────────────────────────────────────────────
import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { RoliItem } from '../types';
import { priceOutlook } from '../services/scoring';
import { profitPossibility, sellGuidance } from '../services/analysis';
import { Panel } from './dashboards';
import { colors, robux, itemUrl } from './embeds';

export interface ProfileSummary {
  username: string;
  balance: number | null;
  totalRap: number;
  itemCount: number;
  estValue: number; // sum of RoliMons projected values where available
}

export interface InventoryRow {
  assetId: number;
  name: string;
  rap: number;
  cost: number | null;       // what we paid, if known
  meta: RoliItem | undefined; // RoliMons data for demand/outlook
}

// ─── Profile panel ───────────────────────────────────────────────────────────
export function profileDashboard(p: ProfileSummary): Panel {
  const embed = new EmbedBuilder()
    .setColor(colors.brand)
    .setTitle(`👤 ${p.username}`)
    .addFields(
      { name: 'Total RAP', value: robux(p.totalRap), inline: true },
      { name: 'Est. value', value: p.estValue > 0 ? robux(p.estValue) : '—', inline: true },
      { name: 'Limiteds', value: String(p.itemCount), inline: true },
      { name: 'Robux balance', value: p.balance == null ? '⚠️ unavailable' : robux(p.balance), inline: true },
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('p:inventory').setLabel('Inventory').setStyle(ButtonStyle.Primary).setEmoji('🎒'),
    new ButtonBuilder().setCustomId('p:history').setLabel('History').setStyle(ButtonStyle.Secondary).setEmoji('🧾'),
    new ButtonBuilder().setCustomId('p:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
  );
  return { embeds: [embed], components: [row] };
}

// ─── Inventory view ──────────────────────────────────────────────────────────
const demandStars = (d: number) => (d < 0 ? 'Unrated' : '⭐'.repeat(d) + '☆'.repeat(4 - d));

export function inventoryView(rows: InventoryRow[], page = 0, marginPct = 20): Panel {
  const PER = 6;
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const clamped = Math.min(Math.max(0, page), pages - 1);
  const slice = rows.slice(clamped * PER, clamped * PER + PER);

  const embed = new EmbedBuilder()
    .setColor(colors.info)
    .setTitle('🎒 Inventory — Limiteds')
    .setFooter({ text: `Page ${clamped + 1}/${pages} · ${rows.length} items` })
    .setTimestamp();

  if (slice.length === 0) {
    embed.setDescription('No limiteds found in this account.');
  } else {
    for (const r of slice) {
      const pl = r.cost != null ? r.rap - r.cost : null;
      // Profit possibility: sell at projected value (or RAP) vs what we paid
      // (or RAP if cost unknown), fee-aware.
      const target = r.meta && r.meta.value > 0 ? r.meta.value : r.rap;
      const basis = r.cost ?? r.rap;
      const poss = profitPossibility(basis, target);
      const sell = sellGuidance({ meta: r.meta, rap: r.rap, cost: r.cost, marginPct });
      const lines = [
        `**RAP** ${robux(r.rap)}  ·  **Demand** ${demandStars(r.meta?.demand ?? -1)}`,
        `**Outlook** ${priceOutlook(r.meta)}`,
      ];
      if (r.cost != null) {
        lines.push(`**Bought** ${robux(r.cost)}  ·  **Unrealised** ${pl! >= 0 ? '+' : ''}${robux(pl!)}`);
      }
      lines.push(`**Profit potential** ${poss.label}  (${poss.pct >= 0 ? '+' : ''}${poss.pct}% at ${robux(target)})`);
      lines.push(`**Sell** ~${robux(sell.suggestedPrice)} → net ${robux(sell.net)}`);
      lines.push(`${sell.advice}`);
      lines.push(`[View on Roblox](${itemUrl(r.assetId)})`);

      embed.addFields({
        name: `🔹 ${r.name}`.slice(0, 100),
        value: lines.join('\n'),
        inline: false,
      });
    }
  }

  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`p:inv:${clamped - 1}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setEmoji('◀️').setDisabled(clamped === 0),
    new ButtonBuilder().setCustomId(`p:inv:${clamped + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setEmoji('▶️').setDisabled(clamped >= pages - 1),
    new ButtonBuilder().setCustomId('p:back').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'),
  );
  return { embeds: [embed], components: [nav] };
}

// ─── History embed ───────────────────────────────────────────────────────────
export interface HistoryRow {
  itemName: string;
  cost: number;
  status: string;
  listPrice: number | null;
  netEstimate: number | null;
  soldAt: Date | null;
}

export function historyEmbed(rows: HistoryRow[]): Panel {
  const embed = new EmbedBuilder()
    .setColor(colors.brand)
    .setTitle('🧾 Trade History')
    .setTimestamp();

  if (rows.length === 0) {
    embed.setDescription('No purchases yet.');
    return { embeds: [embed], components: [] };
  }

  let realized = 0;
  const lines = rows.map(r => {
    if (r.status === 'sold') {
      const net = r.netEstimate ?? 0;
      const profit = net - r.cost;
      realized += profit;
      return `✅ **${r.itemName}** — bought ${robux(r.cost)} → sold ${robux(r.listPrice ?? 0)} (net ${robux(net)}, ${profit >= 0 ? '+' : ''}${robux(profit)})`;
    }
    if (r.status === 'listed') {
      return `🏷️ **${r.itemName}** — bought ${robux(r.cost)} · listed ${robux(r.listPrice ?? 0)}`;
    }
    return `📦 **${r.itemName}** — bought ${robux(r.cost)} · held`;
  });

  embed.setDescription(lines.slice(0, 20).join('\n\n').slice(0, 4000));
  embed.addFields({ name: '— Realised profit (sold) —', value: `**${realized >= 0 ? '+' : ''}${robux(realized)}**`, inline: false });
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('p:back').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'),
  );
  return { embeds: [embed], components: [row] };
}
