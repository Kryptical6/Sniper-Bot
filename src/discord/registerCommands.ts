// ─────────────────────────────────────────────────────────────────────────────
// COMMAND REGISTRATION — run with `npm run register`
//
// Registers to a dev guild instantly if DEV_GUILD_ID is set, otherwise globally
// (can take up to an hour to propagate).
// ─────────────────────────────────────────────────────────────────────────────
import { REST, Routes } from 'discord.js';
import { config } from '../config';
import { commands } from './commands';
import { log } from '../utils/logger';

async function main(): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(config.discord.token);
  const body = commands.map(c => c.toJSON());

  if (config.discord.devGuildId) {
    await rest.put(
      Routes.applicationGuildCommands(config.discord.clientId, config.discord.devGuildId),
      { body }
    );
    log.info('REGISTER', `Registered ${body.length} commands to guild ${config.discord.devGuildId}`);
  } else {
    await rest.put(Routes.applicationCommands(config.discord.clientId), { body });
    log.info('REGISTER', `Registered ${body.length} global commands`);
  }
}

main().catch(e => {
  log.error('REGISTER', (e as Error).message);
  process.exit(1);
});
