// ─────────────────────────────────────────────────────────────────────────────
// INTERACTION ROUTER — dashboards, buttons, modals, selects
//
// Two slash commands (/snipe, /feed) open ephemeral dashboards; everything else
// is component-driven. Strictly owner-gated.
// ─────────────────────────────────────────────────────────────────────────────
import {
  Interaction, ChatInputCommandInteraction, ButtonInteraction,
  ModalSubmitInteraction, ChannelSelectMenuInteraction, StringSelectMenuInteraction,
} from 'discord.js';
import { config } from '../config';
import { log } from '../utils/logger';
import {
  getConfig, setConfig, getTodaysApproval, setApprovalStatus, ensureTodaysApprovalRow,
  addWatch, removeWatch, listWatch, getStats, getHoldings, getListing, getRealizedPnl,
} from '../db/helpers';
import { buyResultEmbed, missedEmbed, robux } from './embeds';
import {
  snipeDashboard, settingsModal, watchlistView, watchAddModal, watchRemoveModal,
  feedDashboard, sellDashboard, sellPriceModal, SellRow, parseNum,
} from './dashboards';
import { roblox } from '../roblox/client';
import { rolimons } from '../roblox/rolimons';
import { computeRecommendations, buildRecommendEmbed } from '../services/recommendService';
import { executeBuy } from '../services/buyService';
import { listSale } from '../services/sellService';
import { suggestSellPrice } from '../services/scoring';
import { pendingPrompts } from '../services/snipeEngine';

export async function handleInteraction(i: Interaction): Promise<void> {
  if (i.user.id !== config.discord.ownerId) {
    if (i.isRepliable()) await i.reply({ content: 'This bot is private.', ephemeral: true });
    return;
  }
  try {
    if (i.isChatInputCommand()) await handleCommand(i);
    else if (i.isButton()) await handleButton(i);
    else if (i.isModalSubmit()) await handleModal(i);
    else if (i.isChannelSelectMenu()) await handleChannelSelect(i);
    else if (i.isStringSelectMenu()) await handleStringSelect(i);
  } catch (e) {
    log.error('INTERACTION', (e as Error).message);
    if (i.isRepliable() && !i.replied && !i.deferred) {
      await i.reply({ content: `Error: ${(e as Error).message}`, ephemeral: true }).catch(() => {});
    }
  }
}

// ─── Dashboard payload builders ──────────────────────────────────────────────
async function buildSnipePayload() {
  const [cfg, appr, balance, watch] = await Promise.all([
    getConfig(), getTodaysApproval(), roblox.getBalance().catch(() => null), listWatch(),
  ]);
  return snipeDashboard(cfg, balance, appr?.status ?? 'pending', appr?.spentRobux ?? 0, watch.length);
}

async function buildFeedPayload() {
  return feedDashboard(await getConfig());
}

async function buildSellPayload() {
  const [cfg, holdings] = await Promise.all([getConfig(), getHoldings()]);
  await rolimons.refresh();
  const rows: SellRow[] = holdings.map(listing => {
    const meta = rolimons.get(listing.itemId);
    const rap = meta?.rap ?? 0;
    const suggestion = listing.status === 'held'
      ? suggestSellPrice(listing.costRobux, cfg.sellDefaultMarginPct, rap)
      : null;
    return { listing, rap, suggestion };
  });
  return sellDashboard(rows);
}

// ─── Slash commands ──────────────────────────────────────────────────────────
async function handleCommand(i: ChatInputCommandInteraction): Promise<void> {
  if (i.commandName === 'snipe') return void i.reply({ ...(await buildSnipePayload()), ephemeral: true });
  if (i.commandName === 'feed')  return void i.reply({ ...(await buildFeedPayload()), ephemeral: true });
}

