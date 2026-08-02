import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  MessageType,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { loadPhotoConfig } from '../config.js';
import { COLORS } from '../lib/brand.js';
import { createLogger } from '../lib/logger.js';
import { REASON_MESSAGES, evaluateMessage } from '../photo/photoOnly.js';
import { planCleanup } from '../photo/cleanup.js';

const log = createLogger('photos');

/** Maps a discord.js message onto the plain object evaluateMessage expects. */
function toPlainMessage(message) {
  return {
    id: message.id,
    createdTimestamp: message.createdTimestamp,
    pinned: message.pinned ?? false,
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

export function buildPhotoCommands() {
  return [
    new SlashCommandBuilder()
      .setName('photo-clean')
      .setDescription('Delete every non-photo message already in a photos-only channel')
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .addChannelOption((option) =>
        option
          .setName('channel')
          .setDescription('Channel to clean (defaults to this one)')
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('confirm')
          .setDescription('Actually delete. Without this you only get a preview')
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName('keep_pinned')
          .setDescription('Keep pinned messages even if they are text (default: yes)')
          .setRequired(false),
      )
      .toJSON(),
  ];
}

/** Walks a channel's whole history, newest first. */
async function fetchAllMessages(channel, { max = 5000 } = {}) {
  const all = [];
  let before;

  while (all.length < max) {
    const batch = await channel.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
    if (batch.size === 0) break;
    all.push(...batch.values());
    before = batch.last().id;
    if (batch.size < 100) break;
  }

  return all;
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

  client.once(Events.ClientReady, async (ready) => {
    log.info(`Logged in as ${ready.user.tag}`);
    if (config.channelIds.length === 0) {
      log.warn('PHOTO_ONLY_CHANNEL_IDS is empty: the bot is not watching any channel');
    } else {
      log.info(`Watching ${config.channelIds.length} photos-only channel(s)`);
    }

    // Registered per guild rather than globally: guild commands appear at once,
    // global ones can take an hour, and nobody waits an hour to tidy a channel.
    for (const guild of ready.guilds.cache.values()) {
      await guild.commands.set(buildPhotoCommands()).catch((error) => {
        log.error(`Could not register /photo-clean in ${guild.id}: ${error.message}`);
      });
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
                .setColor(COLORS.warning)
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

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand() || interaction.commandName !== 'photo-clean') return;

    try {
      const channel = interaction.options.getChannel('channel') ?? interaction.channel;
      const confirm = interaction.options.getBoolean('confirm') ?? false;
      const keepPinned = interaction.options.getBoolean('keep_pinned') ?? true;

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      if (!channel?.isTextBased?.()) {
        await interaction.editReply('Pick a text channel.');
        return;
      }

      const me = interaction.guild?.members?.me;
      const missing = ['ViewChannel', 'ReadMessageHistory', 'ManageMessages'].filter(
        (permission) => !channel.permissionsFor(me)?.has(PermissionFlagsBits[permission]),
      );
      if (missing.length > 0) {
        await interaction.editReply(
          `I cannot clean ${channel}. Missing: **${missing.join('**, **')}**. ` +
            `Add them in ${channel.name} → Edit Channel → Permissions.`,
        );
        return;
      }

      const messages = await fetchAllMessages(channel);
      const plan = planCleanup(messages.map(toPlainMessage), config, { keepPinned });

      // Deleting a channel's history cannot be undone, and the count is the
      // only chance anyone gets to notice it is wrong. Preview unless told.
      if (!confirm) {
        await interaction.editReply(
          [
            `**Preview — nothing has been deleted.**`,
            `Scanned **${messages.length}** message(s) in ${channel}.`,
            `Would delete **${plan.remove.length}** and keep **${plan.keep.length}** photo(s).`,
            plan.old.length > 0
              ? `_${plan.old.length} are over 14 days old and have to go one by one, which is slower._`
              : '',
            '',
            `Run \`/photo-clean channel:#${channel.name} confirm:True\` to do it. **This cannot be undone.**`,
          ]
            .filter(Boolean)
            .join('\n'),
        );
        return;
      }

      const byId = new Map(messages.map((message) => [message.id, message]));
      let deleted = 0;
      let failed = 0;

      // Recent messages go in batches of 100; Discord refuses to bulk-delete
      // anything older, so the rest are removed individually.
      for (let i = 0; i < plan.recent.length; i += 100) {
        const batch = plan.recent.slice(i, i + 100).map((message) => message.id);
        try {
          const done = await channel.bulkDelete(batch, true);
          deleted += done.size;
        } catch (error) {
          failed += batch.length;
          log.warn(`Bulk delete failed: ${error.message}`);
        }
      }

      for (const message of plan.old) {
        try {
          await byId.get(message.id)?.delete();
          deleted += 1;
          // Deleting one at a time is rate limited; pacing beats being cut off
          // halfway through with no idea how far it got.
          await new Promise((resolve) => setTimeout(resolve, 1100));
        } catch (error) {
          failed += 1;
          log.debug(`Could not delete ${message.id}: ${error.message}`);
        }
      }

      log.info(`Cleaned #${channel.id}: ${deleted} deleted, ${plan.keep.length} kept`);
      await interaction.editReply(
        [
          `**Done.** Deleted **${deleted}** message(s) from ${channel}, kept **${plan.keep.length}** photo(s).`,
          failed > 0 ? `**${failed}** could not be deleted — usually too old or already gone.` : '',
        ]
          .filter(Boolean)
          .join('\n'),
      );
    } catch (error) {
      log.error(`photo-clean failed: ${error.stack ?? error.message}`);
      const payload = { content: `Cleanup failed: ${error.message}` };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
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
