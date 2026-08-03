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
import { checkWatchedChannels, isMissingCommandScope } from '../photo/setupCheck.js';

const log = createLogger('photos');

/** Maps a discord.js message onto the plain object evaluateMessage expects. */
function toPlainMessage(message) {
  return {
    id: message.id,
    createdTimestamp: message.createdTimestamp,
    pinned: message.pinned ?? false,
    authorId: message.author?.id,
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
      .addRoleOption((option) =>
        option
          .setName('except_from')
          .setDescription('Never delete anything from members with this role (e.g. MOD)')
          .setRequired(false),
      )
      .addUserOption((option) =>
        option
          .setName('except_person')
          .setDescription('Never delete anything from this one person, whatever roles they have')
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName('only_from')
          .setDescription('Only delete messages from members with this role')
          .setRequired(false),
      )
      .addUserOption((option) =>
        option
          .setName('only_person')
          .setDescription('Only delete messages from this one person')
          .setRequired(false),
      )
      .toJSON(),
    new SlashCommandBuilder()
      .setName('photo-status')
      .setDescription('Show which channels this bot is watching and what it lets through')
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
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

    // Reaching this line proves the privileged intent is on: Discord refuses
    // the connection outright when a bot asks for Message Content without it.
    // Saying so beats leaving the owner to work it out — a bot that cannot read
    // text connects, reports the channel it is watching, and deletes nothing,
    // which looks exactly like a bot that is simply broken.
    log.info('Message Content is enabled — text in those channels will be read and removed');

    // Everything below also goes to Discord when a log channel is set. Reading
    // deploy logs on a phone is miserable, and the whole point of a diagnostic
    // is that it reaches whoever needs it.
    const report = [];
    const say = (level, line) => {
      log[level](line);
      report.push(line);
    };

    const guilds = [...ready.guilds.cache.values()];
    say(
      guilds.length === 0 ? 'error' : 'info',
      guilds.length === 0
        ? '❌ The bot is not in any server — the invite link was never opened, or it was removed'
        : `In ${guilds.length} server(s): ${guilds.map((guild) => guild.name).join(', ')}`,
    );

    if (config.channelIds.length === 0) {
      say('warn', '❌ PHOTO_ONLY_CHANNEL_IDS is empty: the bot is not watching any channel');
    } else {
      // Each id is resolved rather than counted. The old line counted entries in
      // an environment variable and said "Watching 1 channel(s)" for an id that
      // pointed at nothing.
      const checks = await checkWatchedChannels(client, config);
      for (const check of checks) say(check.ok ? 'info' : 'error', check.label);

      const live = checks.filter((check) => check.ok).length;
      if (live === 0) {
        say('error', '❌ No configured channel can actually be policed — nothing will be deleted');
      }
    }

    // Registered per guild rather than globally: guild commands appear at once,
    // global ones can take an hour, and nobody waits an hour to tidy a channel.
    for (const guild of guilds) {
      try {
        await guild.commands.set(buildPhotoCommands());
        say('info', `✅ /photo-clean and /photo-status registered in ${guild.name}`);
      } catch (error) {
        say(
          'error',
          isMissingCommandScope(error)
            ? `❌ Discord refused the commands in ${guild.name}: the bot was invited without the ` +
              '**applications.commands** scope. Re-invite it with that scope — nothing in the code can fix this.'
            : `❌ Could not register /photo-clean in ${guild.name}: ${error.message}`,
        );
      }
    }

    if (config.logChannelId) {
      const channel = await client.channels.fetch(config.logChannelId).catch(() => null);
      if (channel?.isTextBased()) {
        await channel
          .send({
            embeds: [
              new EmbedBuilder()
                .setColor(report.some((line) => line.startsWith('❌')) ? COLORS.danger : COLORS.success)
                .setTitle('📸 Photos bot — setup check')
                .setDescription(report.join('\n'))
                .setTimestamp(),
            ],
          })
          .catch(() => null);
      }
    } else {
      log.warn(
        'PHOTO_ONLY_LOG_CHANNEL_ID is not set, so this check only appears in the deploy logs',
      );
    }
  });

  // Whether messages are arriving at all is the one thing the startup check
  // cannot answer, and it is the difference between "the bot is misconfigured"
  // and "the bot never hears about that channel". Reported once per channel so
  // it settles the question without narrating every photo forever.
  const firstSeen = new Set();

  client.on(Events.MessageCreate, async (message) => {
    try {
      if (!config.channelIds.includes(message.channelId)) {
        // A message in the wrong place is worth one line, once: a thread inside
        // the watched channel has its own id, and that is a very easy mistake.
        if (!firstSeen.has('elsewhere')) {
          firstSeen.add('elsewhere');
          log.info(
            `Seeing messages in #${message.channelId}, which is not in PHOTO_ONLY_CHANNEL_IDS ` +
              `(watching: ${config.channelIds.join(', ') || 'nothing'})`,
          );
        }
        return;
      }

      if (!firstSeen.has(message.channelId)) {
        firstSeen.add(message.channelId);
        const readable = (message.content ?? '').length > 0;
        log.info(
          `First message seen in the watched channel — text is ${readable ? 'readable' : 'EMPTY, which means Message Content is off'}`,
        );
      }

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
    if (!interaction.isChatInputCommand()) return;

    // "It is not deleting" and "it is not watching this channel" look identical
    // from inside Discord. This answers it there, without anybody reading a
    // deploy log on a phone.
    if (interaction.commandName === 'photo-status') {
      const checks = await checkWatchedChannels(client, config);
      const rules = [
        `Photos: **always allowed**`,
        `Caption next to a photo: **${config.allowCaptions ? 'allowed' : 'deleted'}**`,
        `Text with no photo: **deleted**`,
        `Videos: **${config.allowVideos ? 'allowed' : 'deleted'}**`,
        `Image links with no upload: **${config.allowLinks ? 'allowed' : 'deleted'}**`,
        `Other bots: **${config.ignoreBots ? 'left alone' : 'policed too'}**`,
      ];
      const exempt = [
        ...config.bypassRoleIds.map((id) => `<@&${id}>`),
        ...config.bypassUserIds.map((id) => `<@${id}>`),
      ];

      await interaction.reply({
        flags: MessageFlags.Ephemeral,
        embeds: [
          new EmbedBuilder()
            .setColor(checks.some((check) => check.ok) ? COLORS.success : COLORS.danger)
            .setTitle('📸 Photos bot — status')
            .setDescription(
              checks.length === 0
                ? '❌ No channel is configured, so nothing is being watched.'
                : checks.map((check) => check.label).join('\n'),
            )
            .addFields(
              { name: 'Rules', value: rules.join('\n') },
              {
                name: 'May post anything',
                value: exempt.length > 0 ? exempt.join(', ') : 'Nobody — the rules apply to everyone',
              },
            )
            .setTimestamp(),
        ],
      });
      return;
    }

    if (interaction.commandName !== 'photo-clean') return;

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

      const exceptRole = interaction.options.getRole('except_from');
      const onlyRole = interaction.options.getRole('only_from');
      const exceptUser = interaction.options.getUser('except_person');
      const onlyUser = interaction.options.getUser('only_person');

      const messages = await fetchAllMessages(channel);
      const plan = planCleanup(messages.map(toPlainMessage), config, {
        keepPinned,
        exceptRoleIds: exceptRole ? [exceptRole.id] : [],
        onlyRoleIds: onlyRole ? [onlyRole.id] : [],
        exceptUserIds: exceptUser ? [exceptUser.id] : [],
        onlyUserIds: onlyUser ? [onlyUser.id] : [],
      });

      const scope = [
        exceptRole ? `never touching **@${exceptRole.name}**` : '',
        exceptUser ? `never touching <@${exceptUser.id}>` : '',
        onlyRole ? `only members with **@${onlyRole.name}**` : '',
        onlyUser ? `only messages from <@${onlyUser.id}>` : '',
      ].filter(Boolean);

      // Deleting a channel's history cannot be undone, and the count is the
      // only chance anyone gets to notice it is wrong. Preview unless told.
      if (!confirm) {
        await interaction.editReply(
          [
            `**Preview — nothing has been deleted.**`,
            `Scanned **${messages.length}** message(s) in ${channel}${scope.length > 0 ? `, ${scope.join(' and ')}` : ''}.`,
            `Would delete **${plan.remove.length}** and keep **${plan.keep.length}**.`,
            plan.skipped > 0 ? `_${plan.skipped} left alone by the filters._` : '',
            plan.old.length > 0
              ? `_${plan.old.length} are over 14 days old and have to go one by one, which is slower._`
              : '',
            '',
            `Run the same command again with \`confirm:True\` to do it. **This cannot be undone.**`,
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
          `**Done.** Deleted **${deleted}** message(s) from ${channel}, kept **${plan.keep.length}**.`,
          plan.skipped > 0 ? `**${plan.skipped}** were left alone by the filters.` : '',
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
