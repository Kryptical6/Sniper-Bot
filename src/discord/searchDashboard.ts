// ─────────────────────────────────────────────────────────────────────────────
// SEARCH DASHBOARD — /search <id | name/tag>
//
// customId namespace: q:*
// ─────────────────────────────────────────────────────────────────────────────
import {
  EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { ItemAnalysis } from '../services/analysis';
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
      { name: 'Outlook', value: a.outlook, inline: true },
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

export function noMatchEmbed(query: string): Panel {
  return {
    embeds: [new EmbedBuilder().setColor(colors.bad).setTitle('🔎 No match')
      .setDescription(`Couldn't find a limited matching **${query}**. Try the exact item ID or a different keyword.`)],
    components: [],
  };
}
