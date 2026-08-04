import {
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  MessageFlags,
  PermissionFlagsBits,
  SlashCommandBuilder,
} from 'discord.js';
import { loadSignalConfig } from '../config.js';
import { COLORS } from '../lib/brand.js';
import { createLogger } from '../lib/logger.js';
import { createStore } from '../lib/store.js';
import { currentContract } from '../picks/kalshi.js';
import { fetchSpotPrice } from '../picks/price.js';
import { collectOnce, historyQuality, pricesSince } from '../signals/collector.js';
import { VERDICTS, calibration, evaluate } from '../signals/engine.js';
import { parseMarkets, planScan } from '../signals/scanner.js';
import { SCALP_ACTIONS, minimumProfitableMoveCents, scalpDecision } from '../signals/scalp.js';
import { oddsBar } from '../picks/panel.js';
import { project, recommendSize } from '../signals/sizing.js';

const log = createLogger('signal');

export function buildSignalCommands() {
  return [
    new SlashCommandBuilder()
      .setName('signal')
      .setDescription('The engine’s read on the market right now')
      .setDMPermission(false)
      .toJSON(),
    new SlashCommandBuilder()
      .setName('engine')
      .setDescription('How the engine has actually been doing')
      .setDMPermission(false)
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
      .toJSON(),
  ];
}

const percent = (value) => (Number.isFinite(value) ? `${Math.round(value * 100)}%` : '—');

/**
 * The engine's read, drawn the way a desk would draw it.
 *
 * Two probabilities and the gap between them. Never a confidence score — the
 * whole point is that every claim here is one somebody can check afterwards.
 */
export function signalEmbed(result, { asset, ticker, secondsLeft, sizing = null }) {
  if (result.verdict === VERDICTS.SKIP) {
    return new EmbedBuilder()
      .setColor(COLORS.warning)
      .setTitle(`⛔ STAY OUT · ${asset}`)
      .setDescription(`**${result.explain}**`)
      .addFields(
        { name: 'MARKET', value: ticker ? `\`${ticker}\`` : '—', inline: true },
        {
          name: 'CLOSES IN',
          value: Number.isFinite(secondsLeft) ? `${Math.round(secondsLeft / 60)} min` : '—',
          inline: true,
        },
      )
      .setFooter({
        text: 'Refusing is the product. Most markets are not worth taking · Not financial advice',
      })
      .setTimestamp();
  }

  const up = result.verdict === VERDICTS.UP;
  const embed = new EmbedBuilder()
    .setColor(up ? COLORS.success : COLORS.danger)
    .setTitle(`${up ? '🟢 BUY UP' : '🔴 BUY DOWN'} · ${asset}`)
    .setDescription(
      [
        `**Model** \`${oddsBar(result.probability * 100)}\` **${percent(result.probability)}**`,
        `**Market** \`${oddsBar(result.marketProbability * 100)}\` **${percent(result.marketProbability)}**`,
        '',
        `The market is **${result.edgeCents.toFixed(1)}¢ wrong**, and still ` +
          `**${result.worstEdgeCents.toFixed(1)}¢ wrong** if our volatility read is off in the direction that hurts.`,
      ].join('\n'),
    )
    .addFields(
      { name: 'ENTRY', value: `**${Math.round(result.entryCents)}%**`, inline: true },
      {
        name: 'NET EDGE',
        value: `**+${(result.expected.net * 100).toFixed(1)}¢** _after fee_`,
        inline: true,
      },
      {
        name: 'FLIP RISK',
        value: Number.isFinite(result.flipProbability)
          ? `**${percent(result.flipProbability)}** it touches the strike again`
          : '—',
        inline: true,
      },
    );

  if (sizing) {
    embed.addFields({
      name: 'SIZE',
      value:
        `**${(sizing.suggested * 100).toFixed(1)}% of bankroll** — a quarter of Kelly on the pessimistic read.\n` +
        `_Full Kelly is ${(sizing.fullKelly * 100).toFixed(1)}%; at twice that, this same winning edge grows the account by nothing._`,
    });
  }

  embed.addFields({
    name: 'WHY',
    value:
      [
        `${result.distanceSigma > 0 ? '+' : ''}${result.distanceSigma?.toFixed(2)}σ from the strike`,
        `vol ${(result.volatility.sigma * 100).toFixed(3)}%/sample (±${((result.volatility.standardError / result.volatility.sigma) * 100).toFixed(0)}%)`,
        result.book.spreadCents !== null ? `spread ${result.book.spreadCents.toFixed(1)}¢` : null,
        ...result.notes,
      ]
        .filter(Boolean)
        .join('\n'),
  });

  return embed
    .setFooter({ text: `${ticker ?? ''} · Not financial advice` })
    .setTimestamp();
}