// ─── Buttons ─────────────────────────────────────────────────────────────────
async function handleButton(i: ButtonInteraction): Promise<void> {
  const id = i.customId;

  // Daily approval (from the scheduled DM)
  if (id === 'approve_day') {
    await ensureTodaysApprovalRow(); await setApprovalStatus('approved');
    return void i.update({ content: '✅ Sniping **approved** for today.', embeds: [], components: [] });
  }
  if (id === 'pause_day') {
    await ensureTodaysApprovalRow(); await setApprovalStatus('paused');
    return void i.update({ content: '❌ Sniping **paused** for today.', embeds: [], components: [] });
  }

  // Snipe alert buy/skip (customId: buy|skip:<itemId>:<userAssetId>)
  if (id.startsWith('buy:') || id.startsWith('skip:')) return handleBuySkip(i);

  // ── Snipe dashboard ──
  switch (id) {
    case 's:toggle': {
      const cfg = await getConfig();
      await setConfig('enabled', !cfg.enabled);
      return void i.update(await buildSnipePayload());
    }
    case 's:pause': {
      const cfg = await getConfig();
      await setConfig('paused', !cfg.paused);
      return void i.update(await buildSnipePayload());
    }
    case 's:settings':
      return void i.showModal(settingsModal(await getConfig()));
    case 's:watchlist':
      return void i.update(watchlistView(await listWatch()));
    case 's:sell':
      return void i.update(await buildSellPayload());
    case 's:back':
      return void i.update(await buildSnipePayload());
    case 's:refresh':
      return void i.update(await buildSnipePayload());
    case 's:wl:add':
      return void i.showModal(watchAddModal());
    case 's:wl:rm':
      return void i.showModal(watchRemoveModal());
    case 's:recommend': {
      await i.deferReply({ ephemeral: true });
      const { picks, balance } = await computeRecommendations(8);
      return void i.editReply(buildRecommendEmbed(picks, balance));
    }
    case 's:stats': {
      const [s, pnl] = await Promise.all([getStats('all'), getRealizedPnl()]);
      const prompted = s.byOutcome['prompted'] ?? 0;
      const winRate = prompted > 0 ? Math.round((s.bought / prompted) * 100) : 0;
      const realized = pnl.proceeds - pnl.cost;
      return void i.reply({
        ephemeral: true,
        content:
          `📊 **Stats (all time)**\n` +
          `Bought **${s.bought}** · Spent **${robux(s.spent)}**\n` +
          `Missed ${s.byOutcome['missed'] ?? 0} · Skipped ${s.byOutcome['skipped'] ?? 0} · Failed ${s.byOutcome['failed'] ?? 0}\n` +
          `Win rate **${winRate}%**\n` +
          `💸 Sold **${pnl.sold}** · realized net ${robux(pnl.proceeds)} → **${realized >= 0 ? '+' : ''}${robux(realized)}** profit`,
      });
    }
  }

  // ── Feed dashboard ──
  switch (id) {
    case 'f:events': {
      const cfg = await getConfig();
      await setConfig('feedIncludeEvents', !cfg.feedIncludeEvents);
      return void i.update(await buildFeedPayload());
    }
    case 'f:ugc': {
      const cfg = await getConfig();
      await setConfig('feedIncludeUgc', !cfg.feedIncludeUgc);
      return void i.update(await buildFeedPayload());
    }
    case 'f:refresh':
      return void i.update(await buildFeedPayload());
  }
}

async function handleBuySkip(i: ButtonInteraction): Promise<void> {
  const [action, , uaidStr] = i.customId.split(':');
  const uaid = Number(uaidStr);
  const candidate = pendingPrompts.get(uaid);

  if (action === 'skip') {
    pendingPrompts.delete(uaid);
    return void i.update({ content: '❌ Skipped.', embeds: [], components: [] });
  }
  if (!candidate) {
    return void i.update({ content: '⚠️ This snipe has expired.', embeds: [], components: [] });
  }
  await i.update({ content: '⏳ Buying…', components: [] });
  pendingPrompts.delete(uaid);
  const result = await executeBuy(candidate);
  if (!result.ok && /gone/i.test(result.detail)) {
    await i.followUp(missedEmbed(candidate.name, candidate.listing.price));
  } else {
    await i.followUp(buyResultEmbed(candidate.name, result.ok, result.detail));
  }
}

