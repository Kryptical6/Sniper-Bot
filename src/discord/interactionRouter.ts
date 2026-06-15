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
  getCostByUserAsset, getTradeHistory, recordHolding,
  addAlert, listAlerts, removeAlert,
  updateAttemptOutcome,
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
import {
  profileDashboard, inventoryView, historyEmbed, InventoryRow, costBasisModal,
} from './profileDashboard';
import { analyzeItem, evaluateTrade } from '../services/analysis';
import { searchEmbed, noMatchEmbed, tradeEmbed, SearchMatch } from './searchDashboard';
import { alertDashboard, alertAddModal } from './alertDashboard';
import { RoliItem } from '../types';

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

/** Shared inventory fetch used by the profile + inventory views. */
async function loadInventory(): Promise<InventoryRow[]> {
  await rolimons.refresh();
  const [inv, dbCosts, txnCosts] = await Promise.all([
    roblox.getCollectibleInventory().catch(() => []),
    getCostByUserAsset(),                         // what the bot recorded buying, per copy
    roblox.getPurchaseCostMap().catch(() => new Map<number, number>()), // Roblox txn history
  ]);
  return inv.map(it => {
    // Prefer the bot's own record; fall back to Roblox purchase history.
    const cost = dbCosts.get(it.userAssetId) ?? txnCosts.get(it.assetId) ?? null;
    return {
      assetId: it.assetId,
      userAssetId: it.userAssetId,
      name: it.name,
      rap: it.rap,
      cost,
      meta: rolimons.get(it.assetId),
    };
  });
}

/** Analyses one item id and renders the search embed (with optional matches). */
async function buildItemAnalysis(itemId: number, matches: SearchMatch[] = []) {
  await rolimons.refresh();
  const meta = rolimons.get(itemId);
  const [detail, resellers] = await Promise.all([
    roblox.getResaleDetail(itemId).catch(() => null),
    roblox.getResellers(itemId, 1).catch(() => []),
  ]);
  const rap = detail?.rap ?? meta?.rap ?? 0;
  const name = meta?.name ?? `Item ${itemId}`;
  const analysis = analyzeItem({
    meta,
    rap,
    lowestPrice: resellers[0]?.price ?? null,
    recentPrices: detail?.recentPrices ?? [],
  });
  return searchEmbed(name, itemId, analysis, matches);
}

/** Resolves a comma-separated list of ids/names to RoliMons items. */
async function resolveItemList(raw: string): Promise<{ items: RoliItem[]; unresolved: string[] }> {
  await rolimons.refresh();
  const items: RoliItem[] = [];
  const unresolved: string[] = [];
  for (const tokenRaw of raw.split(',')) {
    const token = tokenRaw.trim();
    if (!token) continue;
    let item: RoliItem | undefined;
    if (/^\d+$/.test(token)) {
      item = rolimons.get(Number(token));
    } else {
      const q = token.toLowerCase();
      item = rolimons.all()
        .filter(i => i.name.toLowerCase().includes(q) || i.acronym.toLowerCase() === q)
        .sort((a, b) => b.rap - a.rap)[0];
    }
    if (item) items.push(item); else unresolved.push(token);
  }
  return { items, unresolved };
}

