// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARDS — interactive control panels for /snipe and /feed
//
// All control lives in embeds + components. customId namespaces:
//   s:*   snipe dashboard        f:*   feed dashboard
//   s:wl:*  watchlist manager    *:modal  modal submissions
// ─────────────────────────────────────────────────────────────────────────────
import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, ChannelSelectMenuBuilder,
  StringSelectMenuBuilder, ChannelType,
} from 'discord.js';
import { SniperConfig, SaleListing } from '../types';
import { WatchEntry } from '../db/helpers';
import { SellSuggestion } from '../services/scoring';
import { colors, robux } from './embeds';
import { config } from '../config';

/**
 * A panel payload usable by both interaction.reply (add `ephemeral`) and
 * interaction.update (which rejects the ephemeral flag).
 */
export interface Panel {
  embeds: EmbedBuilder[];
  components: ActionRowBuilder<any>[];
}

const dot = (on: boolean) => (on ? '🟢' : '⚪');

// ─── SNIPE DASHBOARD ─────────────────────────────────────────────────────────
export function snipeDashboard(
  cfg: SniperConfig,
  balance: number | null,
  approvalStatus: string,
  spentToday: number,
  watchCount: number,
): Panel {
  const state = cfg.paused ? '⏸️ Paused' : cfg.enabled ? '🟢 Auto-buy ON' : '⚪ Auto-buy OFF';
  const mode = config.dryRun ? ' · DRY RUN' : '';
  const approval =
    approvalStatus === 'approved' ? '✅ Approved today'
    : approvalStatus === 'paused' ? '❌ Paused today'
    : '⏳ Awaiting approval';

  const spendBar = progressBar(spentToday, cfg.dailyCapRobux);

  const embed = new EmbedBuilder()
    .setColor(cfg.paused ? colors.bad : cfg.enabled ? colors.good : colors.info)
    .setTitle('🎯 Sniper Control')
    .setDescription(`**${state}${mode}**  ·  ${approval}`)
    .addFields(
      { name: 'Daily spend', value: `${spendBar}\n${robux(spentToday)} / ${robux(cfg.dailyCapRobux)}`, inline: false },
      { name: 'Balance', value: balance == null ? '⚠️ unavailable' : robux(balance), inline: true },
      { name: 'Threshold', value: `${cfg.thresholdPercent}% below RAP`, inline: true },
      { name: 'Global floor', value: cfg.floorRobux ? robux(cfg.floorRobux) : 'None', inline: true },
      { name: 'Item cap', value: cfg.itemCapRobux ? robux(cfg.itemCapRobux) : 'None', inline: true },
      { name: 'Confirm timeout', value: cfg.confirmTimeoutSeconds ? `${cfg.confirmTimeoutSeconds}s` : '∞ wait', inline: true },
      { name: 'Watchlist', value: `${watchCount} item${watchCount === 1 ? '' : 's'}`, inline: true },
    )
    .setFooter({ text: `Poll ~${cfg.pollIntervalSeconds}s · nothing is bought without your click` })
    .setTimestamp();

  const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('s:toggle')
      .setLabel(cfg.enabled ? 'Disable auto-buy' : 'Enable auto-buy')
      .setStyle(cfg.enabled ? ButtonStyle.Secondary : ButtonStyle.Success)
      .setEmoji(dot(cfg.enabled)),
    new ButtonBuilder().setCustomId('s:pause')
      .setLabel(cfg.paused ? 'Resume' : 'Pause')
      .setStyle(cfg.paused ? ButtonStyle.Success : ButtonStyle.Danger)
      .setEmoji(cfg.paused ? '▶️' : '⏸️'),
    new ButtonBuilder().setCustomId('s:settings').setLabel('Settings').setStyle(ButtonStyle.Primary).setEmoji('⚙️'),
  );
  const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('s:watchlist').setLabel('Watchlist').setStyle(ButtonStyle.Secondary).setEmoji('👁️'),
    new ButtonBuilder().setCustomId('s:sell').setLabel('Sell').setStyle(ButtonStyle.Secondary).setEmoji('💰'),
    new ButtonBuilder().setCustomId('s:recommend').setLabel('Recommend').setStyle(ButtonStyle.Secondary).setEmoji('📊'),
    new ButtonBuilder().setCustomId('s:stats').setLabel('Stats').setStyle(ButtonStyle.Secondary).setEmoji('🧾'),
    new ButtonBuilder().setCustomId('s:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
  );

  return { embeds: [embed], components: [row1, row2] };
}

