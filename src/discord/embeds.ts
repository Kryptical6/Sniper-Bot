// ─────────────────────────────────────────────────────────────────────────────
// EMBEDS & COMPONENTS — all visual building blocks live here
// ─────────────────────────────────────────────────────────────────────────────
import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
} from 'discord.js';
import { RoliItem, SnipeCandidate, SniperConfig } from '../types';
import { ScoreBreakdown, buyTag } from '../services/scoring';

const COLORS = {
  brand: 0x5865f2,
  good: 0x57f287,
  warn: 0xfee75c,
  bad: 0xed4245,
  info: 0x2b2d31,
};

const R = (n: number) => `${n.toLocaleString('en-US')} R$`;
const demandStars = (d: number) =>
  d < 0 ? 'Unrated' : '⭐'.repeat(d) + '☆'.repeat(4 - d);

export function thumbUrl(itemId: number): string {
  return `https://thumbnails.roblox.com/v1/assets?assetIds=${itemId}&size=150x150&format=Png`;
}
export function itemUrl(itemId: number): string {
  return `https://www.roblox.com/catalog/${itemId}`;
}

// ─── Daily approval ──────────────────────────────────────────────────────────
export function dailyApprovalEmbed(balance: number, cap: number, watchCount: number) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('🕙 Daily Snipe Approval')
    .setDescription('Sniping is **paused** until you approve it for today.')
    .addFields(
      { name: 'Balance', value: R(balance), inline: true },
      { name: "Today's cap", value: R(cap), inline: true },
      { name: 'Watchlist', value: `${watchCount} items`, inline: true },
    )
    .setFooter({ text: 'Approval lasts until the next daily request.' })
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('approve_day').setLabel('Approve').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId('pause_day').setLabel('Pause').setStyle(ButtonStyle.Danger).setEmoji('❌'),
  );
  return { embeds: [embed], components: [row] };
}

// ─── Snipe alert ─────────────────────────────────────────────────────────────
export function snipeAlertEmbed(c: SnipeCandidate, spentToday: number, cap: number) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.good)
    .setTitle('🎯 Snipe Detected')
    .setURL(itemUrl(c.itemId))
    .setThumbnail(thumbUrl(c.itemId))
    .addFields(
      { name: 'Item', value: `[${c.name}](${itemUrl(c.itemId)})`, inline: false },
      { name: 'Listed', value: R(c.listing.price), inline: true },
      { name: 'RAP', value: `${R(c.rap)} (↓ ${c.discountPercent.toFixed(0)}%)`, inline: true },
      { name: 'Projected', value: R(c.projectedValue), inline: true },
      { name: 'Demand', value: demandStars(c.demand), inline: true },
      { name: 'Score', value: `${c.score.toFixed(0)}/100`, inline: true },
      { name: 'Spent today', value: `${R(spentToday)} / ${R(cap)}`, inline: true },
    )
    .setTimestamp();

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`buy:${c.itemId}:${c.listing.userAssetId}`).setLabel('Buy').setStyle(ButtonStyle.Success).setEmoji('✅'),
    new ButtonBuilder().setCustomId(`skip:${c.itemId}:${c.listing.userAssetId}`).setLabel('Skip').setStyle(ButtonStyle.Secondary).setEmoji('❌'),
    new ButtonBuilder().setLabel('View').setStyle(ButtonStyle.Link).setURL(itemUrl(c.itemId)),
  );
  return { embeds: [embed], components: [row] };
}

export function buyResultEmbed(name: string, ok: boolean, detail: string) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(ok ? COLORS.good : COLORS.bad)
      .setTitle(ok ? '✅ Purchased' : '⚠️ Purchase Failed')
      .setDescription(`**${name}**\n${detail}`)
      .setTimestamp()],
  };
}

export function missedEmbed(name: string, price: number) {
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.warn)
      .setTitle('🏃 Snipe Missed')
      .setDescription(`**${name}** at ${R(price)} was gone before you confirmed.`)
      .setTimestamp()],
  };
}

