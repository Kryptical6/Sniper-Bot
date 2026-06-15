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
    .setName('rolimons-ad')
    .setDescription('Manage Rolimons trade ads'),

  new SlashCommandBuilder()
    .setName('profile')
    .setDescription('Your RAP, balance, inventory and history'),

  new SlashCommandBuilder()
    .setName('history')
    .setDescription('Items you have bought and sold'),
];
