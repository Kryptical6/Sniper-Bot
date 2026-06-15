// ─────────────────────────────────────────────────────────────────────────────
// ROLIMONS AD DASHBOARD — /rolimons-ad
//
// customId namespace: r:*
// ─────────────────────────────────────────────────────────────────────────────
import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
} from 'discord.js';
import { AdEntry } from '../db/helpers';
import { AD_TAGS } from '../roblox/rolimons';
import { Panel } from './dashboards';
import { colors } from './embeds';

function reqSummary(a: AdEntry): string {
  const items = a.requestItemIds.length ? `${a.requestItemIds.length} item(s)` : '';
  const tags = a.requestTags.length ? a.requestTags.join(', ') : '';
  return [items, tags].filter(Boolean).join(' + ') || 'nothing set';
}

export function adDashboard(ads: AdEntry[], cooldownMs: number, tokenSet: boolean): Panel {
  const embed = new EmbedBuilder()
    .setColor(colors.brand)
    .setTitle('📣 Rolimons Trade Ads')
    .setTimestamp();

  if (!tokenSet) {
    embed.setDescription('⚠️ `ROLIMONS_TOKEN` is not set — posting is disabled. Add your `_RoliVerification` cookie to `.env`.');
  } else {
    const cd = cooldownMs > 0 ? `⏳ ${Math.ceil(cooldownMs / 60000)} min` : '🟢 Ready';
    embed.setDescription(`Next post: **${cd}**  ·  Rolimons allows 1 ad / 15 min.`);
  }

  if (ads.length) {
    embed.addFields(ads.slice(0, 10).map(a => ({
      name: `${a.autoReadvertise ? '🔁' : '⏸️'} ${a.offerItemName || a.offerItemId}`,
      value: `Request: ${reqSummary(a)}` +
        (a.lastPostedAt ? `\nLast posted <t:${Math.floor(a.lastPostedAt.getTime() / 1000)}:R>` : '\nNever posted'),
      inline: false,
    })));
  } else {
    embed.addFields({ name: 'Ads', value: '_No ad entries yet. Add one below._' });
  }

  const components: ActionRowBuilder<any>[] = [];
  if (ads.length) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId('r:pick')
        .setPlaceholder('Select an ad to post / toggle / remove')
        .addOptions(ads.slice(0, 25).map(a => ({
          label: (a.offerItemName || String(a.offerItemId)).slice(0, 100),
          description: `req: ${reqSummary(a)}`.slice(0, 100),
          value: a.id,
        }))),
    ));
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('r:add').setLabel('Add / Edit ad').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('r:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
  ));

  return { embeds: [embed], components };
}

/** Per-entry action buttons shown after selecting an ad. */
export function adActionButtons(a: AdEntry): Panel {
  const embed = new EmbedBuilder()
    .setColor(colors.info)
    .setTitle(`📣 ${a.offerItemName || a.offerItemId}`)
    .setDescription(`Request: ${reqSummary(a)}\nAuto re-advertise: ${a.autoReadvertise ? '🔁 ON' : '⏸️ OFF'}`);
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`r:post:${a.id}`).setLabel('Post now').setStyle(ButtonStyle.Primary).setEmoji('📤'),
    new ButtonBuilder().setCustomId(`r:auto:${a.id}`)
      .setLabel(a.autoReadvertise ? 'Disable auto' : 'Enable auto')
      .setStyle(a.autoReadvertise ? ButtonStyle.Secondary : ButtonStyle.Success).setEmoji('🔁'),
    new ButtonBuilder().setCustomId(`r:rm:${a.id}`).setLabel('Remove').setStyle(ButtonStyle.Danger).setEmoji('🗑️'),
  );
  return { embeds: [embed], components: [row] };
}

export function adAddModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('r:add:modal')
    .setTitle('Add / Edit Trade Ad')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('offer_id').setLabel('Offer item ID (the item you give)')
          .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 1365767'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('request_ids').setLabel('Request item IDs (comma-separated, max 4)')
          .setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder('e.g. 20573078, 1029025'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('request_tags').setLabel(`Request tags (max 4)`)
          .setStyle(TextInputStyle.Short).setRequired(false).setPlaceholder(AD_TAGS.join(', ')),
      ),
    );
}
