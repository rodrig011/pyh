import {
  ChannelType,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  Partials,
  REST,
  Routes,
} from 'discord.js';
import { loadVipConfig } from '../config.js';
import { COLORS } from '../lib/brand.js';
import { sendLog } from '../vip/notify.js';
import { createLogger } from '../lib/logger.js';
import { createStore } from '../lib/store.js';
import { ZelleWatcher } from '../payments/zelleWatcher.js';
import { createStripeClient, interpretStripeEvent } from '../payments/stripe.js';
import { startStripeWebhookServer } from '../payments/stripeWebhook.js';
import { applyStripeIntent } from '../vip/stripeFlow.js';
import { buildCommands, handleInteraction } from '../vip/commands.js';
import { expireStaleOrders } from '../vip/orders.js';
import { processPayment } from '../vip/paymentFlow.js';
import { sweepSubscriptions } from '../vip/subscriptionSweeper.js';
import { checkRoleSetup, grantTierRoles } from '../vip/roles.js';
import { storefrontMessage } from '../vip/storefront.js';
import { shouldGreetDm } from '../vip/dmGreeting.js';
import { promptDueSettlements, publishVoteResults, syncKalshiAccount } from '../picks/commands.js';

const log = createLogger('vip');

export async function registerCommands(config) {
  const rest = new REST({ version: '10' }).setToken(config.token);
  await rest.put(Routes.applicationGuildCommands(config.clientId, config.guildId), {
    body: buildCommands(config),
  });
  log.info('Slash commands registered in the guild');
}