/** Resolves a free-text query to an item id (+ alternative matches). */
async function resolveQuery(query: string): Promise<{ id: number | null; matches: SearchMatch[] }> {
  await rolimons.refresh();
  const trimmed = query.trim();
  if (/^\d+$/.test(trimmed)) return { id: Number(trimmed), matches: [] };

  const q = trimmed.toLowerCase();
  const hits = rolimons.all()
    .filter(i => i.name.toLowerCase().includes(q) || i.acronym.toLowerCase() === q)
    .sort((a, b) => b.rap - a.rap)
    .slice(0, 25)
    .map(i => ({ id: i.id, name: i.name, rap: i.rap }));
  return { id: hits[0]?.id ?? null, matches: hits };
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
  if (i.commandName === 'profile') {
    await i.deferReply({ ephemeral: true });
    return void i.editReply(await buildProfilePayload());
  }
  if (i.commandName === 'history') {
    await i.deferReply({ ephemeral: true });
    return void i.editReply(historyEmbed(await getTradeHistory(25)));
  }
  if (i.commandName === 'search') {
    await i.deferReply({ ephemeral: true });
    const query = i.options.getString('query', true);
    const { id, matches } = await resolveQuery(query);
    if (id == null) return void i.editReply(noMatchEmbed(query));
    return void i.editReply(await buildItemAnalysis(id, matches));
  }
  if (i.commandName === 'trade') {
    await i.deferReply({ ephemeral: true });
    const give = await resolveItemList(i.options.getString('give', true));
    const receive = await resolveItemList(i.options.getString('receive', true));
    if (give.items.length === 0 && receive.items.length === 0) {
      return void i.editReply(noMatchEmbed('those items'));
    }
    const verdict = evaluateTrade(give.items, receive.items);
    return void i.editReply(tradeEmbed(verdict, [...give.unresolved, ...receive.unresolved]));
  }
  if (i.commandName === 'alert') {
    return void i.reply({ ...alertDashboard(await listAlerts()), ephemeral: true });
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

  // Price alerts
  if (id === 'a:add') return void i.showModal(alertAddModal());
  if (id === 'a:refresh') return void i.update(alertDashboard(await listAlerts()));

  // Profile dashboard
  if (id === 'p:refresh' || id === 'p:back') {
    await i.deferUpdate();
    return void i.editReply(await buildProfilePayload());
  }
  if (id === 'p:inventory' || id.startsWith('p:inv:')) {
    const page = id.startsWith('p:inv:') ? Number(id.slice('p:inv:'.length)) || 0 : 0;
    await i.deferUpdate();
    const [inv, cfg] = await Promise.all([loadInventory(), getConfig()]);
    return void i.editReply(inventoryView(inv, page, cfg.sellDefaultMarginPct));
  }
  if (id.startsWith('p:cost:')) {
    const [, , pageStr, assetIdStr, userAssetIdStr] = id.split(':');
    const assetId = Number(assetIdStr);
    const userAssetId = Number(userAssetIdStr);
    const inv = await loadInventory();
    const item = inv.find(r => r.userAssetId === userAssetId);
    return void i.showModal(costBasisModal(Number(pageStr) || 0, assetId, userAssetId, item?.name ?? `Item ${assetId}`));
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
    if (candidate?.attemptId) await updateAttemptOutcome(candidate.attemptId, 'skipped', 'Owner skipped prompt');
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

  if (i.customId === 'a:add:modal') {
    const itemId = parseNum(i.fields.getTextInputValue('item_id'));
    const dir = i.fields.getTextInputValue('direction').trim().toLowerCase();
    const price = parseNum(i.fields.getTextInputValue('price'));
    if (itemId === undefined) return void i.reply({ content: '⚠️ Invalid item ID.', ephemeral: true });
    if (dir !== 'buy' && dir !== 'sell') return void i.reply({ content: '⚠️ Direction must be `buy` or `sell`.', ephemeral: true });
    if (price === undefined || price < 1) return void i.reply({ content: '⚠️ Invalid target price.', ephemeral: true });
    await rolimons.refresh();
    const name = rolimons.get(itemId)?.name ?? '';
    await addAlert({ itemId, itemName: name, direction: dir, targetPrice: price });
    return refreshFromModal(i, alertDashboard(await listAlerts()));
  }

  if (i.customId.startsWith('p:cost:modal:')) {
    const [, , , pageStr, assetIdStr, userAssetIdStr] = i.customId.split(':');
    const page = Number(pageStr) || 0;
    const assetId = Number(assetIdStr);
    const userAssetId = Number(userAssetIdStr);
    const price = parseNum(i.fields.getTextInputValue('price'));
    if (price === undefined || price < 1) {
      return void i.reply({ content: '⚠️ Invalid bought price.', ephemeral: true });
    }

    const inv = await roblox.getCollectibleInventory().catch(() => []);
    const item = inv.find(r => r.userAssetId === userAssetId && r.assetId === assetId);
    if (!item) {
      return void i.reply({ content: '⚠️ Could not find that copy in the current inventory.', ephemeral: true });
    }

    await recordHolding({
      itemId: item.assetId,
      itemName: item.name,
      userAssetId: item.userAssetId,
      costRobux: price,
    });
    const [rows, cfg] = await Promise.all([loadInventory(), getConfig()]);
    return refreshFromModal(i, inventoryView(rows, page, cfg.sellDefaultMarginPct));
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
  if (i.customId === 'q:pick') {
    await i.deferUpdate();
    return void i.editReply(await buildItemAnalysis(Number(i.values[0])));
  }
  if (i.customId === 'a:remove') {
    await removeAlert(i.values[0]);
    return void i.update(alertDashboard(await listAlerts()));
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
