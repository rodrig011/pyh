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

## The spread is the same size as the edge

Every row above assumes you trade at the mid. Nobody trades at the mid. Adding
a real book changes the picture more than any other single factor:

| Spread | Fair market | 3¢ mispriced | 6¢ mispriced |
|---|---|---|---|
| 0¢ | +2.7% | +13.7% | +112.4% |
| 1¢ | −1.6% | +13.3% | +79.9% |
| 2¢ | +0.5% | +8.6% | +67.7% |
| 3¢ | +2.5% | **+0.4%** | +47.0% |
| 4¢ | no trades | no trades | no trades |

Read the 3¢ mispricing row against a 3¢ spread: **+0.4%**. Nothing. That
combination is not an unreasonable guess at reality, and it is the single most
sobering number in this document. The 4¢ row is the spread filter refusing to
trade at all, which is correct behaviour rather than a failure.

## Four ideas that were tested and did not work

Worth as much as the ones that did, and cheaper to learn here.

**Resting orders instead of crossing the spread.** The obvious fix for the
table above: stop paying the spread, quote at the bid and let the market come
to you. It loses, in every regime tested — win rate falls from 53% to 46% and a
+68% run becomes −22%. The reason is adverse selection, and the simulation gets
it right by construction: a resting order only fills when the price moves
through it, which is exactly when the thesis was wrong. The spread you save is
half of what the market has to move against you to fill you.