// ─── Modals ──────────────────────────────────────────────────────────────────
async function handleModal(i: ModalSubmitInteraction): Promise<void> {
  if (i.customId === 's:settings:modal') {
    const dailyCap  = parseNum(i.fields.getTextInputValue('daily_cap'));
    const itemCap   = parseNum(i.fields.getTextInputValue('item_cap'));
    const threshold = parseNum(i.fields.getTextInputValue('threshold'));
    const floor     = parseNum(i.fields.getTextInputValue('floor'));
    const timeout   = parseNum(i.fields.getTextInputValue('timeout'));

    if (dailyCap !== undefined)  await setConfig('dailyCapRobux', Math.max(0, dailyCap));
    if (itemCap !== undefined)   await setConfig('itemCapRobux', itemCap <= 0 ? null : itemCap);
    if (threshold !== undefined) await setConfig('thresholdPercent', clamp(threshold, 1, 99));
    if (floor !== undefined)     await setConfig('floorRobux', floor <= 0 ? null : floor);
    if (timeout !== undefined)   await setConfig('confirmTimeoutSeconds', timeout <= 0 ? null : timeout);

    return refreshFromModal(i, await buildSnipePayload());
  }

  if (i.customId === 's:wl:add:modal') {
    const id = parseNum(i.fields.getTextInputValue('item_id'));
    const floor = parseNum(i.fields.getTextInputValue('floor'));
    if (id === undefined) return void i.reply({ content: '⚠️ Invalid item ID.', ephemeral: true });
    await rolimons.refresh();
    const meta = rolimons.get(id);
    await addWatch(id, meta?.name ?? '', floor ?? null);
    return refreshFromModal(i, watchlistView(await listWatch()));
  }

  if (i.customId === 's:wl:rm:modal') {
    const id = parseNum(i.fields.getTextInputValue('item_id'));
    if (id === undefined) return void i.reply({ content: '⚠️ Invalid item ID.', ephemeral: true });
    await removeWatch(id);
    return refreshFromModal(i, watchlistView(await listWatch()));
  }

  if (i.customId.startsWith('s:sell:modal:')) {
    const listingId = i.customId.slice('s:sell:modal:'.length);
    const price = parseNum(i.fields.getTextInputValue('price'));
    if (price === undefined || price < 1) {
      return void i.reply({ content: '⚠️ Invalid price.', ephemeral: true });
    }
    await i.deferReply({ ephemeral: true });
    const result = await listSale(listingId, price);
    await i.editReply(result.detail);
  }
}

// ─── String select (sell: pick a holding to list) ───────────────────────────
async function handleStringSelect(i: StringSelectMenuInteraction): Promise<void> {
  if (i.customId === 's:sell:pick') {
    const listingId = i.values[0];
    const listing = await getListing(listingId);
    if (!listing || listing.status !== 'held') {
      return void i.reply({ content: '⚠️ That holding is no longer available.', ephemeral: true });
    }
    await rolimons.refresh();
    const rap = rolimons.get(listing.itemId)?.rap ?? 0;
    const cfg = await getConfig();
    const { listPrice } = suggestSellPrice(listing.costRobux, cfg.sellDefaultMarginPct, rap);
    return void i.showModal(sellPriceModal(listingId, listing.itemName, listPrice));
  }
}

// ─── Channel select (feed) ───────────────────────────────────────────────────
async function handleChannelSelect(i: ChannelSelectMenuInteraction): Promise<void> {
  if (i.customId === 'f:channel') {
    const channelId = i.values[0];
    await setConfig('feedChannelId', channelId);
    return void i.update(await buildFeedPayload());
  }
}

// ─── helpers ─────────────────────────────────────────────────────────────────
async function refreshFromModal(i: ModalSubmitInteraction, payload: any): Promise<void> {
  // If the modal was opened from a dashboard message, update it in place;
  // otherwise just confirm.
  if (i.isFromMessage()) await i.update(payload);
  else await i.reply({ ...payload, ephemeral: true });
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
