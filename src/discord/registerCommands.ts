// ─────────────────────────────────────────────────────────────────────────────
// COMMAND REGISTRATION — run with `npm run register`
//
// A PUT overwrites the entire command set in a scope, so the current commands
// (/snipe, /feed, /rolimons-ad) fully replace any older ones. To avoid stale
// leftovers, we register to the active scope AND clear the opposite scope:
//   - DEV_GUILD_ID set  → register to that guild, clear global
//   - DEV_GUILD_ID unset → register globally, clear that guild if known
// ─────────────────────────────────────────────────────────────────────────────
import { REST, Routes } from 'discord.js';
import { config } from '../config';
import { commands } from './commands';
import { log } from '../utils/logger';

async function main(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const body = commands.map(c => c.toJSON());
  const { clientId, devGuildId } = config.discord;

  if (devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body });
    log.info('REGISTER', `Registered ${body.length} commands to guild ${devGuildId}`);
    // Clear any old GLOBAL commands so they don't show up as duplicates.
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    log.info('REGISTER', 'Cleared global commands');
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    log.info('REGISTER', `Registered ${body.length} global commands`);
    // Clear any old DEV-GUILD commands if a guild id is provided for cleanup.
    const cleanupGuild = process.env.CLEANUP_GUILD_ID;
    if (cleanupGuild) {
      await rest.put(Routes.applicationGuildCommands(clientId, cleanupGuild), { body: [] });
      log.info('REGISTER', `Cleared commands in guild ${cleanupGuild}`);
    }
  }

  log.info('REGISTER', `Active commands: ${body.map(c => '/' + c.name).join(', ')}`);
}

main()
  .then(() => process.exit(0))
  .catch(e => {
    log.error('REGISTER', (e as Error).message);
    process.exit(1);
  });
