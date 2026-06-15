// ─────────────────────────────────────────────────────────────────────────────
// COMMAND REGISTRATION
//
// syncCommands() is called automatically on bot startup (so every deploy
// refreshes the command set), and can also be run standalone via
// `npm run register`.
//
// A PUT overwrites the entire command set in a scope, so the current commands
// fully replace any older ones. To avoid stale leftovers we register to the
// active scope and clear the opposite:
//   - DEV_GUILD_ID set  → register to that guild, clear global
//   - DEV_GUILD_ID unset → register globally, clear CLEANUP_GUILD_ID if given
// ─────────────────────────────────────────────────────────────────────────────
import { REST, Routes } from 'discord.js';
import { config } from '../config';
import { commands } from './commands';
import { log } from '../utils/logger';

export async function syncCommands(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const body = commands.map(c => c.toJSON());
  const { clientId, devGuildId } = config.discord;

  if (devGuildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, devGuildId), { body });
    log.info('REGISTER', `Registered ${body.length} commands to guild ${devGuildId}`);
    await rest.put(Routes.applicationCommands(clientId), { body: [] });
    log.info('REGISTER', 'Cleared global commands');
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body });
    log.info('REGISTER', `Registered ${body.length} global commands`);
    const cleanupGuild = process.env.CLEANUP_GUILD_ID;
    if (cleanupGuild) {
      await rest.put(Routes.applicationGuildCommands(clientId, cleanupGuild), { body: [] });
      log.info('REGISTER', `Cleared commands in guild ${cleanupGuild}`);
    }
  }

  log.info('REGISTER', `Active commands: ${body.map(c => '/' + c.name).join(', ')}`);
}

// Allow running standalone: `npm run register`.
if (require.main === module) {
  syncCommands()
    .then(() => process.exit(0))
    .catch(e => {
      log.error('REGISTER', (e as Error).message);
      process.exit(1);
    });
}
