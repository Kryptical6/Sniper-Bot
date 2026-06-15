// ─────────────────────────────────────────────────────────────────────────────
// SEARCH DASHBOARD — /search <id | name/tag>
//
// customId namespace: q:*
// ─────────────────────────────────────────────────────────────────────────────
import {
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { ItemAnalysis, TradeVerdict } from '../services/analysis';
import { Panel } from './dashboards';
import { colors, robux, itemUrl, thumbUrl } from './embeds';

const demandStars = (d: number) => (d < 0 ? 'Unrated' : '⭐'.repeat(d) + '☆'.repeat(4 - d));

export interface SearchMatch { id: number; name: string; rap: number; }

export function searchEmbed(name: string, itemId: number, a: ItemAnalysis, matches: SearchMatch[] = []): Panel {
  const embed = new EmbedBuilder()
    .setColor(colors.brand)
    .setTitle(`🔎 ${name}`)
    .setURL(itemUrl(itemId))
    .setThumbnail(thumbUrl(itemId))
    .addFields(
      { name: 'RAP', value: robux(a.rap), inline: true },
      { name: 'Projected', value: a.projected > 0 ? robux(a.projected) : '—', inline: true },
      { name: 'Demand', value: demandStars(a.demand), inline: true },
      { name: 'Lowest listing', value: a.lowestPrice != null ? robux(a.lowestPrice) : 'none live', inline: true },
      { name: 'vs RAP', value: a.discountPercent != null ? `${a.discountPercent >= 0 ? '↓' : '↑'} ${Math.abs(a.discountPercent)}%` : '—', inline: true },
      { name: 'Outlook', value: a.outlook + (a.volatile ? '  ⚠️ volatile' : ''), inline: true },
      {
        name: 'Profit potential',
        value: a.possibility
          ? `${a.possibility.label} — ${a.possibility.pct >= 0 ? '+' : ''}${a.possibility.pct}% ` +
            `(net ${robux(a.possibility.netIfFlip)} if flipped at projected, ${a.possibility.profit >= 0 ? '+' : ''}${robux(a.possibility.profit)})`
          : 'No live listing to price against',
        inline: false,
      },
      {
        name: 'Latest sales',
        value: a.recentPrices.length ? a.recentPrices.map(p => robux(p)).join(' · ') : 'No recent data',
        inline: false,
      },
      { name: '🕒 Buy timing', value: a.buyAdvice, inline: false },
    )
    .setFooter({ text: 'Heuristic guidance from RoliMons + live market data — not financial advice.' })
    .setTimestamp();

  const components: ActionRowBuilder<any>[] = [];
  if (matches.length > 1) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId('q:pick')
        .setPlaceholder('Other matches — pick to analyse')
        .addOptions(matches.slice(0, 25).map(m => ({
          label: m.name.slice(0, 100),
          description: `RAP ${m.rap.toLocaleString()} · id ${m.id}`,
          value: String(m.id),
        }))),
    ));
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setLabel('Open on Roblox').setStyle(ButtonStyle.Link).setURL(itemUrl(itemId)),
    new ButtonBuilder().setLabel('RoliMons').setStyle(ButtonStyle.Link).setURL(`https://www.rolimons.com/item/${itemId}`),
  ));

  return { embeds: [embed], components };
}

// ─── Trade calculator ────────────────────────────────────────────────────────
export function tradeEmbed(v: TradeVerdict, unresolved: string[]): Panel {
  const color = v.verdict === '✅ Win' ? colors.good : v.verdict === '❌ Loss' ? colors.bad : colors.warn;
  const sideList = (items: { name: string; rap: number }[]) =>
    items.length ? items.map(i => `• ${i.name} — ${robux(i.rap)}`).join('\n') : '_nothing_';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🤝 Trade Verdict: ${v.verdict}`)
    .setDescription(
      `**Value swing:** ${v.valueDiff >= 0 ? '+' : ''}${robux(v.valueDiff)} ` +
      `(${v.valuePct >= 0 ? '+' : ''}${v.valuePct}%)  ·  **RAP swing:** ${v.rapDiff >= 0 ? '+' : ''}${robux(v.rapDiff)}`
    )
    .addFields(
      { name: `📤 You give  ·  value ${robux(v.give.value)}`, value: sideList(v.give.items), inline: false },
      { name: `📥 You receive  ·  value ${robux(v.receive.value)}`, value: sideList(v.receive.items), inline: false },
    )
    .setFooter({ text: 'Value = blended RAP + projected (projected items discounted). Not financial advice.' })
    .setTimestamp();

  if (v.notes.length) embed.addFields({ name: 'Notes', value: v.notes.map(n => `• ${n}`).join('\n'), inline: false });
  if (unresolved.length) embed.addFields({ name: '⚠️ Could not resolve', value: unresolved.join(', '), inline: false });

  return { embeds: [embed], components: [] };
}

export function noMatchEmbed(query: string): Panel {
  return {
    embeds: [new EmbedBuilder().setColor(colors.bad).setTitle('🔎 No match')
      .setDescription(`Couldn't find a limited matching **${query}**. Try the exact item ID or a different keyword.`)],
    components: [],
  };
}
