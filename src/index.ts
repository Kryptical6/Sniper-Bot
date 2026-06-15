// ─────────────────────────────────────────────────────────────────────────────
// ENTRYPOINT — wires everything together
// ─────────────────────────────────────────────────────────────────────────────
import { Client, GatewayIntentBits, Partials, ActivityType } from 'discord.js';
import { config } from './config';
import { log } from './utils/logger';
import { initDb } from './db';
import { roblox } from './roblox/client';
import { rolimons } from './roblox/rolimons';
import { bindClient } from './discord/notify';
import { handleInteraction } from './discord/interactionRouter';
import { startSnipeEngine } from './services/snipeEngine';
import { startFeedService } from './services/feedService';
import { startRecommendAlerts } from './services/recommendService';
import { startSellWatcher } from './services/sellService';
import { startAdRotation } from './services/adService';
import { startDailyApprovalScheduler } from './scheduler/dailyApproval';

async function main(): Promise<void> {
  log.info('BOOT', 'Starting RBX Sniper Bot…');

  await initDb();

  // Validate the Roblox cookie early — fail loud if it's bad.
  try {
    const me = await roblox.whoami();
    log.info('ROBLOX', `Authenticated as ${me.name} (${me.id})`);
  } catch (e) {
    log.error('ROBLOX', `Cookie validation failed: ${(e as Error).message}`);
    log.error('ROBLOX', 'Auto-buy will fail until ROBLOSECURITY is fixed.');
  }

  await rolimons.refresh(true);
  log.info('ROLIMONS', `Loaded ${rolimons.size} limiteds`);

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages],
    partials: [Partials.Channel], // required to receive DM interactions
  });

  bindClient(client);

  client.once('ready', () => {
    log.info('DISCORD', `Logged in as ${client.user?.tag}`);
    client.user?.setActivity('the limited market', { type: ActivityType.Watching });

    // Start background services once the gateway is live.
    startSnipeEngine();
    startFeedService();
    startRecommendAlerts();
    startSellWatcher();
    startAdRotation();
    startDailyApprovalScheduler();
  });

  client.on('interactionCreate', i => void handleInteraction(i));

  try {
    await client.login(config.discord.token);
  } catch (e) {
    const msg = (e as Error).message;
    if (/invalid.*authorization|token/i.test(msg)) {
      log.error('BOOT', 'DISCORD_TOKEN is invalid. Reset it in the Developer Portal');
      log.error('BOOT', '(App → Bot → Reset Token) and paste the new value into .env.');
    } else {
      log.error('BOOT', `Discord login failed: ${msg}`);
    }
    // Stay alive but idle so ts-node-dev does NOT respawn and hammer the APIs.
    log.error('BOOT', 'Halting. Fix the token, then restart.');
    return;
  }
}

main().catch(e => {
  log.error('BOOT', (e as Error).message);
  // Do not process.exit — that triggers --respawn and a tight crash loop.
});

// Keep the process resilient — log and survive unexpected errors.
process.on('unhandledRejection', r => log.error('PROCESS', `Unhandled rejection: ${r}`));
process.on('uncaughtException', e => log.error('PROCESS', `Uncaught: ${(e as Error).message}`));
