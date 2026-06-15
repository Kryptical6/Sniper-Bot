// ─────────────────────────────────────────────────────────────────────────────
// INTERACTION ROUTER — slash commands + button handling
//
// Everything is owner-gated: the bot only ever obeys config.discord.ownerId.
// ─────────────────────────────────────────────────────────────────────────────
import { Interaction, ChatInputCommandInteraction, ButtonInteraction } from 'discord.js';
import { config } from '../config';
import { log } from '../utils/logger';
import {
  getConfig, setConfig, getTodaysApproval, setApprovalStatus, ensureTodaysApprovalRow,
  addWatch, removeWatch, listWatch, getStats, recentHistory,
} from '../db/helpers';
import { configEmbed, buyResultEmbed, missedEmbed, robux } from './embeds';
import { roblox } from '../roblox/client';
import { rolimons } from '../roblox/rolimons';
import { computeRecommendations, buildRecommendEmbed } from '../services/recommendService';
import { executeBuy } from '../services/buyService';
import { pendingPrompts } from '../services/snipeEngine';

export async function handleInteraction(i: Interaction): Promise<void> {
  // Hard owner gate.
  if (i.user.id !== config.discord.ownerId) {
    if (i.isRepliable()) {
      await i.reply({ content: 'This bot is private.', ephemeral: true });
    }
    return;
  }

  try {
    if (i.isChatInputCommand()) await handleCommand(i);
    else if (i.isButton()) await handleButton(i);
  } catch (e) {
    log.error('INTERACTION', (e as Error).message);
    if (i.isRepliable() && !i.replied && !i.deferred) {
      await i.reply({ content: `Error: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
    }
  }
}

// ─── Slash commands ──────────────────────────────────────────────────────────
async function handleCommand(i: ChatInputCommandInteraction): Promise<void> {
  switch (i.commandName) {
    case 'snipe':   return snipeCommand(i);
    case 'balance': return balanceCommand(i);
    case 'recommend': return recommendCommand(i);
    case 'stats':   return statsCommand(i);
    case 'history': return historyCommand(i);
    case 'feed':    return feedCommand(i);
  }
}

async function snipeCommand(i: ChatInputCommandInteraction): Promise<void> {
  const sub = i.options.getSubcommand();
  switch (sub) {
    case 'config': {
      const cfg = await getConfig();
      const appr = await getTodaysApproval();
      return void i.reply(configEmbed(cfg, appr?.status ?? 'pending', appr?.spentRobux ?? 0));
    }
    case 'status': {
      const cfg = await getConfig();
      const appr = await getTodaysApproval();
      const state = cfg.paused ? '⏸️ Paused' : cfg.enabled ? '🟢 Enabled' : '⚪ Disabled';
      return void i.reply({
        content:
          `**State:** ${state}\n` +
          `**Today:** ${appr?.status ?? 'pending'} · spent ${robux(appr?.spentRobux ?? 0)} / ${robux(cfg.dailyCapRobux)}`,
        ephemeral: true,
      });
    }
    case 'enable':  await setConfig('enabled', true);  return ack(i, 'Auto-buy **enabled**.');
    case 'disable': await setConfig('enabled', false); return ack(i, 'Auto-buy **disabled**.');
    case 'pause':   await setConfig('paused', true);   return ack(i, '⏸️ **Paused** — everything stopped.');
    case 'resume':  await setConfig('paused', false);  return ack(i, '▶️ **Resumed** (still needs daily approval).');
    case 'set-daily-cap': {
      const v = i.options.getInteger('robux', true);
      await setConfig('dailyCapRobux', v);
      return ack(i, `Daily cap set to ${robux(v)}.`);
    }
    case 'set-item-cap': {
      const v = i.options.getInteger('robux', true);
      await setConfig('itemCapRobux', v === 0 ? null : v);
      return ack(i, v === 0 ? 'Per-item cap removed.' : `Item cap set to ${robux(v)}.`);
    }
    case 'set-threshold': {
      const v = i.options.getInteger('percent', true);
      await setConfig('thresholdPercent', v);
      return ack(i, `Threshold set to ${v}% below RAP.`);
    }
    case 'set-floor': {
      const v = i.options.getInteger('robux', true);
      await setConfig('floorRobux', v === 0 ? null : v);
      return ack(i, v === 0 ? 'Price floor disabled.' : `Floor set to ${robux(v)}.`);
    }
    case 'set-timeout': {
      const v = i.options.getInteger('seconds', true);
      await setConfig('confirmTimeoutSeconds', v === 0 ? null : v);
      return ack(i, v === 0 ? 'Confirm timeout disabled (waits forever).' : `Confirm timeout set to ${v}s.`);
    }
    case 'watch': {
      const id = i.options.getInteger('item-id', true);
      await rolimons.refresh();
      const meta = rolimons.get(id);
      await addWatch(id, meta?.name ?? '');
      return ack(i, `Watching **${meta?.name ?? id}**.`);
    }
    case 'unwatch': {
      const id = i.options.getInteger('item-id', true);
      await removeWatch(id);
      return ack(i, `Unwatched ${id}.`);
    }
    case 'watchlist': {
      const list = await listWatch();
      const body = list.length
        ? list.map(w => `• ${w.name || w.itemId} (\`${w.itemId}\`)`).join('\n')
        : '_Watchlist is empty._';
      return void i.reply({ content: `**Watchlist**\n${body}`, ephemeral: true });
    }
  }
}

async function balanceCommand(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply({ ephemeral: true });
  const [balance, cfg, appr] = await Promise.all([
    roblox.getBalance().catch(() => null), getConfig(), getTodaysApproval(),
  ]);
  await i.editReply(
    balance == null
      ? '⚠️ Could not read balance (cookie may be invalid).'
      : `💰 **${robux(balance)}**\nSpent today: ${robux(appr?.spentRobux ?? 0)} / ${robux(cfg.dailyCapRobux)}`
  );
}

async function recommendCommand(i: ChatInputCommandInteraction): Promise<void> {
  await i.deferReply();
  const { picks, balance } = await computeRecommendations(8);
  await i.editReply(buildRecommendEmbed(picks, balance));
}

async function statsCommand(i: ChatInputCommandInteraction): Promise<void> {
  const period = (i.options.getString('period') ?? 'all') as 'today' | 'week' | 'all';
  const s = await getStats(period);
  const prompted = s.byOutcome['prompted'] ?? 0;
  const bought = s.bought;
  const winRate = prompted > 0 ? Math.round((bought / prompted) * 100) : 0;
  const valueDelta = s.rapValue - s.spent;
  await i.reply({
    content:
      `📊 **Stats (${period})**\n` +
      `Bought: **${bought}** · Spent: **${robux(s.spent)}**\n` +
      `Missed: ${s.byOutcome['missed'] ?? 0} · Skipped: ${s.byOutcome['skipped'] ?? 0} · Failed: ${s.byOutcome['failed'] ?? 0}\n` +
      `Prompted: ${prompted} · Win rate: **${winRate}%**\n` +
      `Est. RAP value acquired: ${robux(s.rapValue)} (${valueDelta >= 0 ? '+' : ''}${robux(valueDelta)} vs spent)`,
    ephemeral: true,
  });
}

async function historyCommand(i: ChatInputCommandInteraction): Promise<void> {
  const limit = i.options.getInteger('limit') ?? 10;
  const rows = await recentHistory(limit);
  const body = rows.length
    ? rows.map((r: any) =>
        `\`${r.outcome.padEnd(8)}\` ${r.item_name || '?'} — ${robux(r.listed_price)}` +
        (r.discount_percent ? ` (↓${Number(r.discount_percent).toFixed(0)}%)` : '') +
        (r.reason ? ` · ${r.reason}` : '')
      ).join('\n')
    : '_No history yet._';
  await i.reply({ content: `🧾 **Recent attempts**\n${body}`.slice(0, 1900), ephemeral: true });
}

async function feedCommand(i: ChatInputCommandInteraction): Promise<void> {
  const sub = i.options.getSubcommand();
  if (sub === 'set-channel') {
    const ch = i.options.getChannel('channel', true);
    await setConfig('feedChannelId', ch.id);
    return ack(i, `New-limiteds feed → <#${ch.id}>`);
  }
  const cfg = await getConfig();
  if (sub === 'toggle-events') {
    await setConfig('feedIncludeEvents', !cfg.feedIncludeEvents);
    return ack(i, `Event limiteds: ${!cfg.feedIncludeEvents ? 'included' : 'excluded'}.`);
  }
  if (sub === 'toggle-ugc') {
    await setConfig('feedIncludeUgc', !cfg.feedIncludeUgc);
    return ack(i, `UGC limiteds: ${!cfg.feedIncludeUgc ? 'included' : 'excluded'}.`);
  }
}

// ─── Buttons ─────────────────────────────────────────────────────────────────
async function handleButton(i: ButtonInteraction): Promise<void> {
  const id = i.customId;

  // Daily approval
  if (id === 'approve_day') {
    await ensureTodaysApprovalRow();
    await setApprovalStatus('approved');
    await i.update({ content: '✅ Sniping **approved** for today.', embeds: [], components: [] });
    return;
  }
  if (id === 'pause_day') {
    await ensureTodaysApprovalRow();
    await setApprovalStatus('paused');
    await i.update({ content: '❌ Sniping **paused** for today.', embeds: [], components: [] });
    return;
  }

  // Snipe buy / skip — customId form: buy:<itemId>:<userAssetId>
  const [action, , uaidStr] = id.split(':');
  const uaid = Number(uaidStr);
  const candidate = pendingPrompts.get(uaid);

  if (action === 'skip') {
    pendingPrompts.delete(uaid);
    await i.update({ content: '❌ Skipped.', embeds: [], components: [] });
    return;
  }

  if (action === 'buy') {
    if (!candidate) {
      await i.update({ content: '⚠️ This snipe has expired.', embeds: [], components: [] });
      return;
    }
    await i.update({ content: '⏳ Buying…', components: [] });
    pendingPrompts.delete(uaid);
    const result = await executeBuy(candidate);
    if (!result.ok && /gone/i.test(result.detail)) {
      await i.followUp(missedEmbed(candidate.name, candidate.listing.price));
    } else {
      await i.followUp(buyResultEmbed(candidate.name, result.ok, result.detail));
    }
    return;
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────
function ack(i: ChatInputCommandInteraction, msg: string): void {
  void i.reply({ content: msg, ephemeral: true });
}
