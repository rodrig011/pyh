# Paper trading the signal engine

The engine has never placed a real order and has never emitted a live signal.
Everything below is simulated, and the point of simulating rather than
backtesting is that the answer is knowable in advance: the process generating
the prices is written down in `src/signals/simulate.js`, so the engine can be
caught claiming an edge that is not there.

Reproduce any row with `node --test test/simulate.test.js` for the assertions,
or by calling `runBacktest` directly.

## The rule the numbers are read against

A market is one 15-minute contract. 300 markets is 75 hours, about 3.1 days of
round-the-clock trading.

Three results have to hold together or none of them mean anything:

1. Against a market that is **never wrong**, the engine must make roughly
   nothing. Profit here is not skill, it is the engine reading its own
   measurement noise, and it would invalidate every other row.
2. Against a market that **is** wrong by a known amount, it must find that —
   and never more than that.
3. Against worlds the model does **not** assume (jumps, volatility that
   clusters), it must not fall apart quietly.

## Results, on seeds not used for any tuning

300 markets each, six seeds, `$100` start, all fees charged on both legs.

| Scenario | Markets traded | Trades | Win rate | Mean return | Worst seed | Best seed |
|---|---|---|---|---|---|---|
| Market is never wrong | 26/300 | 28 | 56.3% | **+2.7%** | −16.5% | +18.6% |
| Market 6¢ too high | 287/300 | 290 | 50.7% | **+112.4%** | −20.4% | +319.7% |
| Market 6¢ too low | 293/300 | 299 | 49.3% | **+146.6%** | +20.8% | +291.8% |
| Market 2¢ too high | 55/300 | 57 | 54.3% | **+7.8%** | −11.1% | +18.2% |
| Market 90s stale | 298/300 | 1286 | 89.7% | absurd | — | — |

Worlds the model does not assume, priced by simulating the true remaining
distribution from the true current state (150 markets):

| Scenario | Markets traded | Win rate | Mean return |
|---|---|---|---|
| *Control: constant vol, same noisy pricer* | 18/150 | 63.1% | *+5.8%* |
| Jumps, 3% per step | 44/150 | 44.9% | **−10.7%** |
| Volatility clustering | 24/150 | 40.8% | **−4.0%** |
| Jumps + clustering | 45/150 | 45.4% | **−3.6%** |
| Jumps + clustering, market 6¢ too high | 146/150 | 48.9% | **+68.6%** |

The control row is there because those five rows price the contract by
simulation rather than by formula, and a simulated price carries sampling
noise — and noise **is** mispricing. Read the last four against +5.8%, not
against zero. At 200 forward paths instead of 4000 the same control printed
**+284%**, which is the harness inventing an edge out of nothing and a good
illustration of how a backtest produces a genius.

## What this says about 20% a day

The 6¢ rows are the only ones that get anywhere near it: +112% over 3.1 days
compounds to about **+27% a day**. So the answer to "is 20% a day possible" is
yes — *if* the market stands six cents wrong on essentially every 15-minute
contract, all day, and you get filled at those prices.

That is the whole question, and it is not a question about the bot. Six cents
of standing mispricing on a market made by professionals is not something that
sits there. Two cents is already generous, and two cents pays **+7.8% over 3.1
days — about 2.4% a day**. A market that is priced correctly pays nothing.

Note also the worst seed in the 6¢ row: **−20.4%**, three days of losses while
holding an enormous, guaranteed edge. Edge is not a schedule.

## Three bugs these runs found

They are the reason the file exists, and all three were live in the bot, not
only in the simulator.

**A DOWN call was sized with the odds of the market going UP.** The engine's
`probability` is always the chance of finishing above the strike; the winning
probability for a DOWN call is one minus that. Every down trade was staked on
the losing side. Fixed by publishing `winProbability` from the engine and
consuming it everywhere.

**Silence was read as a reversal.** The engine skips a market whenever the edge
falls under its *entry* threshold, which is most ticks of most markets. The
exit rule treated any non-matching verdict — including `skip` — as "the model
flipped, get out". Every position became a guaranteed round trip that captured
nothing and paid two fees. In the biased runs it was **every single trade**,
and it turned a known 6¢ edge into a 70% loss. Entering and exiting only
harvests a mispricing that *converges*; a standing bias only pays at
settlement.

**Positions were sold 45 seconds before the bell.** Kalshi charges per leg and
charges nothing at settlement, so selling a contract the model still likes
gives away a fee for no reason. "Always flatten before expiry" is advice from
venues that do not charge per leg. Holding to settlement is now the default and
the position is only sold when the model actively says the side is worth less
than it costs.

## One tuning change

`minimumEdgeCents` went from 4 to 6. The reason is arithmetic rather than
fitting: the standard error of a volatility estimated from ~90 samples is about
σ/√(2n) ≈ 7.5% of σ, which moves the probability three to four cents on its
own. A four-cent threshold therefore fires on the estimate's own noise. Against
a fair market the engine traded 88 times per 300 markets and lost 9% to fees at
four cents; at six it trades 27 times and finishes flat, and the profit it makes
when a real edge exists is unchanged or slightly better.

## What is still unknown

Everything that matters. These are simulated prices, and a simulation cannot
tell you:

- whether Kalshi's 15-minute BTC market is ever actually mispriced, or by how much
- whether the quoted price is one you can get filled at, in size, in a hurry
- what the book does when a real move starts

None of that is answerable from here. It is answerable by running the engine in
a mods-only channel with `SIGNAL_AUTO_POST=false` and reading `/engine` after a
few hundred markets: it prints a Brier score and calibration buckets, and until
that score is below 0.25 with the buckets roughly on the diagonal, the engine
has not earned a real dollar of anyone's money.