/**
 * The line that goes out the instant something changes.
 *
 * Written for a phone notification, because that is where it is read and the
 * whole value of it is being early. Everything a member needs to act is in the
 * first line; the reasoning is underneath for anyone who wants it.
 */
export function liveMessage(kind, { entry, call, position = null, sizing = null }) {
  const asset = entry.asset;
  const price = Math.round(call.nowCents);

  if (kind === 'enter') {
    const up = call.side === VERDICTS.UP;
    return {
      content:
        `${up ? '🟢' : '🔴'} **IN NOW — ${asset} ${up ? 'UP' : 'DOWN'} @ ${price}%**` +
        (sizing ? ` · ${(sizing.suggested * 100).toFixed(1)}% of bankroll` : ''),
      embeds: [
        new EmbedBuilder()
          .setColor(up ? COLORS.success : COLORS.danger)
          .setDescription(
            [
              `Model **${Math.round(entry.result.probability * 100)}%** vs market **${price}%**`,
              `Edge **${entry.result.edgeCents.toFixed(1)}¢** — needs **${call.needed}¢** to clear the round trip`,
              `Flip risk **${Math.round((entry.result.flipProbability ?? 0) * 100)}%**`,
            ].join('\n'),
          )
          .setFooter({ text: `${entry.ticker} · Not financial advice` })
          .setTimestamp(),
      ],
    };
  }

  const trip = call.trip;
  const won = (trip?.netCents ?? 0) > 0;
  const why = {
    'move banked': 'the move is paid for and the edge is gone',
    'model flipped': 'the model changed sides — do not hold this',
    bell: 'out of runway, this was never a settlement bet',
    cut: 'it is bleeding and the model has stopped defending it',
  }[call.reason] ?? call.reason;

  return {
    content:
      `${won ? '💸' : '❌'} **OUT NOW — ${asset} @ ${price}%**` +
      (trip ? ` · **${trip.percent >= 0 ? '+' : ''}${trip.percent.toFixed(1)}%** net of fees` : ''),
    embeds: [
      new EmbedBuilder()
        .setColor(won ? COLORS.success : COLORS.danger)
        .setDescription(
          [
            `In at **${Math.round(position?.entryCents ?? 0)}%**, out at **${price}%** — ${why}.`,
            trip
              ? `Gross **${trip.grossCents.toFixed(1)}¢**, fees **${trip.feeCents.toFixed(1)}¢**, ` +
                `net **${trip.netCents.toFixed(1)}¢**.`
              : null,
          ]
            .filter(Boolean)
            .join('\n'),
        )
        .setFooter({ text: `${entry.ticker} · Not financial advice` })
        .setTimestamp(),
    ],
  };
}

