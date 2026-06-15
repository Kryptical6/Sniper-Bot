// ─────────────────────────────────────────────────────────────────────────────
// SLASH COMMAND DEFINITIONS
//
// Just two entrypoints — each opens an interactive dashboard. Everything else
// (settings, watchlist, recommendations, stats, feed config) is driven by the
// buttons, modals and selects on those dashboards.
// ─────────────────────────────────────────────────────────────────────────────
import { SlashCommandBuilder } from 'discord.js';

export const commands = [
  new SlashCommandBuilder()
    .setName('snipe')
    .setDescription('Open the sniper control dashboard'),

  new SlashCommandBuilder()
    .setName('feed')
    .setDescription('Open the new-limiteds feed dashboard'),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Your RAP, balance, inventory and history'),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Items you have bought and sold'),

  new SlashCommandBuilder()
    .setName('search')
    .setDescription('Look up a limited by ID or name and analyse it')
    .addStringOption(o =>
      o.setName('query').setDescription('Item ID, or a name/keyword').setRequired(true)),

  new SlashCommandBuilder()
    .setName('trade')
    .setDescription('Evaluate a trade: items you give vs items you receive')
    .addStringOption(o =>
      o.setName('give').setDescription('Items you give — comma-separated IDs or names').setRequired(true))
    .addStringOption(o =>
      o.setName('receive').setDescription('Items you receive — comma-separated IDs or names').setRequired(true)),

  new SlashCommandBuilder()
    .setName('alert')
    .setDescription('Manage price target alerts'),
];