// ─── New limiteds feed ───────────────────────────────────────────────────────
export function feedEmbed(item: RoliItem, currentPrice: number | null) {
  const projected = item.value > 0 ? item.value : item.rap;
  const embed = new EmbedBuilder()
    .setColor(COLORS.info)
    .setTitle(`🆕 ${item.name}`)
    .setURL(itemUrl(item.id))
    .setThumbnail(thumbUrl(item.id))
    .addFields(
      { name: 'Price', value: currentPrice ? R(currentPrice) : 'On sale', inline: true },
      { name: 'Projected', value: projected > 0 ? R(projected) : 'N/A', inline: true },
      { name: 'Demand', value: demandStars(item.demand), inline: true },
    )
    .setTimestamp();
  return { embeds: [embed] };
}

// ─── Recommendations ─────────────────────────────────────────────────────────
export function recommendEmbed(
  picks: { item: RoliItem; price: number; breakdown: ScoreBreakdown }[],
  balance: number
) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.brand)
    .setTitle('📊 Top Limited Picks')
    .setDescription(`Balance: **${R(balance)}** — ranked by overall score`)
    .setTimestamp();

  if (picks.length === 0) {
    embed.setDescription(`Balance: **${R(balance)}**\n\nNothing meets the bar right now.`);
  }
  picks.slice(0, 8).forEach((p, idx) => {
    embed.addFields({
      name: `${idx + 1}. ${buyTag(p.breakdown.total)}  ${p.item.name}  ·  ${p.breakdown.total.toFixed(0)}/100`,
      value:
        `**Price** ${R(p.price)} **Proj** ${R(p.item.value > 0 ? p.item.value : p.item.rap)} **Demand** ${demandStars(p.item.demand)}\n` +
        `**ROI** ${p.breakdown.roi} **Activity** ${p.breakdown.activity} [View ↗](${itemUrl(p.item.id)})`,
      inline: false,
    });
  });
  return { embeds: [embed] };
}

export function realtimeRecEmbed(item: RoliItem, price: number, breakdown: ScoreBreakdown) {
  const embed = new EmbedBuilder()
    .setColor(COLORS.good)
    .setTitle('💡 Recommendation Alert')
    .setURL(itemUrl(item.id))
    .setThumbnail(thumbUrl(item.id))
    .setDescription(`**${item.name}** — ${buyTag(breakdown.total)} (${breakdown.total.toFixed(0)}/100)`)
    .addFields(
      { name: 'Price', value: R(price), inline: true },
      { name: 'Projected', value: R(item.value > 0 ? item.value : item.rap), inline: true },
      { name: 'Demand', value: demandStars(item.demand), inline: true },
    )
    .setTimestamp();
  return { embeds: [embed] };
}

// ─── Config / status ─────────────────────────────────────────────────────────
export function configEmbed(cfg: SniperConfig, approvalStatus: string, spentToday: number) {
  const state = cfg.paused ? '⏸️ Paused' : cfg.enabled ? '🟢 Enabled' : '⚪ Disabled';
  return {
    embeds: [new EmbedBuilder()
      .setColor(COLORS.info)
      .setTitle('⚙️ Sniper Configuration')
      .addFields(
        { name: 'Auto-buy', value: state, inline: true },
        { name: "Today", value: `${approvalStatus} · ${R(spentToday)} spent`, inline: true },
        { name: 'Daily cap', value: R(cfg.dailyCapRobux), inline: true },
        { name: 'Item cap', value: cfg.itemCapRobux ? R(cfg.itemCapRobux) : 'None', inline: true },
        { name: 'Threshold', value: `${cfg.thresholdPercent}% below RAP`, inline: true },
        { name: 'Floor', value: cfg.floorRobux ? R(cfg.floorRobux) : 'None', inline: true },
        { name: 'Confirm timeout', value: cfg.confirmTimeoutSeconds ? `${cfg.confirmTimeoutSeconds}s` : 'Wait forever', inline: true },
        { name: 'Poll interval', value: `${cfg.pollIntervalSeconds}s`, inline: true },
        { name: 'Feed', value: cfg.feedChannelId ? `<#${cfg.feedChannelId}>` : 'Not set', inline: true },
      )
      .setTimestamp()],
  };
}

export const colors = COLORS;
export const robux = R;