export function createSignalBot(config = loadSignalConfig()) {
  const store = createStore(config.storePath);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  // Everything the scanner watches. One asset unless told otherwise; the BNB
  // series turned up in the analyst's own fills, so the list is config.
  const markets = parseMarkets(config.markets, config.asset, config.seriesTicker);

  /** Reads every watched market and hands the lot to the scanner. */
  async function readAll() {
    const inputs = [];
    const waiting = [];

    for (const { asset, series } of markets) {
      const samples = store.listSamples(asset);
      const quality = historyQuality(samples, { sampleSeconds: config.sampleSeconds });
      if (!quality.ok) {
        waiting.push({ asset, reason: quality.reason });
        continue;
      }

      const contract = await currentContract({ apiBase: config.apiBase, seriesTicker: series });
      if (!contract.market) {
        waiting.push({ asset, reason: contract.error ?? 'no market' });
        continue;
      }

      const closesAt = Date.parse(contract.market.close_time ?? '');
      const spot = await fetchSpotPrice(asset);

      inputs.push({
        asset,
        ticker: contract.market.ticker ?? null,
        prices: pricesSince(samples, Date.now() - 60 * 60 * 1000),
        spot: spot.price,
        strike: Number(contract.market.floor_strike ?? contract.market.cap_strike),
        marketPriceCents: contract.price,
        market: contract.market,
        secondsLeft: Number.isFinite(closesAt) ? (closesAt - Date.now()) / 1000 : null,
      });
    }

    const plan = planScan(inputs, {
      kellyFraction: config.kellyFraction,
      maximumFraction: config.maximumFraction,
      maximumTotalFraction: config.maximumTotalFraction,
      engine: config.engine,
    });

    return { plan, waiting, inputs };
  }

  /**
   * The live loop: watch every market tick by tick and shout the moment
   * something is worth doing.
   *
   * The scan answers "is this market worth trading". This answers "now?", two
   * hundred times per market, which is the question a scalper is actually
   * asking — and the only one whose answer expires in seconds.
   *
   * Positions are held in memory on purpose. This is advice about what to do
   * right now, not a ledger; the record of what was called lives with the
   * calls, and a restart should forget an opinion rather than resurrect a
   * stale one.
   */
  const open = new Map();

  async function tick(post) {
    const { plan } = await readAll();
    const byTicker = new Map();
    for (const entry of [...plan.calls, ...plan.skips]) {
      if (entry.ticker) byTicker.set(entry.ticker, entry);
    }

    for (const [ticker, entry] of byTicker) {
      const nowCents = entry.result.entryCents ?? entry.result.marketProbability * 100;
      const position = open.get(ticker) ?? null;

      const call = scalpDecision(
        {
          position,
          nowCents,
          signal: entry.result,
          secondsLeft: entry.result.secondsLeft ?? entry.secondsLeft,
        },
        { feeRate: config.engine.feeRate ?? 0.07 },
      );

      if (call.action === SCALP_ACTIONS.ENTER) {
        open.set(ticker, { entryCents: nowCents, side: call.side, at: Date.now() });
        await post(liveMessage('enter', { entry, call, sizing: entry.sizing }));
      } else if (call.action === SCALP_ACTIONS.EXIT && position) {
        open.delete(ticker);
        await post(liveMessage('exit', { entry, call, position }));
      }
    }

    return { watching: byTicker.size, holding: open.size };
  }

  client.once(Events.ClientReady, async (ready) => {
    log.info(`Logged in as ${ready.user.tag}`);

    if (config.clientId && config.guildId) {
      const guild = await client.guilds.fetch(config.guildId).catch(() => null);
      if (guild) {
        await guild.commands.set(buildSignalCommands()).catch((error) =>
          log.error(`Could not register the commands: ${error.message}`),
        );
        log.info(`/signal and /engine registered in ${guild.name}`);
      }
    }

    for (const { asset, series } of markets) {
      const samples = store.listSamples(asset);
      log.info(
        `${asset} (${series}): ${samples.length} sample(s) on hand` +
          (samples.length < 20 ? ' — not enough to measure volatility yet' : ''),
      );
    }

    // The live loop. Off until the engine has earned it: an uncalibrated model
    // shouting "in now" at people who pay for it is the fastest way to lose a
    // room, and /engine is what decides when it has stopped being a guess.
    if (config.autoPost && config.channelId) {
      const channel = await client.channels.fetch(config.channelId).catch(() => null);
      if (channel?.isTextBased()) {
        const ping = config.roleIds.map((id) => `<@&${id}>`).join(' ');
        const post = (payload) =>
          channel
            .send({
              ...payload,
              content: ping ? `${ping}\n${payload.content}` : payload.content,
              allowedMentions: { roles: config.roleIds },
            })
            .catch((error) => log.warn(`Could not post: ${error.message}`));

        let running = false;
        setInterval(() => {
          if (running) return;
          running = true;
          tick(post)
            .catch((error) => log.error(`Live tick failed: ${error.message}`))
            .finally(() => {
              running = false;
            });
        }, Math.max(2, config.tickSeconds ?? 5) * 1000).unref();

        log.info(`Live scalp alerts ON in #${channel.name}, every ${config.tickSeconds ?? 5}s`);
      }
    } else {
      log.info('Live alerts are OFF (SIGNAL_AUTO_POST). /signal still answers on demand.');
    }

    // Sampling here as well, so this bot is useful even if it is the only one
    // running. Every watched asset, because volatility can only be measured
    // for a series somebody wrote down.
    setInterval(() => {
      for (const { asset } of markets) {
        collectOnce(store, { fetchPrice: fetchSpotPrice, asset })
          .then((r) => {
            if (r.added && r.samples % 10 === 0) store.save();
          })
          .catch(() => null);
      }
    }, config.sampleSeconds * 1000).unref();
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      if (interaction.commandName === 'signal') {
        await interaction.deferReply();
        const { plan, waiting } = await readAll();

        if (plan.calls.length === 0 && plan.skips.length === 0) {
          return interaction.editReply(
            '📉 Still learning the market' +
              (waiting.length > 0
                ? ` — ${waiting.map((w) => `${w.asset}: ${w.reason}`).join(' · ')}`
                : '') +
              '\n_Volatility cannot be measured backwards. The engine stays quiet until it can._',
          );
        }

        // Calls first, at most three cards; the rest of the scan in one line.
        const embeds = plan.calls
          .slice(0, 3)
          .map((call) =>
            signalEmbed(call.result, {
              asset: call.asset,
              ticker: call.ticker,
              secondsLeft: call.result.secondsLeft,
              sizing: call.sizing,
            }),
          );

        const skipLine =
          plan.skips.length > 0
            ? plan.skips.map((skip) => `⛔ **${skip.asset}** — ${skip.result.explain}`).join('\n')
            : null;
        const waitLine =
          waiting.length > 0
            ? waiting.map((w) => `⏳ **${w.asset}** — ${w.reason}`).join('\n')
            : null;

        if (embeds.length === 0) {
          embeds.push(
            new EmbedBuilder()
              .setColor(COLORS.warning)
              .setTitle(`⛔ STAY OUT · all ${plan.scanned} market(s)`)
              .setDescription([skipLine, waitLine].filter(Boolean).join('\n'))
              .setFooter({
                text: 'Refusing is the product. Most markets are not worth taking · Not financial advice',
              })
              .setTimestamp(),
          );
          return interaction.editReply({ embeds });
        }

        return interaction.editReply({
          content:
            (plan.scale < 1
              ? `⚖️ ${plan.calls.length} simultaneous signals — sized down together, crypto moves as one. `
              : '') +
            `Total at risk: **${(plan.totalFraction * 100).toFixed(1)}%** of bankroll.` +
            (skipLine ? `\n${skipLine}` : '') +
            (waitLine ? `\n${waitLine}` : ''),
          embeds,
        });
      }

      if (interaction.commandName === 'engine') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        const report = calibration(store.listSignalRecords?.() ?? []);
        if (report.samples === 0) {
          return interaction.editReply(
            'The engine has not scored a single call yet.\n\n' +
              '_Until it has a few hundred, any win rate it showed you would be noise. ' +
              'That is why this says nothing instead of something flattering._',
          );
        }

        const rows = report.rows
          .map(
            (row) =>
              `\`${row.from}-${row.to}%\` → landed **${row.actual.toFixed(0)}%** ` +
              `(n=${row.samples})${row.overconfidencePoints > 5 ? ' ⚠️' : ''}`,
          )
          .join('\n');

        return interaction.editReply({
          embeds: [
            new EmbedBuilder()
              .setColor(report.brier < 0.25 ? COLORS.success : COLORS.danger)
              .setTitle('📊 Engine calibration')
              .setDescription(rows || 'No scored buckets yet.')
              .addFields(
                { name: 'Scored calls', value: String(report.samples), inline: true },
                {
                  name: 'Brier score',
                  value: `**${report.brier.toFixed(3)}**\n_0.25 = saying 50% to everything_`,
                  inline: true,
                },
              )
              .setFooter({
                text:
                  report.brier < 0.25
                    ? 'Beating a coin. The edge is real so far.'
                    : 'Not beating a coin yet. Do not trade this.',
              })
              .setTimestamp(),
          ],
        });
      }
    } catch (error) {
      log.error(`Interaction failed: ${error.stack ?? error.message}`);
      const payload = { content: `Something went wrong:\n\`\`\`\n${error.message}\n\`\`\`` };
      if (interaction.deferred) await interaction.editReply(payload).catch(() => {});
      else await interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => {});
    }
    return undefined;
  });

  return { client, store, readAll, tick, markets, config };
}