// ─── SELL DASHBOARD ──────────────────────────────────────────────────────────
export interface SellRow {
  listing: SaleListing;
  rap: number;
  suggestion: SellSuggestion | null;
}

export function sellDashboard(rows: SellRow[]): Panel {
  const held = rows.filter(r => r.listing.status === 'held');
  const listed = rows.filter(r => r.listing.status === 'listed');

  const embed = new EmbedBuilder()
    .setColor(colors.brand)
    .setTitle('💰 Sell — Holdings')
    .setFooter({ text: 'Prices are fee-aware (Roblox takes 30% on resales).' })
    .setTimestamp();

  if (held.length) {
    embed.addFields({
      name: `📦 Held (${held.length})`,
      value: held.slice(0, 10).map(r => {
        const s = r.suggestion;
        return `• **${r.listing.itemName}** — cost ${robux(r.listing.costRobux)}` +
          (s ? `\n   suggest ${robux(s.listPrice)} → net ~${robux(s.netProceeds)} (${s.profit >= 0 ? '+' : ''}${robux(s.profit)})` : '');
      }).join('\n'),
      inline: false,
    });
  } else {
    embed.setDescription('No held items to sell yet. Snipes you buy show up here.');
  }

  if (listed.length) {
    embed.addFields({
      name: `🏷️ Listed (${listed.length})`,
      value: listed.slice(0, 10).map(r =>
        `• **${r.listing.itemName}** — listed ${robux(r.listing.listPrice ?? 0)} (net ~${robux(r.listing.netEstimate ?? 0)})`
      ).join('\n'),
      inline: false,
    });
  }

  const components: ActionRowBuilder<any>[] = [];
  if (held.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('s:sell:pick')
      .setPlaceholder('List a held item for sale')
      .addOptions(held.slice(0, 25).map(r => ({
        label: r.listing.itemName.slice(0, 100) || String(r.listing.itemId),
        description: r.suggestion ? `suggest ${r.suggestion.listPrice} R$ · net ${r.suggestion.netProceeds}` : `cost ${r.listing.costRobux} R$`,
        value: r.listing.id,
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }
  if (listed.length) {
    const select = new StringSelectMenuBuilder()
      .setCustomId('s:sell:manage')
      .setPlaceholder('Manage a listed item (reprice / cancel)')
      .addOptions(listed.slice(0, 25).map(r => ({
        label: r.listing.itemName.slice(0, 100) || String(r.listing.itemId),
        description: `listed ${r.listing.listPrice} R$ · net ${r.listing.netEstimate}`,
        value: r.listing.id,
      })));
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(select));
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('s:sell:settings').setLabel('Sell settings').setStyle(ButtonStyle.Primary).setEmoji('⚙️'),
    new ButtonBuilder().setCustomId('s:sell').setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
    new ButtonBuilder().setCustomId('s:back').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'),
  ));

  return { embeds: [embed], components };
}

export function sellSettingsModal(cfg: SniperConfig): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('s:sell:settings:modal')
    .setTitle('Sell Settings')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('margin').setLabel('Target net profit margin (%)')
          .setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.sellDefaultMarginPct)),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('unsold_hours').setLabel('Nag if unsold after (hours)')
          .setStyle(TextInputStyle.Short).setRequired(false).setValue(String(cfg.unsoldNotifyHours)),
      ),
    );
}

/** Reprice/cancel action buttons for a chosen listed item. */
export function manageListingButtons(listingId: string): Panel {
  const embed = new EmbedBuilder().setColor(colors.info).setTitle('🏷️ Manage listing')
    .setDescription('Choose an action for this listed item.');
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`s:sell:reprice:${listingId}`).setLabel('Reprice').setStyle(ButtonStyle.Primary).setEmoji('🏷️'),
    new ButtonBuilder().setCustomId(`s:sell:cancel:${listingId}`).setLabel('Take off sale').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
  );
  return { embeds: [embed], components: [row] };
}

