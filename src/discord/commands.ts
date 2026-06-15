// ─────────────────────────────────────────────────────────────────────────────
// SLASH COMMAND DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
import {
  SlashCommandBuilder, SlashCommandSubcommandsOnlyBuilder, SlashCommandOptionsOnlyBuilder,
} from 'discord.js';

export const commands: (
  | SlashCommandBuilder
  | SlashCommandSubcommandsOnlyBuilder
  | SlashCommandOptionsOnlyBuilder
)[] = [
  new SlashCommandBuilder()
    .setName('snipe')
    .setDescription('Configure and control the sniper')
    .addSubcommand(s => s.setName('config').setDescription('Show current configuration'))
    .addSubcommand(s => s.setName('status').setDescription("Today's approval, spend and state"))
    .addSubcommand(s => s.setName('enable').setDescription('Enable auto-buy'))
    .addSubcommand(s => s.setName('disable').setDescription('Disable auto-buy'))
    .addSubcommand(s => s.setName('pause').setDescription('Kill switch — stop everything'))
    .addSubcommand(s => s.setName('resume').setDescription('Resume (still needs daily approval)'))
    .addSubcommand(s => s.setName('set-daily-cap').setDescription('Max Robux to spend per day')
      .addIntegerOption(o => o.setName('robux').setDescription('Daily cap').setRequired(true).setMinValue(0)))
    .addSubcommand(s => s.setName('set-item-cap').setDescription('Max Robux for a single item (0 = none)')
      .addIntegerOption(o => o.setName('robux').setDescription('Item cap').setRequired(true).setMinValue(0)))
    .addSubcommand(s => s.setName('set-threshold').setDescription('% below RAP to trigger')
      .addIntegerOption(o => o.setName('percent').setDescription('Percent').setRequired(true).setMinValue(1).setMaxValue(99)))
    .addSubcommand(s => s.setName('set-floor').setDescription('Absolute price floor (0 = disabled)')
      .addIntegerOption(o => o.setName('robux').setDescription('Floor').setRequired(true).setMinValue(0)))
    .addSubcommand(s => s.setName('set-timeout').setDescription('Per-snipe confirm timeout in seconds (0 = wait forever)')
      .addIntegerOption(o => o.setName('seconds').setDescription('Seconds').setRequired(true).setMinValue(0)))
    .addSubcommand(s => s.setName('watch').setDescription('Add an item to the priority watchlist')
      .addIntegerOption(o => o.setName('item-id').setDescription('Catalog item id').setRequired(true)))
    .addSubcommand(s => s.setName('unwatch').setDescription('Remove an item from the watchlist')
      .addIntegerOption(o => o.setName('item-id').setDescription('Catalog item id').setRequired(true)))
    .addSubcommand(s => s.setName('watchlist').setDescription('Show the watchlist')),

  new SlashCommandBuilder()
    .setName('balance')
    .setDescription('Show live Robux balance and today\'s spend'),

  new SlashCommandBuilder()
    .setName('recommend')
    .setDescription('Top limited picks right now'),

  new SlashCommandBuilder()
    .setName('stats')
    .setDescription('Snipe stats')
    .addStringOption(o => o.setName('period').setDescription('Window').addChoices(
      { name: 'today', value: 'today' },
      { name: 'week', value: 'week' },
      { name: 'all', value: 'all' },
    )),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Recent snipe attempts')
    .addIntegerOption(o => o.setName('limit').setDescription('How many').setMinValue(1).setMaxValue(25)),

  new SlashCommandBuilder()
    .setName('feed')
    .setDescription('New-limiteds feed settings')
    .addSubcommand(s => s.setName('set-channel').setDescription('Channel to post new limiteds')
      .addChannelOption(o => o.setName('channel').setDescription('Target channel').setRequired(true)))
    .addSubcommand(s => s.setName('toggle-events').setDescription('Include/exclude event limiteds'))
    .addSubcommand(s => s.setName('toggle-ugc').setDescription('Include/exclude UGC limiteds')),
].map(c => c);
