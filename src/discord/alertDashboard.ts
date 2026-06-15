// ─────────────────────────────────────────────────────────────────────────────
// ALERT DASHBOARD — /alert  (customId namespace: a:*)
// ─────────────────────────────────────────────────────────────────────────────
import {
  EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
  ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder,
} from 'discord.js';
import { PriceAlert } from '../db/helpers';
import { Panel } from './dashboards';
import { colors, robux } from './embeds';

export function alertDashboard(alerts: PriceAlert[]): Panel {
  const active = alerts.filter(a => a.active);
  const fired = alerts.filter(a => !a.active);

  const embed = new EmbedBuilder()
    .setColor(colors.brand)
    .setTitle('🔔 Price Alerts')
    .setDescription('Get a DM when an item\'s lowest listing crosses your target.')
    .setTimestamp();

  embed.addFields({
    name: `Active (${active.length})`,
    value: active.length
      ? active.map(a =>
          `• **${a.itemName || a.itemId}** — ${a.direction === 'buy' ? '🟢 buy ≤' : '🟡 sell ≥'} ${robux(a.targetPrice)}`
        ).join('\n')
      : '_None set._',
    inline: false,
  });
  if (fired.length) {
    embed.addFields({
      name: `Recently triggered (${fired.length})`,
      value: fired.slice(0, 5).map(a =>
        `• ${a.itemName || a.itemId} — ${a.direction} ${robux(a.targetPrice)} ✓`
      ).join('\n'),
      inline: false,
    });
  }

  const components: ActionRowBuilder<any>[] = [];
  if (alerts.length) {
    components.push(new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder().setCustomId('a:remove')
        .setPlaceholder('Remove an alert')
        .addOptions(alerts.slice(0, 25).map(a => ({
          label: `${a.itemName || a.itemId}`.slice(0, 100),
          description: `${a.direction} ${a.targetPrice} R$${a.active ? '' : ' (triggered)'}`,
          value: a.id,
        }))),
    ));
  }
  components.push(new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('a:add').setLabel('Add alert').setStyle(ButtonStyle.Success).setEmoji('➕'),
    new ButtonBuilder().setCustomId('a:refresh').setLabel('Refresh').setStyle(ButtonStyle.Secondary).setEmoji('🔄'),
  ));

  return { embeds: [embed], components };
}

export function alertAddModal(): ModalBuilder {
  return new ModalBuilder()
    .setCustomId('a:add:modal')
    .setTitle('Add Price Alert')
    .addComponents(
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('item_id').setLabel('Catalog item ID')
          .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 1365767'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('direction').setLabel('Direction: buy or sell')
          .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('buy = alert when cheap · sell = alert when high'),
      ),
      new ActionRowBuilder<TextInputBuilder>().addComponents(
        new TextInputBuilder().setCustomId('price').setLabel('Target price (R$)')
          .setStyle(TextInputStyle.Short).setRequired(true).setPlaceholder('e.g. 9000'),
      ),
    );
}
