import { Client, EmbedBuilder, Events, GatewayIntentBits, MessageType, Partials } from 'discord.js';
import { loadPhotoConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { REASON_MESSAGES, evaluateMessage } from '../photo/photoOnly.js';

const log = createLogger('fotos');

export function createPhotoBot(config = loadPhotoConfig()) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      // Necesario para leer el texto del mensaje: activa "Message Content Intent"
      // en el portal de desarrolladores de Discord.
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Message, Partials.Channel],
  });

  client.once(Events.ClientReady, (ready) => {
    log.info(`Conectado como ${ready.user.tag}`);
    if (config.channelIds.length === 0) {
      log.warn('PHOTO_ONLY_CHANNEL_IDS esta vacio: el bot no vigilara ningun canal');
    } else {
      log.info(`Vigilando ${config.channelIds.length} canal(es) de solo-fotos`);
    }
  });

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!config.channelIds.includes(message.channelId)) return;
      if (message.author?.id === client.user.id) return;

      const verdict = evaluateMessage(
        {
          authorIsBot: message.author?.bot ?? false,
          content: message.content ?? '',
          attachments: [...message.attachments.values()].map((attachment) => ({
            contentType: attachment.contentType,
            name: attachment.name,
          })),
          embeds: message.embeds,
          memberRoleIds: message.member ? [...message.member.roles.cache.keys()] : [],
          isSystem: message.type !== MessageType.Default && message.type !== MessageType.Reply,
        },
        config,
      );

      if (verdict.allowed) return;

      await message.delete();
      log.info(`Mensaje de ${message.author?.tag ?? 'desconocido'} borrado en #${message.channelId} (${verdict.reason})`);

      if (config.warn) {
        const text = `${message.author ? `<@${message.author.id}> ` : ''}${REASON_MESSAGES[verdict.reason] ?? REASON_MESSAGES.sin_imagen}`;
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
                .setTitle('Mensaje borrado en canal solo-fotos')
                .addFields(
                  { name: 'Autor', value: `<@${message.author?.id}>`, inline: true },
                  { name: 'Canal', value: `<#${message.channelId}>`, inline: true },
                  { name: 'Motivo', value: verdict.reason, inline: true },
                  {
                    name: 'Contenido',
                    value: (message.content || '(sin texto)').slice(0, 1000),
                  },
                )
                .setTimestamp(),
            ],
          });
        }
      }
    } catch (error) {
      log.error(`Error procesando el mensaje ${message.id}: ${error.message}`);
    }
  });

  // Alguien puede editar un mensaje valido y meterle texto despues.
  client.on(Events.MessageUpdate, async (_oldMessage, newMessage) => {
    try {
      if (!config.channelIds.includes(newMessage.channelId)) return;
      const message = newMessage.partial ? await newMessage.fetch() : newMessage;
      if (message.author?.id === client.user.id) return;

      const verdict = evaluateMessage(
        {
          authorIsBot: message.author?.bot ?? false,
          content: message.content ?? '',
          attachments: [...message.attachments.values()].map((attachment) => ({
            contentType: attachment.contentType,
            name: attachment.name,
          })),
          embeds: message.embeds,
          memberRoleIds: message.member ? [...message.member.roles.cache.keys()] : [],
          isSystem: message.type !== MessageType.Default && message.type !== MessageType.Reply,
        },
        config,
      );

      if (!verdict.allowed) {
        await message.delete();
        log.info(`Mensaje editado borrado en #${message.channelId} (${verdict.reason})`);
      }
    } catch (error) {
      log.debug(`No se pudo revisar la edicion: ${error.message}`);
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