export function repriceModal(listingId: string, itemName: string, current: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`s:sell:reprice:modal:${listingId}`)
    .setTitle(`Reprice: ${itemName}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('price').setLabel('New list price (R$)')
          .setStyle(TextInputStyle.Short).setRequired(true).setValue(String(current)),
      ),
    );
}

export function sellPriceModal(listingId: string, itemName: string, suggested: number): ModalBuilder {
  return new ModalBuilder()
    .setCustomId(`s:sell:modal:${listingId}`)
    .setTitle(`List: ${itemName}`.slice(0, 45))
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('price').setLabel('List price (R$)')
          .setStyle(TextInputStyle.Short).setRequired(true).setValue(String(suggested)),
      ),
    );
}

export function settingsModal(cfg: SniperConfig): ModalBuilder {
  const field = (id: string, label: string, value: string, placeholder: string) =>
    new ActionRowBuilder<TextInputBuilder>().addComponents(
      new TextInputBuilder()
        .setCustomId(id).setLabel(label).setStyle(TextInputStyle.Short)
        .setRequired(false).setValue(value).setPlaceholder(placeholder),
    );

  return new ModalBuilder()
    .setCustomId('s:settings:modal')
    .setTitle('Sniper Settings')
    .addComponents(
      field('daily_cap', 'Daily cap (R$)', String(cfg.dailyCapRobux), 'e.g. 1000'),
      field('item_cap', 'Per-item cap (R$, 0 = none)', cfg.itemCapRobux ? String(cfg.itemCapRobux) : '0', '0 = none'),
      field('threshold', '% below RAP to trigger', String(cfg.thresholdPercent), '1–99'),
      field('floor', 'Global floor (R$, 0 = none)', cfg.floorRobux ? String(cfg.floorRobux) : '0', '0 = none'),
      field('timeout', 'Confirm timeout (sec, 0 = ∞)', cfg.confirmTimeoutSeconds ? String(cfg.confirmTimeoutSeconds) : '0', '0 = wait forever'),
    );
}

// ─── WATCHLIST MANAGER ───────────────────────────────────────────────────────
export function watchlistView(items: WatchEntry[]): Panel {
  const lines = items.length
    ? items.map(w =>
        `• **${w.name || w.itemId}** \`${w.itemId}\` — floor: ${w.floor != null ? robux(w.floor) : 'global'}`
      ).join('\n')
    : '_No items yet. Add one with the button below._';

  const embed = new EmbedBuilder()
    .setColor(colors.brand)
    .setTitle('👁️ Watchlist')
    .setDescription(lines)
    .setFooter({ text: 'Per-item floors override the global floor for that item.' });

  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('s:wl:add').setLabel('Add / Edit item').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('s:wl:rm').setLabel('Remove item').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
    new ButtonBuilder().setCustomId('s:back').setLabel('Back').setStyle(ButtonStyle.Secondary).setEmoji('⬅️'),
  );
  return { embeds: [embed], components: [row] };
}

export function watchAddModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('s:wl:add:modal')
    .setTitle('Add / Edit Watch Item')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('item_id').setLabel('Catalog item ID')
          .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 1365767'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('floor').setLabel('Per-item floor (R$, blank = use global)')
          .setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. 5000'),
      ),
    );
}

export function watchRemoveModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('s:wl:rm:modal')
    .setTitle('Remove Watch Item')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('item_id').setLabel('Catalog item ID to remove')
          .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 1365767'),
      ),
    );
}

// ─── FEED DASHBOARD ──────────────────────────────────────────────────────────
export function feedDashboard(cfg: SniperConfig): Panel {
  const embed = new EmbedBuilder()
    .setColor(colors.info)
    .setTitle('📡 New-Limiteds Feed')
    .setDescription(cfg.feedChannelId
      ? `Posting new limiteds to <#${cfg.feedChannelId}>.`
      : 'No channel set yet — pick one below.')
    .setTimestamp();

  const channelRow = new ActionRowBuilder<ChannelSelectMenuBuilder>().addComponents(
    new ChannelSelectMenuBuilder().setCustomId('f:channel')
      .setPlaceholder('Select the feed channel')
      .addChannelTypes(ChannelType.GuildText),
  );
  const toggleRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('f:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
  );

  return { embeds: [embed], components: [channelRow, toggleRow] };
}

// ─── helpers ─────────────────────────────────────────────────────────────────
function progressBar(value: number, max: number, width = 12): string {
  if (max <= 0) return '▱'.repeat(width);
  const filled = Math.min(width, Math.round((value / max) * width));
  return '▰'.repeat(filled) + '▱'.repeat(width - filled);
}

/** Parses a modal numeric field; returns undefined for blank (no change). */
export function parseNum(raw: string | null): number | undefined {
  if (raw == null) return undefined;
  const t = raw.trim();
  if (t === '') return undefined;
  const n = Number(t.replace(/[, ]/g, ''));
  return Number.isFinite(n) ? n : undefined;
}