**Resting orders when much of the flow is uninformed.** The steelman: real
markets have people trading for reasons unrelated to information, so not every
fill is adverse. Adding up to ±3¢ of pure quote noise does not rescue it —
maker still loses (−10.3% against taker's +1.9%), because the fill count roughly
halves and less compounding beats a slightly better entry.

**Entering earlier or later in the fifteen minutes.** Sweeping the cutoff from
45 to 600 seconds left moves the result around within noise, with no stable
pattern across worlds. There is no good hour here.

**Trading only near-the-money.** Narrowing entries to 35¢–65¢ raises the win
rate from 58% to **74%** — and lowers the return. It is the cleanest available
demonstration that win rate is a vanity metric: fewer trades, each paying less,
dressed up as a better strategy.

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

**The edge was measured against a price nobody can trade at.** The engine
compared its probability to the mid. Buying YES costs the ask; buying NO costs
a hundred minus the YES *bid*, not a hundred minus the YES ask — that is the NO
bid, which is what you would receive for selling. On a market quoted 46/49 a
model saying 54 believed it had 6.5¢ of edge. It had 5¢. Half the spread, on
every trade, always in the flattering direction, against a threshold of six
cents. Every side is now priced at what it actually costs, in `cost.js`.

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

None of that is answerable from here. So the bot now records the answer.

## The recorder, which is the only part that can end the argument

Every 30 seconds the VIP bot — the one already deployed, so this starts today
rather than whenever the signal bot gets its own Discord application — writes
down the contract's bid, its ask, the spot, the strike and the time left. When
a market finishes, the observations for it are graded against what happened.

`/picks edge` then reports two Brier scores computed on identical rows:

- **the market's**, from Kalshi's own mid
- **the model's**, from our probability

Whichever is lower is the better forecaster. If the market's is lower there is
no business here, and no amount of further engineering changes that — which is
why the command says so in exactly those words rather than burying it in a
number. It also reports the market's average error in cents with a 95% interval,
and refuses to call a bias real while that interval crosses zero.

This needs a couple of days of recording and costs nothing to gather. It is the
difference between "we think the market is wrong" and "we measured how wrong,
and the interval does not cross zero".

Requires `KALSHI_ENABLED=true` and `KALSHI_SERIES_TICKER` set. One caveat
written into the code as well: the outcome is graded against the bot's own spot
feed, not Kalshi's settlement index. The disagreement is symmetric so it biases
nothing, but it adds noise, and it lands hardest exactly where the contracts sit
— near the money.

## Making it "more accurate": three attempts, three negatives

The instinct is to add indicators. The engine's decision already ignores the
ones it computes — `rsi` and `momentum` are displayed and nothing more, which
is correct: both are functions of the same price series the model already
reads, so they add parameters rather than information. The only inputs that
change a digital's fair value are the spot, the strike, the time left and the
volatility. Everything else is decoration.

So instead, three real upgrades were built and measured.

**Fat tails (Student-t), scored against 15,000 simulated observations.** Real
bitcoin returns are leptokurtic, so a normal model ought to be wrong. It is —
but not in the direction anyone expects, and correcting it makes things worse:

| Model | No jumps | Jumps 3% | Jumps + clustering |
|---|---|---|---|
| Normal | **0.16238** | **0.16085** | **0.17358** |
| t(10) | 0.16259 | 0.16115 | 0.17416 |
| t(6) | 0.16296 | 0.16159 | 0.17484 |
| t(4) | 0.16397 | 0.16267 | 0.17635 |
| t(3) | 0.16636 | 0.16511 | 0.17943 |

The normal model wins in every world, including the ones with jumps, and the
fatter the assumed tail the worse it gets. Two reasons, both instructive. The
volatility estimator already absorbs the jumps — when one lands, measured
volatility rises and the distribution widens by itself, so fat tails count the
same effect twice. And a variance-matched t is fatter in the tails only by
being *narrower* in the middle: below about two sigma it is MORE confident than
the normal, by up to 4¢ at one sigma. Since a 15-minute contract's strike sits
at the opening price, essentially every observation lives inside two sigma. It
would have manufactured four cents of confidence — the size of the whole edge
threshold — out of a modelling choice.

The code is kept, tested, and switched off, with a test that fails if anyone
turns it on without explaining what changed.

**Sampling faster.** The standard error of a volatility estimate falls as
1/√(2n), so sampling three times as often should tighten it by 1.7×. Measured
across five seeds:

| Sampling | Mean Brier |
|---|---|
| 60s | 0.16262 |
| 30s | 0.16113 |
| 15s | 0.16076 |
| 10s | 0.16542 |

15s edges out 30s by 0.00038 — against a seed-to-seed spread of ±0.007. That
is noise, not signal, and a single-seed run showing an eight-times-larger
"improvement" is exactly how this kind of change gets shipped on nothing. Left
at 30s.

**What this actually means.** Three sophisticated upgrades, none of which
helped, is itself a finding: the model is already extracting close to
everything a price series contains. The accuracy left on the table is in data
quality, not model complexity — above all, whether the spot feed being read is
the same index Kalshi settles against. A persistent basis between the two puts
a constant error into `ln(S/K)` on every single read, and no amount of
distribution theory fixes it.

## Reading the contract's own rules beat every model change

The three model upgrades above all failed. Then the settlement rules were
looked up, and two things turned out to be wrong that had nothing to do with
mathematics.

**Kalshi does not settle on the final price. It settles on the average of the
final sixty seconds** of the CME CF Real-Time Index, sampled once per second.
The engine had been pricing a contract that settles on the last print. Those
are different instruments.

The correction is derivable, not fitted. With `h` the averaging window and
`tau` the seconds remaining, using Var(time-average of a Brownian path over h)
= σ²h/3:

```
tau > h:   Var(settlement) = σ²(tau − h) + σ²h/3 = σ²(tau − 2h/3)
```

So an average-settled contract has the same variance as a point-settled one
with **forty seconds less on the clock**:

| Time left | Effective | σ overstated by |
|---|---|---|
| 15 min | 860s | 2% |
| 5 min | 260s | 7% |
| 2 min | 80s | 18% |

Eighteen percent of σ, one sigma from the strike, is about five cents of
probability — the size of the entire edge threshold, and it was being given
away in one direction: the model thought the price had more time to come back
than it did, so it called fairly priced contracts overpriced.

The formula is checked against a Monte Carlo of the actual average rather than
believed, and scored against 4,000 simulated markets per seed with outcomes
settled the way Kalshi settles them. It wins **5 seeds out of 5**, and the
calibration shows where:

| Bucket | Ignoring the average | Knowing about it |
|---|---|---|
| 70–80% | says 74.9 → **79.0** happens | says 75.0 → **75.8** happens |
| 80–90% | says 84.9 → **87.2** happens | says 85.0 → **86.2** happens |

A 4.1-point error becomes 0.8, in the bucket where the engine actually trades.
The Brier gain is small in aggregate (~0.00035) because most observations sit
far from any decision, but it is perfectly consistent across seeds — unlike the
sampling-rate result, which flipped sign and was noise.

**The spot feed was reading venues outside the settlement index.** The CME CF
index is a volume-weighted median across Bitstamp, Coinbase, Gemini,
itBit/Paxos, Kraken, Bullish, Crypto.com and LMAX. The fallback chain included
Binance, which is not a constituent and quotes against a stablecoin rather than
dollars — a basis on top of a basis. Constituent venues are now preferred and
the others are labelled, with a test that fails if a non-constituent is ever
ordered ahead of one.

**The lesson worth keeping.** Three sophisticated model upgrades produced
nothing. Twenty minutes reading what the contract actually settles against
produced the only consistent improvement in this document. When a model is
wrong, the fault is more often in what is being modelled than in the
mathematics used to model it.

Sources: [Kalshi crypto settlement](https://help.kalshi.com/en/articles/13823838-crypto-markets),
[CME CF BRTI methodology](https://docs.cfbenchmarks.com/CME%20CF%20Real%20Time%20Indices%20Methodology.pdf),
[constituent exchanges](https://docs.cfbenchmarks.com/CME%20CF%20Constituent%20Exchanges.pdf).