export function createVipBot(config = loadVipConfig()) {
  const store = createStore(config.storePath);
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMembers,
      // Needed to notice a DM at all. Not privileged, and the message text is
      // never read — only that somebody wrote — so Message Content stays off.
      GatewayIntentBits.DirectMessages,
    ],
    // A DM channel arrives uncached, so without this the event never fires.
    partials: [Partials.Channel, Partials.Message],
  });

  // Card payments are optional: with no Stripe key the bot is Zelle-only.
  let stripe = createStripeClient(config);
  let webhookServer = null;

  if (stripe && !config.stripe.webhookSecret) {
    // Without the signing secret nothing can confirm a card payment, so the
    // checkout would take money and never grant the roles. Better no button.
    log.error(
      'STRIPE_WEBHOOK_SECRET is missing, so card payments stay OFF: a checkout nobody can verify would charge people without giving them access. Set it and redeploy.',
    );
    stripe = null;
  }

  if (stripe) {
    webhookServer = startStripeWebhookServer({
      config,
      stripe,
      onEvent: async (event) => {
        const intent = interpretStripeEvent(event);
        if (intent.action === 'ignore') {
          log.debug(`Stripe ${event.type}: ${intent.reason}`);
          return;
        }
        const result = await applyStripeIntent(client, store, config, intent, stripe);
        log.info(`Stripe ${event.type} -> ${intent.action}: ${result.status}`);
      },
    });
    log.info('Card payments are on');
  }

  const watcher = new ZelleWatcher({
    imap: config.imap,
    codePrefix: config.codePrefix,
    codeLength: config.codeLength,
    store,
  });

  watcher.on('payment', (payment) => {
    processPayment(client, store, config, payment).catch((error) => {
      log.error(`Error applying the payment: ${error.message}`);
    });
  });

  watcher.on('error', (error) => log.error(`Mailbox watcher: ${error.message}`));

  client.once(Events.ClientReady, async (ready) => {
    log.info(`Logged in as ${ready.user.tag}`);

    // Data loss on a host with no persistent volume is completely silent: the
    // bot starts clean, and open calls and memberships from before the deploy
    // are simply gone. Saying what was found makes it visible on the first
    // restart rather than the first time somebody's call disappears.
    const counts = store.summary();
    if (store.writeError) {
      log.error(
        `THE STORE CANNOT BE WRITTEN: ${store.writeError}. Nothing will be saved — ` +
          'every payment, membership and call will be lost the moment it happens. ' +
          `On Railway this is the volume at ${store.path} being owned by root; the container ` +
          'must take ownership of it at startup. Fix this before taking money.',
      );
    }
    if (store.recoveredFrom) {
      log.warn(
        `The store was unreadable or missing, so it was rebuilt from ${store.recoveredFrom}: ` +
          `${counts.subscriptions} membership(s), ${counts.picks} call(s), ${counts.orders} order(s). ` +
          'Anything changed since that backup was written is gone — check the last few payments.',
      );
    } else if (store.existedAtBoot) {
      log.info(
        `Store at ${store.path}: ${counts.subscriptions} membership(s), ${counts.picks} call(s), ${counts.orders} order(s)`,
      );
    } else {
      log.warn(
        `No store found at ${store.path} — starting empty. If this happens on every deploy, ` +
          'the folder is not on a persistent volume and every restart is wiping memberships and open calls.',
      );
    }

    if (config.deployCommandsOnStart) {
      await registerCommands(config).catch((error) =>
        log.error(`Could not register the commands: ${error.message}`),
      );
    }

    const guild = await client.guilds.fetch(config.guildId).catch(() => null);
    if (!guild) {
      log.error(`The bot is not a member of guild ${config.guildId}`);
    } else {
      const problems = await checkRoleSetup(guild, config);
      for (const problem of problems) log.warn(problem);
    }

    watcher.start();

    // Housekeeping: expire abandoned orders, warn memberships that are about to
    // run out and take the roles back from the ones that already did.
    const housekeeping = async () => {
      const expired = expireStaleOrders(store);
      if (expired.length > 0) log.info(`${expired.length} order(s) expired`);
      try {
        const swept = await sweepSubscriptions(client, store, config, Date.now(), stripe);
        if (swept.reminded || swept.expired || swept.reconciled) {
          log.info(
            `Memberships: ${swept.reminded} reminded, ${swept.expired} expired, ${swept.reconciled} reconciled with Stripe`,
          );
        }
      } catch (error) {
        log.error(`Membership sweep failed: ${error.message}`);
      }
    };

    await housekeeping();
    setInterval(() => {
      housekeeping().catch((error) => log.error(`Housekeeping failed: ${error.message}`));
    }, config.sweepIntervalMinutes * 60 * 1000).unref();

    // Calls are graded on their own clock: a 15-minute call asked about on the
    // 15-minute housekeeping sweep could sit unasked for a quarter of an hour,
    // which is as long as the call itself.
    setInterval(() => {
      promptDueSettlements(client, store, config).catch((error) =>
        log.error(`Could not ask for a call result: ${error.message}`),
      );
      publishVoteResults(client, store, config).catch((error) =>
        log.error(`Could not publish a vote result: ${error.message}`),
      );
    }, 60 * 1000).unref();

    // The analyst's own fills. This is the latency the room actually feels: a
    // call is worth less every second it arrives late, and on a 15-minute
    // market a slow poll can miss the entry and the exit both.
    //
    // The guard matters more than the interval. A pass that runs long — a slow
    // Kalshi, a rate limit — must not have the next one start on top of it and
    // publish the same fill twice.
    const pollMs = Math.max(1000, (config.picks?.kalshi?.account?.pollSeconds ?? 3) * 1000);
    let syncing = false;
    setInterval(() => {
      if (syncing) return;
      syncing = true;
      syncKalshiAccount(client, store, config)
        .catch((error) => log.error(`Kalshi account sync failed: ${error.message}`))
        .finally(() => {
          syncing = false;
        });
    }, pollMs).unref();
  });

  // Nobody reads pinned messages on the way in. A DM with the buttons is the
  // one moment a new arrival is actually paying attention.
  client.on(Events.GuildMemberAdd, async (member) => {
    if (!config.welcomeDm) return;
    if (member.user.bot) return;
    if (member.guild.id !== config.guildId) return;

    // Somebody who bought from a DM before joining has a paid membership and no
    // roles. This is the moment that gets fixed — before the welcome, so their
    // first sight of the server is the access they already paid for.
    const paid = store.getSubscription(config.guildId, member.id);
    if (paid && paid.status === 'active' && paid.expiresAt > Date.now()) {
      try {
        const granted = await grantTierRoles(member.guild, member.id, paid.tier, config);
        log.info(`Handed ${member.user.tag} the ${granted.added.length} role(s) they had already paid for`);
        await sendLog(
          client,
          config,
          new EmbedBuilder()
            .setColor(COLORS.success)
            .setDescription(
              `🎟️ <@${member.id}> joined and was given the **Tier ${paid.tier}** access they bought before arriving.`,
            )
            .setTimestamp(),
        );
      } catch (error) {
        log.error(`Could not hand ${member.user.tag} their paid roles: ${error.message}`);
      }
    }

    let delivered = true;
    let reason = null;
    try {
      await member.send(storefrontMessage(config, { includeTicket: false, welcome: true }));
      log.info(`Welcomed ${member.user.tag}`);
    } catch (error) {
      delivered = false;
      reason = error.message;
      log.warn(`Welcome DM to ${member.user.tag} did not go through: ${error.message}`);
    }

    store.recordWelcome({
      userId: member.id,
      userTag: member.user.tag,
      delivered,
      reason,
      at: Date.now(),
    });

    // A DM that never lands is silent on both ends: the member sees nothing and
    // so does the owner. Putting the outcome in the log channel is the only way
    // to tell "no new members" apart from "new members who heard nothing".
    await sendLog(
      client,
      config,
      new EmbedBuilder()
        .setColor(delivered ? COLORS.success : COLORS.warning)
        .setDescription(
          delivered
            ? `👋 <@${member.id}> joined — welcome DM delivered.`
            : `👋 <@${member.id}> joined — **DM blocked**, they have DMs closed. They will only see the panel in the server.`,
        )
        .setTimestamp(),
    );
  });

  // Somebody writing to the bot is asking how to get in. Answering in the
  // second it takes to send a message beats making them wait for a person.
  client.on(Events.MessageCreate, async (message) => {
    const verdict = shouldGreetDm(
      {
        authorId: message.author?.id,
        authorIsBot: message.author?.bot ?? false,
        isDirectMessage: message.channel?.type === ChannelType.DM,
      },
      config,
      store.lastDmReplyAt(message.author?.id),
    );
    if (!verdict.reply) return;

    try {
      await message.channel.send(
        storefrontMessage(config, { includeTicket: false, welcome: true }),
      );
      store.markDmReplied(message.author.id);
      log.info(`Answered a DM from ${message.author.tag}`);

      await sendLog(
        client,
        config,
        new EmbedBuilder()
          .setColor(COLORS.gold)
          .setDescription(
            `📬 **${message.author.tag}** messaged the bot and was sent the storefront.` +
              (config.serverInviteUrl ? '' : '\n_No `SERVER_INVITE_URL` is set, so they got no way in._'),
          )
          .setTimestamp(),
      );
    } catch (error) {
      log.warn(`Could not answer ${message.author?.tag}: ${error.message}`);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleInteraction(interaction, { store, config, client, watcher, stripe });
    } catch (error) {
      log.error(`Interaction error: ${error.stack ?? error.message}`);
      // "Something went wrong" tells a mod nothing and leaves them guessing at a
      // permission they cannot see. Discord's own wording is the actual lead.
      const payload = {
        content: `Something went wrong while handling that command:\n\`\`\`\n${error.message}\n\`\`\`\nIf it mentions permissions, check what the bot is allowed to do in this channel.`,
      };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else if (!interaction.replied) {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  return { client, store, watcher, stripe, webhookServer, config };
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  const config = loadVipConfig();
  const { client, watcher, webhookServer } = createVipBot(config);
  const shutdown = () => {
    watcher.stop();
    webhookServer?.close();
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  client.login(config.token);
}
