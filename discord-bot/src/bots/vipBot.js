import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import { loadVipConfig } from '../config.js';
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
import { checkRoleSetup } from '../vip/roles.js';

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
  const stripe = createStripeClient(config);
  let webhookServer = null;

  if (stripe) {
    if (!config.stripe.webhookSecret) {
      log.warn('STRIPE_WEBHOOK_SECRET missing: card payments cannot be verified, so they will not be accepted');
    } else {
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
    }
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
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleInteraction(interaction, { store, config, client, watcher, stripe });
    } catch (error) {
      log.error(`Interaction error: ${error.stack ?? error.message}`);
      const payload = { content: 'Something went wrong while handling that command.' };
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
