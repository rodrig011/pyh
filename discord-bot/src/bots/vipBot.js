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
import { buildLine } from '../lib/build.js';
import { ZelleWatcher } from '../payments/zelleWatcher.js';
import { createStripeClient, interpretStripeEvent } from '../payments/stripe.js';
import { startStripeWebhookServer } from '../payments/stripeWebhook.js';
import { startDashboardServer } from '../dashboard/server.js';
import { applyStripeIntent } from '../vip/stripeFlow.js';
import { buildCommands, handleInteraction } from '../vip/commands.js';
import { expireStaleOrders } from '../vip/orders.js';
import { processPayment } from '../vip/paymentFlow.js';
import { sweepSubscriptions } from '../vip/subscriptionSweeper.js';
import { checkRoleSetup, grantTierRoles } from '../vip/roles.js';
import { storefrontMessage } from '../vip/storefront.js';
import { shouldGreetDm } from '../vip/dmGreeting.js';
import { banAlertText, isBanned } from '../vip/banlist.js';
import { promptDueSettlements, publishVoteResults, syncKalshiAccount } from '../picks/commands.js';
import { checkPicksChannelSetup } from '../picks/channelSetup.js';
import { collectOnce } from '../signals/collector.js';
import { observeOnce } from '../signals/recorder.js';
import { evaluate } from '../signals/engine.js';
import { confluenceRead } from '../signals/confluence.js';
import { appendConfluenceRecord, makeConfluenceRecord } from '../signals/confluenceLog.js';
import { currentContract, closeTimeOf, nearestTheMoneyContract, openBoard } from '../picks/kalshi.js';
import { fetchTrades } from '../picks/whales.js';
import { sweepLiveTrading, sweepPaper, sweepSignalAlerts, sweepWatches } from '../picks/watch.js';
import { placeOrder } from '../picks/kalshiOrders.js';
import { ANALYST_GUIDE_MESSAGE, gainedWatchedRole } from '../picks/analystOnboarding.js';
import { shouldNudge, staleSinceMs } from '../picks/consistency.js';
import { fetchSpotPrice } from '../picks/price.js';

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

  // A read-only page outside Discord — what the model would call right now,
  // with a confidence and a clock. Never places an order. Sharing a port with
  // the Stripe server above would collide if both are ever on at once; since
  // Stripe is off, this is safe to start unconditionally.
  let dashboardServer = null;
  if (config.dashboard?.enabled && !(stripe && config.dashboard.port === config.stripe.port)) {
    dashboardServer = startDashboardServer({ store, config });
  } else if (config.dashboard?.enabled) {
    log.error(
      `Dashboard not started: it would collide with the Stripe webhook server on port ${config.stripe.port}. Set DASHBOARD_PORT to something else.`,
    );
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
    // Which build this actually is. A restart that silently comes back on the
    // previous image is otherwise indistinguishable from a fix that did not
    // work, and that ambiguity has cost more time than any bug in this file.
    log.info(buildLine());

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

      const channelProblems = await checkPicksChannelSetup(guild, config);
      for (const problem of channelProblems) log.warn(problem);
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

      // A quiet picks channel is invisible from the inside — somebody always
      // remembers eventually. This is the only thing that notices from the
      // outside, the way a member who gave up scrolling would.
      const staleHours = config.picks?.staleHours ?? 0;
      if (staleHours > 0) {
        const staleMs = staleSinceMs(store.listPicks((pick) => pick.guildId === config.guildId));
        if (
          shouldNudge({
            staleMs,
            thresholdMs: staleHours * 60 * 60 * 1000,
            lastNudgeAt: store.picksNudgedAt(),
          })
        ) {
          store.markPicksNudged(Date.now());
          await sendLog(
            client,
            config,
            new EmbedBuilder()
              .setColor(COLORS.warning)
              .setDescription(
                `😴 **No calls posted in over ${staleHours} hour(s).** The picks channel has gone quiet — check in with whoever is on rotation.`,
              )
              .setTimestamp(),
            { ping: true },
          );
        }
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
    // Whether this is armed at all is invisible otherwise: the loop only writes
    // a line when it publishes something, so "connected but silent" and "never
    // started" look exactly the same from the logs.
    const kalshiAccount = config.picks?.kalshi?.account ?? {};
    const hasKalshiKey = Boolean(kalshiAccount.keyId && kalshiAccount.privateKeyPem);
    if (!kalshiAccount.autoPublish) {
      log.info(
        'Kalshi auto-publish is OFF (KALSHI_AUTO_PUBLISH is not true) — calls come from the console only',
      );
    } else if (!hasKalshiKey) {
      log.error(
        'KALSHI_AUTO_PUBLISH is on but the account credentials are missing, so nothing will ever publish. ' +
          'Set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY.',
      );
    } else if (!config.picks?.channelId) {
      log.error(
        'Kalshi auto-publish is on but PICKS_CHANNEL_ID is not set, so a fill has nowhere to be posted.',
      );
    } else {
      log.info(
        `Kalshi auto-publish is ON: reading ${kalshiAccount.seriesTicker ?? 'every series'} every ` +
          `${kalshiAccount.pollSeconds ?? 3}s for ${kalshiAccount.analystTag ?? 'the configured analyst'}, ` +
          `posting to channel ${config.picks.channelId}`,
      );
    }

    // Price history for the signal engine. Written down long before anyone
    // wants it, because volatility cannot be measured backwards — three weeks
    // of this is the difference between a model that can be checked and one
    // that can only be believed. Flushed on a slower timer than it samples, so
    // two thousand writes a day do not land on the volume holding the payments.
    const signals = config.signals ?? {};
    const kalshi = config.picks?.kalshi ?? {};
    if (signals.collect !== false) {
      const asset = config.picks?.defaultAsset ?? 'BTC';
      let unsaved = 0;
      setInterval(() => {
        collectOnce(store, { fetchPrice: fetchSpotPrice, asset })
          .then(async (result) => {
            if (!result.added) return;
            unsaved += 1;

            // The contract's own quote, next to the spot that was just saved.
            //
            // This is the only thing in the whole system that can answer
            // whether Kalshi is ever actually mispriced. Everything else
            // assumes it and computes the consequences. Recorded from the bot
            // that is already deployed, so the data starts accumulating now
            // rather than whenever the signal bot gets its own application —
            // weeks of history that cannot be collected retroactively.
            if (kalshi?.enabled && kalshi.seriesTicker) {
              // The strike nearest a coin flip, not whichever the exchange
              // listed first. A dozen strikes share a close time, so "the one
              // closing soonest" was a fixed position on the ladder rather than
              // a fixed distance from the money — and it filled the edge log
              // with contracts priced at 3¢ and 96¢, whose outcomes are nearly
              // decided and which the engine refuses on sight. Measuring the
              // edge on a population the bot never trades answers a question
              // nobody asked.
              //
              // Still ONE strike per sample, deliberately. Recording the whole
              // board would multiply the writes by twelve for observations that
              // share a spot, a volatility and a window — nowhere near twelve
              // independent facts, and the log has a fixed capacity, so the
              // reliable purchase would be twelve times less history.
              const board = await openBoard(kalshi).catch(() => null);
              const contract = nearestTheMoneyContract(board?.contracts);
              if (contract) {
                // The model's read goes down beside the quote. Recording the
                // quote alone would only ever answer "is Kalshi biased"; the
                // question the engine rests on is whether our number beats
                // theirs, and that cannot be rebuilt afterwards because it
                // depends on the price history as it stood at this instant.
                observeOnce(store, {
                  asset,
                  contract,
                  spot: result.price,
                  evaluateModel: (input) =>
                    evaluate(input, { sampleSeconds: signals.sampleSeconds ?? 30 }),
                });

                // Confluence's own lean, logged beside the same quote — see
                // confluenceLog.js. A second read that must never be allowed
                // to affect a single trade; it exists purely to be checked
                // against the primary model above, over time, the same way
                // the market's own price already is.
                try {
                  const priceHistory = store
                    .listSamples(asset)
                    .filter((sample) => sample?.at >= Date.now() - 60 * 60 * 1000 && sample?.price > 0)
                    .map((sample) => sample.price);
                  const strike = Number(contract.market.floor_strike ?? contract.market.cap_strike);
                  const closesAt = closeTimeOf(contract.market);
                  const primary = evaluate(
                    {
                      prices: priceHistory,
                      spot: result.price,
                      strike,
                      marketPriceCents: contract.price,
                      market: contract.market,
                      secondsLeft: Number.isFinite(closesAt) ? (closesAt - Date.now()) / 1000 : null,
                    },
                    { sampleSeconds: signals.sampleSeconds ?? 30 },
                  );
                  const lean = confluenceRead({ prices: priceHistory });
                  const record = makeConfluenceRecord({
                    at: Date.now(),
                    spot: result.price,
                    lean: lean.lean,
                    score: lean.score,
                    primaryLeaning: Number.isFinite(primary.probability)
                      ? primary.probability >= 0.5
                        ? 'up'
                        : 'down'
                      : null,
                    primaryWinProbability: Number.isFinite(primary.probability)
                      ? primary.probability
                      : null,
                  });
                  store.putConfluenceLog?.(
                    asset,
                    appendConfluenceRecord(store.confluenceLog?.(asset) ?? [], record),
                  );
                } catch (error) {
                  log.debug(`Confluence record failed: ${error.message}`);
                }
              }
            }

            if (unsaved >= (signals.flushEvery ?? 10)) {
              unsaved = 0;
              store.save();
            }
          })
          .catch((error) => log.debug(`Price sample failed: ${error.message}`));
      }, (signals.sampleSeconds ?? 30) * 1000).unref();

      log.info(
        `Collecting ${asset} price every ${signals.sampleSeconds ?? 30}s for the signal engine ` +
          `(${store.listSamples(asset).length} sample(s) already stored)`,
      );
    }

    // Exit alerts for anyone who registered a position. Faster than the price
    // collector on purpose: an exit is worth less every second it is late, and
    // one small read shared by everybody watching the same market is cheap.
    if (kalshi?.enabled && kalshi.seriesTicker) {
      const watchMs = Math.max(5000, (signals.watchSeconds ?? 10) * 1000);
      setInterval(() => {
        sweepWatches(client, store, config, { currentContract, fetchSpotPrice, log })
          .then((result) => {
            if (result.alerted > 0) log.info(`Sent ${result.alerted} cash-out DM(s)`);
          })
          .catch((error) => log.debug(`Watch sweep failed: ${error.message}`));

        // Paper trading rides the same sweep, so it sees the market exactly as
        // often as somebody watching it would.
        sweepPaper(client, store, config, { openBoard, fetchSpotPrice, log })
          .then((result) => {
            if (result.event) log.info(`Paper: ${result.event}`);
          })
          .catch((error) => log.debug(`Paper sweep failed: ${error.message}`));

        // Signal and whale alerts into the panel's channel, if one was posted.
        // Same sweep, because an alert is worth less every second it is late —
        // and it costs nothing when no panel exists.
        sweepSignalAlerts(client, store, config, { openBoard, fetchSpotPrice, fetchTrades, log })
          .catch((error) => log.debug(`Alert sweep failed: ${error.message}`));

        // Real money. Was never actually wired into any interval before this
        // — /picks live arm flipped a flag in the store and nothing ever
        // read it on a schedule, so an armed account could sit all night and
        // never place a single order regardless of profile. Same cadence as
        // the sweep above: exposure to a market is worth less every second
        // this is late, same as an exit or an alert.
        sweepLiveTrading(client, store, config, { openBoard, fetchSpotPrice, placeOrder, log })
          .then((result) => {
            if (result.traded) log.info(`LIVE trade placed (${result.status ?? 'placed'})`);
          })
          .catch((error) => log.debug(`Live trading sweep failed: ${error.message}`));
      }, watchMs).unref();

      log.info(`Watching positions for cash-out alerts every ${watchMs / 1000}s`);
    }

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
    if (member.user.bot) return;
    if (member.guild.id !== config.guildId) return;

    // Checked before anything else — before the welcome DM, before handing
    // back paid roles. Mods hear about it first, in case the ban call itself
    // fails and a human has to finish the job by hand.
    if (isBanned(member.id, config.banUserIds)) {
      await sendLog(client, config, new EmbedBuilder().setColor(COLORS.danger).setDescription(banAlertText(member)).setTimestamp(), {
        ping: true,
      });
      try {
        await member.ban({ reason: 'On the ban list' });
        log.info(`Banned ${member.user.tag} (${member.id}) — on the ban list`);
      } catch (error) {
        log.error(`Could not ban ${member.user.tag} (${member.id}): ${error.message}`);
        await sendLog(
          client,
          config,
          new EmbedBuilder()
            .setColor(COLORS.danger)
            .setDescription(`⚠️ Could not ban <@${member.id}> automatically: \`${error.message}\`. Ban them by hand.`)
            .setTimestamp(),
        );
      }
      return;
    }

    if (!config.welcomeDm) return;

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

  // The moment somebody is handed the analyst role is the one moment they are
  // actually paying attention to how the console works — same reasoning as
  // the join DM above. Waiting for a mod to explain it live is how a new
  // analyst's first pick ends up typed by hand instead of run through the
  // panel that tracks and scores it.
  client.on(Events.GuildMemberUpdate, async (before, after) => {
    if (after.user.bot) return;
    if (after.guild.id !== config.guildId) return;

    const analystRoleIds = config.picks?.analystRoleIds ?? [];
    const gained = gainedWatchedRole(
      [...before.roles.cache.keys()],
      [...after.roles.cache.keys()],
      analystRoleIds,
    );
    if (!gained) return;

    try {
      await after.send(ANALYST_GUIDE_MESSAGE);
      log.info(`Sent the analyst guide to ${after.user.tag}`);
    } catch (error) {
      log.warn(`Could not DM the analyst guide to ${after.user.tag}: ${error.message}`);
    }
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

  return { client, store, watcher, stripe, webhookServer, dashboardServer, config };
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  const config = loadVipConfig();
  const { client, watcher, webhookServer, dashboardServer, store } = createVipBot(config);
  const shutdown = () => {
    watcher.stop();
    // Same reason as in index.js: samples are flushed every tenth tick, so an
    // unflushed tail of up to five minutes dies with the process otherwise.
    try {
      store.save();
    } catch (error) {
      log.error(`Could not save the store on shutdown: ${error.message}`);
    }
    webhookServer?.close();
    dashboardServer?.close();
    client.destroy();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
  client.login(config.token);
}
