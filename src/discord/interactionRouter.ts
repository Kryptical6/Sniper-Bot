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
  listAds, getAd, upsertAd, removeAd, toggleAdAuto,
  getCostByItem, getTradeHistory,
} from '../db/helpers';
import { buyResultEmbed, missedEmbed, robux } from './embeds';
import {
  snipeDashboard, settingsModal, watchlistView, watchAddModal, watchRemoveModal,
  feedDashboard, sellDashboard, sellPriceModal, sellSettingsModal,
  manageListingButtons, repriceModal, SellRow, parseNum,
} from './dashboards';
import { roblox } from '../roblox/client';
import { rolimons } from '../roblox/rolimons';
import { computeRecommendations, buildRecommendEmbed } from '../services/recommendService';
import { executeBuy } from '../services/buyService';
import { listSale, repriceSale, cancelSale } from '../services/sellService';
import { suggestSellPrice } from '../services/scoring';
import { pendingPrompts } from '../services/snipeEngine';
import { adDashboard, adActionButtons, adAddModal } from './adDashboard';
import { postAd, cooldownRemainingMs } from '../services/adService';
import { AD_TAGS, AdTag } from '../roblox/rolimons';
import {
  profileDashboard, inventoryView, historyEmbed, InventoryRow,
} from './profileDashboard';

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

async function buildAdPayload() {
  const [ads, cd] = await Promise.all([listAds(), cooldownRemainingMs()]);
  return adDashboard(ads, cd, Boolean(config.rolimons.token));
}

/** Shared inventory fetch used by the profile + inventory views. */
async function loadInventory(): Promise<InventoryRow[]> {
  await rolimons.refresh();
  const [inv, costMap] = await Promise.all([
    roblox.getCollectibleInventory().catch(() => []),
    getCostByItem(),
  ]);
  return inv.map(it => ({
    assetId: it.assetId,
    name: it.name,
    rap: it.rap,
    cost: costMap.has(it.assetId) ? costMap.get(it.assetId)! : null,
    meta: rolimons.get(it.assetId),
  }));
}

async function buildProfilePayload() {
  await rolimons.refresh();
  const [me, balance, inv] = await Promise.all([
    roblox.whoami().catch(() => ({ name: 'Account', id: 0 })),
    roblox.getBalance().catch(() => null),
    roblox.getCollectibleInventory().catch(() => []),
  ]);
  const totalRap = inv.reduce((s, it) => s + (it.rap || 0), 0);
  const estValue = inv.reduce((s, it) => {
    const m = rolimons.get(it.assetId);
    return s + (m && m.value > 0 ? m.value : it.rap || 0);
  }, 0);
  return profileDashboard({
    username: me.name, balance, totalRap, itemCount: inv.length, estValue,
  });
}

