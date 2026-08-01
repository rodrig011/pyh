import { Client, Events, GatewayIntentBits, MessageFlags, REST, Routes } from 'discord.js';
import { loadVipConfig } from '../config.js';
import { createLogger } from '../lib/logger.js';
import { createStore } from '../lib/store.js';
import { ZelleWatcher } from '../payments/zelleWatcher.js';
import { buildCommands, handleInteraction } from '../vip/commands.js';
import { expireStaleOrders } from '../vip/orders.js';
import { processPayment } from '../vip/paymentFlow.js';
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
    // Periodic cleanup of overdue orders.
    setInterval(() => {
      const expired = expireStaleOrders(store);
      if (expired.length > 0) log.info(`${expired.length} order(s) expired`);
    }, 15 * 60 * 1000).unref();
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleInteraction(interaction, { store, config, client, watcher });
    } catch (error) {
      log.error(`Interaction error: ${error.stack ?? error.message}`);
      const payload = { content: 'Something went wrong while handling that command.' };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else if (!interaction.replied) {
        await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
      }
    }
  });

  return { client, store, watcher, config };
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  const config = loadVipConfig();
  const { client, watcher } = createVipBot(config);
  const shutdown = () => {
    watcher.stop();
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  client.login(config.token);
}
