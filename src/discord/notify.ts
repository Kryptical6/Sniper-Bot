// ─────────────────────────────────────────────────────────────────────────────
// NOTIFY — owner DM + feed channel helpers shared across services
// ─────────────────────────────────────────────────────────────────────────────
import { Client, TextChannel, Message, MessagePayload, MessageCreateOptions } from 'discord.js';
import { config } from '../config';
import { log } from '../utils/logger';

let client: Client;

export function bindClient(c: Client): void {
  client = c;
}

/** Sends a DM to the owner. Returns the Message (for collectors) or null. */
export async function dmOwner(
  payload: string | MessagePayload | MessageCreateOptions
): Promise<Message | null> {
  try {
    const user = await client.users.fetch(config.discord.ownerId);
    return await user.send(payload as any);
  } catch (e) {
    log.error('NOTIFY', `Failed to DM owner: ${(e as Error).message}`);
    return null;
  }
}

export async function postToFeed(
  channelId: string,
  payload: string | MessagePayload | MessageCreateOptions
): Promise<Message | null> {
  try {
    const ch = await client.channels.fetch(channelId);
    if (ch && ch.isTextBased()) {
      return await (ch as TextChannel).send(payload as any);
    }
  } catch (e) {
    log.error('NOTIFY', `Failed to post to feed: ${(e as Error).message}`);
  }
  return null;
}

export function getClient(): Client {
  return client;
}
