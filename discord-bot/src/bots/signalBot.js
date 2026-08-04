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

export function createSignalBot(config = loadSignalConfig()) {
  const store = createStore(config.storePath);
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  /** Reads the market and the price history, and asks the engine. */
  async function read() {
    const samples = store.listSamples(config.asset);
    const quality = historyQuality(samples, { sampleSeconds: config.sampleSeconds });
    if (!quality.ok) return { ready: false, quality };

    const contract = await currentContract({
      apiBase: config.apiBase,
      seriesTicker: config.seriesTicker,
    });
    const closesAt = Date.parse(contract.market?.close_time ?? '');
    const secondsLeft = Number.isFinite(closesAt) ? (closesAt - Date.now()) / 1000 : null;

    const spot = await fetchSpotPrice(config.asset);
    const strike = Number(contract.market?.floor_strike ?? contract.market?.cap_strike);

    const result = evaluate(
      {
        prices: pricesSince(samples, Date.now() - 60 * 60 * 1000),
        spot: spot.price,
        strike,
        marketPriceCents: contract.price,
        market: contract.market,
        secondsLeft,
      },
      config.engine,
    );

    return { ready: true, result, contract, secondsLeft, quality };
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

    const samples = store.listSamples(config.asset);
    log.info(
      `${samples.length} price sample(s) on hand. ` +
        (samples.length < 20
          ? 'Not enough to measure volatility yet — the engine will stay quiet.'
          : 'Enough to read a market.'),
    );

    // Sampling here as well, so this bot is useful even if it is the only one
    // running. The store's own de-duplication makes a double writer harmless.
    setInterval(() => {
      collectOnce(store, { fetchPrice: fetchSpotPrice, asset: config.asset })
        .then((r) => {
          if (r.added && r.samples % 10 === 0) store.save();
        })
        .catch(() => null);
    }, config.sampleSeconds * 1000).unref();
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    try {
      if (interaction.commandName === 'signal') {
        await interaction.deferReply();
        const state = await read();

        if (!state.ready) {
          return interaction.editReply(
            `📉 Still learning the market — ${state.quality.reason}.\n` +
              '_Volatility cannot be measured backwards. The engine stays quiet until it can._',
          );
        }

        const sizing =
          state.result.verdict === VERDICTS.SKIP
            ? null
            : recommendSize({
                probability: state.result.probability,
                worstProbability: state.result.probabilityRange?.[0],
                priceDollars: state.result.entryCents / 100,
                kellyFraction: config.kellyFraction,
                maximumFraction: config.maximumFraction,
              });

        return interaction.editReply({
          embeds: [
            signalEmbed(state.result, {
              asset: config.asset,
              ticker: state.contract.market?.ticker,
              secondsLeft: state.secondsLeft,
              sizing,
            }),
          ],
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

  return { client, store, read, config };
}
