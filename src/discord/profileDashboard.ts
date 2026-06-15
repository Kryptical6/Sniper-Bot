// ─────────────────────────────────────────────────────────────────────────────
// PROFILE DASHBOARD — /profile (and /history)
//
// customId namespace: p:*
// ─────────────────────────────────────────────────────────────────────────────
import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle,
} from 'discord.js';
import { RoliItem } from '../types';
import { priceOutlook } from '../services/scoring';
import { profitPossibility, sellGuidance } from '../services/analysis';
import { isVolatile } from '../services/scoring';
import { Panel } from './dashboards';
import { colors, robux, itemUrl, thumbUrl } from './embeds';

export interface ProfileSummary {
  username: string;
  balance: number | null;
  totalRap: number;
  itemCount: number;
  estValue: number; // sum of RoliMons projected values where available
}

export interface InventoryRow {
  assetId: number;
  userAssetId: number;
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

const POSS_COLOR: Record<string, number> = {
  '🟢 High': colors.good, '🟡 Medium': colors.warn, '🟠 Low': 0xe67e22, '🔴 None': colors.bad,
};

export function inventoryView(rows: InventoryRow[], page = 0, marginPct = 20): Panel {
  // One card embed per item (with thumbnail) for readability. Discord caps a
  // message at 10 embeds; 3 cards + header per page keeps generous spacing.
  const PER = 3;
  const pages = Math.max(1, Math.ceil(rows.length / PER));
  const clamped = Math.min(Math.max(0, page), pages - 1);
  const slice = rows.slice(clamped * PER, clamped * PER + PER);

  const totalRap = rows.reduce((s, r) => s + (r.rap || 0), 0);
  const header = new EmbedBuilder()
    .setColor(colors.brand)
    .setTitle('🎒 Inventory — Limiteds')
    .setDescription(`**${rows.length}** items  ·  Total RAP **${robux(totalRap)}**`)
    .setFooter({ text: `Page ${clamped + 1} of ${pages}` });

  const embeds: EmbedBuilder[] = [header];

  if (slice.length === 0) {
    header.setDescription('No limiteds found in this account.');
  } else {
    for (const r of slice) {
      const pl = r.cost != null ? r.rap - r.cost : null;
      const target = r.meta ? (r.meta.value > 0 ? Math.round(r.meta.rap * 0.5 + r.meta.value * 0.5) : r.rap) : r.rap;
      const basis = r.cost ?? r.rap;
      const poss = profitPossibility(basis, target);
      const sell = sellGuidance({ meta: r.meta, rap: r.rap, cost: r.cost, marginPct });
      const volatile = isVolatile(r.meta);

      const card = new EmbedBuilder()
        .setColor(POSS_COLOR[poss.label] ?? colors.info)
        .setTitle(r.name.slice(0, 240))
        .setURL(itemUrl(r.assetId))
        .setThumbnail(thumbUrl(r.assetId))
        .addFields(
          { name: 'RAP', value: robux(r.rap), inline: true },
          { name: 'Demand', value: demandStars(r.meta?.demand ?? -1), inline: true },
          { name: 'Outlook', value: priceOutlook(r.meta) + (volatile ? '  ⚠️' : ''), inline: true },
        );

      if (r.cost != null) {
        card.addFields(
          { name: 'Bought', value: robux(r.cost), inline: true },
          { name: 'Unrealised', value: `${pl! >= 0 ? '+' : ''}${robux(pl!)}`, inline: true },
          { name: 'Profit potential', value: `${poss.label} (${poss.pct >= 0 ? '+' : ''}${poss.pct}%)`, inline: true },
        );
      } else {
        card.addFields(
          { name: 'Profit potential', value: `${poss.label} (${poss.pct >= 0 ? '+' : ''}${poss.pct}% at ${robux(target)})`, inline: false },
        );
      }

      card.addFields({
        name: '💰 Suggested sell',
        value: `**${robux(sell.suggestedPrice)}**  →  net ~${robux(sell.net)}\n${sell.advice}\n​`,
        inline: false,
      });
      card.setFooter({ text: `ID ${r.assetId}  ·  ━━━━━━━━━━━━━━━━━━━━` });

      embeds.push(card);
    }
  }

  const nav = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`p:inv:${clamped - 1}`).setLabel('Prev').setStyle(ButtonStyle.Secondary).setEmoji('◀️').setDisabled(clamped === 0),
    new ButtonBuilder().setCustomId(`p:inv:${clamped + 1}`).setLabel('Next').setStyle(ButtonStyle.Secondary).setEmoji('▶️').setDisabled(clamped >= pages - 1),
    new ButtonBuilder().setCustomId('p:back').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'),
  );
  const components: ActionRowBuilder<ButtonBuilder>[] = [];
  const missingCost = slice.filter(r => r.cost == null);
  if (missingCost.length) {
    components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
      missingCost.map(r =>
        new ButtonBuilder()
          .setCustomId(`p:cost:${clamped}:${r.assetId}:${r.userAssetId}`)
          .setLabel(`Set cost: ${r.name}`.slice(0, 80))
          .setStyle(ButtonStyle.Primary)
          .setEmoji('💵')
      )
    ));
  }
  components.push(nav);
  return { embeds, components };
}

export function costBasisModal(page: number, assetId: number, userAssetId: number, itemName: string): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`p:cost:modal:${page}:${assetId}:${userAssetId}`)
    .setTitle(`Set cost: ${itemName}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('price').setLabel('Bought price (R$)')
          .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 2500'),
      ),
    );
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
