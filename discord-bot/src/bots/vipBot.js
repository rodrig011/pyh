import { Client, EmbedBuilder, Events, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
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
import { promptDueSettlements } from '../picks/commands.js';

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
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });

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
    }, 60 * 1000).unref();
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