// ─── Slash commands ──────────────────────────────────────────────────────────
async function handleCommand(i: ChatInputCommandInteraction): Promise<void> {
  if (i.commandName === 'snipe') return void i.reply({ ...(await buildSnipePayload()), ephemeral: true });
  if (i.commandName === 'feed')  return void i.reply({ ...(await buildFeedPayload()), ephemeral: true });
  if (i.commandName === 'rolimons-ad') return void i.reply({ ...(await buildAdPayload()), ephemeral: true });
  if (i.commandName === 'profile') {
    await i.deferReply({ ephemeral: true });
    return void i.editReply(await buildProfilePayload());
  }
  if (i.commandName === 'history') {
    await i.deferReply({ ephemeral: true });
    return void i.editReply(historyEmbed(await getTradeHistory(25)));
  }
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

  // Sell management (dynamic customIds carrying a listing id)
  if (id === 's:sell:settings') return void i.showModal(sellSettingsModal(await getConfig()));
  if (id.startsWith('s:sell:reprice:') && !id.includes(':modal:')) {
    const listingId = id.slice('s:sell:reprice:'.length);
    const l = await getListing(listingId);
    if (!l) return void i.reply({ content: '⚠️ Listing not found.', ephemeral: true });
    return void i.showModal(repriceModal(listingId, l.itemName, l.listPrice ?? 0));
  }
  if (id.startsWith('s:sell:cancel:')) {
    const listingId = id.slice('s:sell:cancel:'.length);
    await i.deferReply({ ephemeral: true });
    const r = await cancelSale(listingId);
    return void i.editReply(r.detail);
  }

  // Rolimons ad dashboard
  if (id === 'r:add') return void i.showModal(adAddModal());
  if (id === 'r:refresh') return void i.update(await buildAdPayload());
  if (id.startsWith('r:post:')) {
    await i.deferReply({ ephemeral: true });
    const r = await postAd(id.slice('r:post:'.length));
    return void i.editReply(r.detail);
  }
  if (id.startsWith('r:auto:')) {
    const on = await toggleAdAuto(id.slice('r:auto:'.length));
    return void i.reply({ content: on ? '🔁 Auto re-advertise **enabled**.' : '⏸️ Auto re-advertise **disabled**.', ephemeral: true });
  }
  if (id.startsWith('r:rm:')) {
    await removeAd(id.slice('r:rm:'.length));
    return void i.reply({ content: '🗑️ Ad removed.', ephemeral: true });
  }

  // Profile dashboard
  if (id === 'p:refresh' || id === 'p:back') {
    await i.deferUpdate();
    return void i.editReply(await buildProfilePayload());
  }
  if (id === 'p:inventory' || id.startsWith('p:inv:')) {
    const page = id.startsWith('p:inv:') ? Number(id.slice('p:inv:'.length)) || 0 : 0;
    await i.deferUpdate();
    return void i.editReply(inventoryView(await loadInventory(), page));
  }
  if (id === 'p:history') {
    await i.deferUpdate();
    return void i.editReply(historyEmbed(await getTradeHistory(25)));
  }

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

  if (i.customId === 's:sell:settings:modal') {
    const margin = parseNum(i.fields.getTextInputValue('margin'));
    const unsold = parseNum(i.fields.getTextInputValue('unsold_hours'));
    if (margin !== undefined) await setConfig('sellDefaultMarginPct', clamp(margin, 0, 1000));
    if (unsold !== undefined) await setConfig('unsoldNotifyHours', Math.max(1, unsold));
    return void i.reply({ content: '✅ Sell settings saved.', ephemeral: true });
  }

  if (i.customId.startsWith('s:sell:reprice:modal:')) {
    const listingId = i.customId.slice('s:sell:reprice:modal:'.length);
    const price = parseNum(i.fields.getTextInputValue('price'));
    if (price === undefined || price < 1) return void i.reply({ content: '⚠️ Invalid price.', ephemeral: true });
    await i.deferReply({ ephemeral: true });
    const r = await repriceSale(listingId, price);
    return void i.editReply(r.detail);
  }

  if (i.customId.startsWith('s:sell:modal:')) {
    const listingId = i.customId.slice('s:sell:modal:'.length);
    const price = parseNum(i.fields.getTextInputValue('price'));
    if (price === undefined || price < 1) {
      return void i.reply({ content: '⚠️ Invalid price.', ephemeral: true });
    }
    await i.deferReply({ ephemeral: true });
    const result = await listSale(listingId, price);
    return void i.editReply(result.detail);
  }

  if (i.customId === 'r:add:modal') {
    const offerId = parseNum(i.fields.getTextInputValue('offer_id'));
    if (offerId === undefined) return void i.reply({ content: '⚠️ Invalid offer item ID.', ephemeral: true });

    const requestIds = (i.fields.getTextInputValue('request_ids') || '')
      .split(',').map(s => Number(s.trim())).filter(n => Number.isFinite(n) && n > 0).slice(0, 4);
    const validTags = new Set<string>(AD_TAGS as readonly string[]);
    const requestTags = (i.fields.getTextInputValue('request_tags') || '')
      .split(',').map(s => s.trim().toLowerCase()).filter(t => validTags.has(t)).slice(0, 4) as AdTag[];

    await rolimons.refresh();
    const name = rolimons.get(offerId)?.name ?? '';
    await upsertAd({ offerItemId: offerId, offerItemName: name, requestItemIds: requestIds, requestTags });
    return void i.reply({ content: `✅ Saved ad for **${name || offerId}** (request: ${requestIds.length} item(s), tags: ${requestTags.join(', ') || 'none'}).`, ephemeral: true });
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
  if (i.customId === 's:sell:manage') {
    const listing = await getListing(i.values[0]);
    if (!listing || listing.status !== 'listed') {
      return void i.reply({ content: '⚠️ That listing is no longer active.', ephemeral: true });
    }
    return void i.reply({ ...manageListingButtons(listing.id), ephemeral: true });
  }
  if (i.customId === 'r:pick') {
    const ad = await getAd(i.values[0]);
    if (!ad) return void i.reply({ content: '⚠️ Ad entry not found.', ephemeral: true });
    return void i.reply({ ...adActionButtons(ad), ephemeral: true });
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
