import { Client, EmbedBuilder, Events, GatewayIntentBits, MessageType, Partials } from 'discord.js';
import { loadPhotoConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { REASON_MESSAGES, evaluateMessage } from '../photo/photoOnly.js';

const log = createLogger('photos');

/** Maps a discord.js message onto the plain object evaluateMessage expects. */
function toPlainMessage(message) {
  return {
    authorIsBot: message.author?.bot ?? false,
    content: message.content ?? '',
    attachments: [...message.attachments.values()].map((attachment) => ({
      contentType: attachment.contentType,
      name: attachment.name,
    })),
    embeds: message.embeds,
    memberRoleIds: message.member ? [...message.member.roles.cache.keys()] : [],
    isSystem: message.type !== MessageType.Default && message.type !== MessageType.Reply,
  };
}

export function createPhotoBot(config = loadPhotoConfig()) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      // Needed to read the message text: turn on "Message Content Intent"
      // in the Discord developer portal.
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  client.once(Events.ClientReady, (ready) => {
    log.info(`Logged in as ${ready.user.tag}`);
    if (config.channelIds.length === 0) {
      log.warn('PHOTO_ONLY_CHANNEL_IDS is empty: the bot is not watching any channel');
    } else {
      log.info(`Watching ${config.channelIds.length} photos-only channel(s)`);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!config.channelIds.includes(message.channelId)) return;
      if (message.author?.id === client.user.id) return;

      const verdict = evaluateMessage(toPlainMessage(message), config);
      if (verdict.allowed) return;

      await message.delete();
      log.info(`Deleted a message from ${message.author?.tag ?? 'unknown'} in #${message.channelId} (${verdict.reason})`);

      if (config.warn) {
        const text = `${message.author ? `<@${message.author.id}> ` : ''}${REASON_MESSAGES[verdict.reason] ?? REASON_MESSAGES.no_image}`;
        const notice = await message.channel.send({ content: text });
        if (config.warnSeconds > 0) {
          setTimeout(() => {
            notice.delete().catch(() => {});
          }, config.warnSeconds * 1000);
        }
      }

      if (config.logChannelId) {
        const channel = await client.channels.fetch(config.logChannelId).catch(() => null);
        if (channel?.isTextBased()) {
          await channel.send({
            embeds: [
              new EmbedBuilder()
                .setColor(0xe67e22)
                .setTitle('Message deleted in photos-only channel')
                .addFields(
                  { name: 'Author', value: `<@${message.author?.id}>`, inline: true },
                  { name: 'Channel', value: `<#${message.channelId}>`, inline: true },
                  { name: 'Reason', value: verdict.reason, inline: true },
                  { name: 'Content', value: (message.content || '(no text)').slice(0, 1000) },
                )
                .setTimestamp(),
            ],
          });
        }
      }
    } catch (error) {
      log.error(`Error handling message ${message.id}: ${error.message}`);
    }
  });

  // Someone can post a valid photo and then edit text into it.
  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    try {
      if (!config.channelIds.includes(newMessage.channelId)) return;
      const message = newMessage.partial ? await newMessage.fetch() : newMessage;
      if (message.author?.id === client.user.id) return;

      const verdict = evaluateMessage(toPlainMessage(message), config);
      if (!verdict.allowed) {
        await message.delete();
        log.info(`Deleted an edited message in #${message.channelId} (${verdict.reason})`);
      }
    } catch (error) {
      log.debug(`Could not check the edit: ${error.message}`);
    }
  });

  return client;
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  const config = loadPhotoConfig();
  const client = createPhotoBot(config);
  client.login(config.token);
}
