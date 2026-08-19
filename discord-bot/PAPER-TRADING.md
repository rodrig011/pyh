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

## A fourth attempt, and what it actually taught

**HAR: volatility at three time scales.** The strongest known result in
realized-volatility forecasting (Corsi 2009), and for a good reason — volatility
is made by traders on different horizons, and one exponential decay cannot
represent three of them at once. Built, and scored across five seeds:

| World | HAR (plain) | HAR (jump-robust) |
|---|---|---|
| Smooth | wins 4/5 | loses 5/5 |
| Vol clustering | wins 4/5 | loses 4/5 |
| Clustering + jumps | **loses 5/5** | loses 5/5 |

Neither version wins everywhere, and the pattern is the interesting part.

Plain HAR loses whenever jumps are present, because the estimator it replaces
was already jump-robust and switching threw that away. So make HAR jump-robust
— and it gets *worse*, while its estimate of σ gets measurably *better*
(15.1 vs 16.7 of error).

Better estimate, worse forecast. That combination is the finding:

**Jump-robust estimation is the wrong tool for pricing a digital.** Bipower
variation deliberately excludes jump variance, so it measures the *diffusive*
volatility well — and the contract's outcome includes the jumps. For "will it
finish above the strike" you need the total variance the price will actually
experience, not the well-behaved part of it. The error metric was measuring the
wrong target and the Brier score was right.

**And the honest place to stop.** That insight raises a real question: is the
incumbent estimator's use of bipower hurting it? Measured, the plainest
realized volatility beat every alternative in all four simulated worlds. It was
not adopted, because that result is almost certainly an artefact: this
simulator's volatility reverts to a level its author chose, which
mechanically rewards a long average. Real bitcoin holds a regime for hours
without reverting to anything. Changing production on that basis would be
fitting the model to the simulator's assumptions, which is the exact error
every other section of this document was written to avoid.

So the question is handed to the data instead. The recorder now stores what
**all six** estimators said at the moment they said it — blend, EWMA, plain
realized, bipower, HAR, robust HAR — and `rankEstimators` scores them against
settled markets, clustered by market, refusing to name a winner unless it beats
the runner-up by more than the noise between them. A fortnight of real contracts
decides it, not an argument.

Running total: seven ideas built and measured, one shipped. The one that
shipped came from reading the contract's rules.

---

## "It skips every single market"

The report, from someone running the bot live: every market refused, including
in paper mode, at every price, all day.

The obvious diagnosis is that the thresholds are too strict, and the obvious
fix is to lower them. Both are wrong, and it is worth writing down why, because
this is the second time an "it is too conservative" complaint turned out to be
something else.

### First: re-measure the threshold, because the engine is not the one I swept

`minimumEdgeCents: 6` was chosen against an engine that had no settlement
averaging, no executable pricing, no spread, and different exit rules. That
measurement was stale, so it was run again — five seeds, 200 markets each,
2¢ spread.

| Threshold | Fair market | Biased +4¢ |
|---|---|---|
| 2¢ | 193 trades, **−7.6%** | 649 trades, +11.3% |
| 4¢ | 179 trades, **−6.1%** | 604 trades, +11.1% |
| 6¢ | 44 trades, **−2.1%** | 364 trades, +19.7% |
| 8¢ | 5 trades, **−0.1%** | 113 trades, +8.7% |

Against a market that is never wrong, loosening the bar costs money
monotonically, and it does not buy anything against a biased one either. Six
stays.

### The trap in the jumpy world, which said the opposite

Run the same sweep in a world with jumps and clustering, and a 2¢ threshold
appears to make **+38%** against +26% at six. That is the result that would
have justified loosening the bar, and it is entirely false.

In those worlds the "fair" price has no closed form, so the simulated market
prices itself by Monte Carlo — and a Monte Carlo price carries sampling noise.
Noise *is* mispricing. The engine was not finding an edge; it was reading the
simulator's own error bars.

The test: run a world whose honest answer is known to be **exactly zero edge**,
priced through the same noisy pricer.

| Pricing paths | Trades | Return (truth is 0%) |
|---|---|---|
| 300 | 1322 | **+40.8%** |
| 3000 | 462 | **−4.8%** |

Ten times less pricing noise, and a 40% "profit" becomes a small loss. Every
low-threshold jumpy-world result in this document's history is that artefact.
A backtest can only be trusted to the precision of the opponent it is graded
against.

### The actual cause: the bot was reading one strike out of a dozen

Kalshi does not list *one* fifteen-minute bitcoin contract. It lists a **ladder**
— a dozen strikes spaced around spot, all closing at the same bell. The bot
called `currentContract()`, which returns whichever market closes soonest, and
formed its entire opinion of the window from that one strike.

So it was refusing a board of twelve markets on the evidence of one, and the
one was effectively picked at random — usually already so far in or out of the
money that no price on it was worth paying. Every individual refusal was
correct. The conclusion drawn from them was not.

Measured on a simulated ladder, same edge threshold, nothing loosened:

| Strikes read | Windows with a call (fair) | Windows with a call (biased +4¢) |
|---|---|---|
| 1 | 3% | **36%** |
| 3 | 8% | 68% |
| 5 | 9% | **76%** |
| 9 | 9% | 77% |
| 15 | 9% | 77% |

Reading the board doubles the share of windows with a signal where money is
actually available, and it saturates by five strikes — past that they are all
priced out anyway, so there is nothing clever to do about *which* part of the
board to read. Read all of it.

Note the fair-market column moves too, 3% to 9%. Those extra calls are the
vol estimate's own noise firing more often, and they are a genuine cost. The
biased column gains six times more, which is the trade being made.

### An eighth idea, measured and rejected

The `priced_out` gate asks "would being right pay enough at this price?" and
reads the **YES** price to answer it — before a side has been chosen. On a
market quoted 93 that refuses the trade, while the trade actually on the table
is the NO side at seven cents, which is not expensive at all. It fires on 19%
of all looks.

Moving it after the side selection, so it tests the price actually being paid,
is plainly the more coherent version. Measured across seven seeds against a
standing 6¢ mispricing:

| | Before | After |
|---|---|---|
| Bias +6¢ | +139.9% | **+102.9%** |
| Bias −6¢ | +88.9% | **+41.2%** |

Sweeping `minimumEntryCents` (4 → 20) and `maximumEntryCents` (80 → 96)
afterwards changed nothing, so the loss is not the entry band. The mechanism is
that the early refusal deliberately returns *without* a probability, and the
exit logic reads a probability-free skip as "no opinion, keep holding".
Supplying one makes the scalp rules bank winners early at exactly the prices
where a winning position sits.

Reverted. The tidier version is the more expensive one, and the coupling it
exposed belongs to `scalp.js`.

### What shipped

- **`openBoard()` / `readBoard()`** — the whole ladder, every strike evaluated,
  ranked by edge remaining *after* fees.
- **A refusal census.** "Refused 41 markets" cannot distinguish a fair market
  from a dead price feed. "Refused 41: 30× no edge, 8× priced out, 3× thin book"
  can, and it is now in the paper report and in `/picks read`.
- **`boardIsUnreadable()`** — the one refusal that was explicitly asked to stay.
  When most of the ladder is refused for `trending` / `vol_uncertain` / `no_vol`,
  that is one condition showing up a dozen times, not a dozen opinions, and the
  strike that slipped through is a false positive. Stand aside.
- **Positions remember their own strike.** With a ladder, "whatever strike the
  feed lists now" is a different contract on almost every tick, and settling
  against it grades the trade on a bet that was never placed.

The recorder was deliberately **not** widened to the board. Ten strikes at one
instant share a spot, a volatility and a window, so they are nowhere near ten
independent observations — the clustered standard errors elsewhere in this
document are the same point — and the quote log has a fixed capacity, so the
only thing widening it would reliably buy is ten times less history.

Running total: eight ideas built and measured, two shipped. Neither of the two
was a cleverer model. One came from reading the contract's settlement rules,
and one from noticing the engine was only being shown a twelfth of the market.

---

## Reading the first real edge measurement, and three ways it was lying

85 settled markets, 2404 observations. The output:

```
Market's forecast score: 0.1903
Model's forecast score:  0.1907
❌ The market is the better forecaster. There is no edge here to trade.
Gross per contract taken: +1.84¢ across 1721 trade(s).
```

Read literally that says: stop. All three of those lines were misleading, and
none of the fixes make the news better — they make it *honest*, which at 85
markets means "not yet known" rather than "no".

### 1. A defeat was declared on a sign, with no error bar

The gap is **0.0004**. The branch printing "the market is the better
forecaster" fired on `mean <= 0` with no interval attached — while the branch
directly above it correctly refused to call a *positive* gap a win without one.

Demanding proof for good news and taking bad news for free is not caution. It
is a bias, and at four ten-thousandths over 85 clustered markets it retires a
strategy on a coin flip. Both verdicts now require the same significance test,
and a genuine defeat is still printed in exactly those words.

The regression test for the old behaviour was passing for the wrong reason. Its
fixture packed forty markets into forty seconds, so their 60-second settlement
windows all overlapped, every market graded identically, and model and market
scored **0.4100 each — a gap of exactly zero**. The assertion matched because
an exact tie counted as a defeat. Fixture repaired to encode what its name
claims; a second test now pins the tie case explicitly.

### 2. "+1.84¢ across 1721 trades" describes a strategy the bot will not run

The gate on that figure was `edge > 0` — any positive edge, down to a
hundredth of a cent. It fired on **1721 of 1805** rows, 95% of everything
observed. The engine requires **6¢**, plus a worst-case volatility edge, plus a
spread and book test. It takes about 4%.

So the number was being compared against the ~2¢ fee to conclude "a loss in a
nice hat" — comparing the fee against the wrong population entirely. Both bars
are now reported side by side, and the engine's own threshold is imported from
`DEFAULTS` rather than restated, because a measurement of "what would this have
made" that uses a different threshold from the thing being measured is not a
measurement of it.

It remains an **upper bound**: the quote log stores no book depth and no trend
fit, so `thin_book`, `wide_spread` and `trending` cannot be replayed from it.

### 3. The evidence was collected from strikes the engine refuses on sight

The worst of the three. The recorder called `currentContract()`, which returns
the market closing soonest — and a dozen strikes in one window all close at the
same instant, so it returned whichever the exchange listed *first*. That is a
fixed position on the ladder, not a fixed distance from the money.

The tell was in the numbers all along: a Brier of 0.19 is *low*. Near-the-money
contracts sit near 50/50 and score around 0.25. A population scoring 0.19 is
one where the outcomes are already mostly decided — strikes quoted at 3¢ and
96¢, which the engine rejects as `priced_out` without a second thought.

So 85 markets of evidence had been gathered about contracts the bot does not
trade, to answer the question of whether the contracts it *does* trade are
mispriced. The recorder now takes the strike nearest a coin flip.

Deliberately still **one** strike per sample. Recording the whole board would
multiply the writes by twelve for observations sharing a spot, a volatility and
a window — nowhere near twelve independent facts, by the same clustering
argument used everywhere else in this document — and the quote log has a fixed
capacity of 20,000, so the reliable purchase would be twelve times less history.

### What the measurement actually says right now

Nothing, and that is the correct answer at this sample size. The model and the
market are separated by 0.0004 with an interval that swallows it whole; the
market shows no significant bias; and the population sampled so far was the
wrong one. The counter effectively restarts against near-the-money strikes.

Both forecasters scoring under 0.25 does mean neither is worse than a coin.
That is the only claim the data supports.

Running total: eight ideas built and measured, two shipped — and one
measurement that had to be repaired three times before it was worth reading.
The recurring lesson is unchanged: the bugs are in what gets measured and what
gets shown, not in the arithmetic.

---

## "2100 markets in 6 hours" — the counter was counting the wrong thing

Reported from a live run, and the arithmetic gives it away immediately:

```
sweep every 10s × 6 hours = 2,160 ticks
what the bot reported     = 2,100 "markets"
```

The paper account added one to `seen` **per sweep**, not per contract. A
fifteen-minute market sitting in view gets looked at about ninety times, so a
couple of dozen contracts were reported as two thousand.

Two things followed from that, and both were reported as separate bugs:

- **The reset looked broken.** It worked — the number just climbed back into
  the hundreds within minutes of being zeroed, which is indistinguishable from
  a reset that never happened.
- **Every refusal ratio was meaningless.** "Refused 2,090 of 2,100" is one
  handful of markets refused ninety times each.

A contract is now counted **once**, when it rolls off the board, carrying
whatever the last verdict on it was — and a contract that was *ever* tradeable
is never booked as a refusal, because being refused near the bell is normal and
says nothing about the call that was made earlier. The raw sweep count is still
shown beside it, so the old inflated figure is recognisable for what it was.

The board is now also read on every tick rather than only while flat. It costs
nothing, and contracts expire whether or not the account happens to be holding
one; counting them only while flat reports a fraction of the day as the whole
of it.

A gap this exposed: the single-market path had no ticker at all, so it was never
counted. The strike stands in when the feed does not name the contract.

## Two profiles, and what the aggressive one actually costs

Trading harder was asked for repeatedly, so it is built — and measured rather
than argued about. Seven seeds, 200 markets each, 2¢ spread.

| Profile | World | Trades | Return |
|---|---|---|---|
| careful | fair (no edge exists) | 63 | **−4.2%** |
| careful | biased +4¢ | 480 | **+6.6%** |
| scalp | fair (no edge exists) | 389 | **−13.4%** |
| scalp | biased +4¢ | 1056 | **+34.4%** |

`scalp` halves the edge required (3¢ not 6¢), drops the pessimistic-volatility
test to break-even, doubles the Kelly portion and the size cap, enters a minute
from the bell instead of two, and banks a move sooner.

The result is not "better" or "worse" — it is **leverage on a question that is
not yet answered**. Six times the trades, and:

- if Kalshi is efficient, it bleeds **three times faster** (−13.4% vs −4.2%)
- if Kalshi is genuinely mispriced, it makes **five times more** (+34.4% vs +6.6%)

Which of those happens depends entirely on the `/picks edge` measurement, and
that measurement currently says "not yet known" over a population that was being
sampled wrongly until this week.

Which is the whole argument for putting it in the **paper** account and nowhere
else. Imaginary money is exactly what an unanswered question of this shape is
for, and being cautious with imaginary money learns nothing. `scalp` is now the
default there; `careful` is one option away.

Running total: nine ideas built and measured, three shipped.

---

## The signals panel, and what "high success rate" can honestly mean

Three things were asked for together: a panel that pushes notifications instead
of waiting to be asked, a whale alert tied to flip risk, and a high success rate.
The first two are engineering. The third is worth being precise about, because
it is the one that can be faked.

### The whale reading was decoration

`largePrints()` had lived in the indicators for weeks and had **never been given
a single trade**. Every call site passed `trades: []`. It computed a lean from an
empty array and reported zero, forever.

It now reads the exchange's own trade tape. That choice matters: a whale in BTC
spot is interesting, but a whale in *this contract* is what moves the price being
traded. Somebody lifting four hundred contracts on the NO side is a statement
about this fifteen-minute window in a way a spot print an exchange away is not.

`taker_side` is what gets counted — the side that crossed the spread. A resting
order that got hit was not making a statement; the order that reached across was.

### Flip risk is two independent things, kept separate

- **The arithmetic**: `flipProbability`, already computed by the engine — the
  chance the price touches the strike again before the bell. On a 15-minute
  binary that is roughly **twice** the chance of finishing on the wrong side,
  which is the most counter-intuitive number in the whole system and the reason
  people sell winners in a wobble.
- **The pressure**: size crossing the spread *against* the side held.

They are reported separately because they fail differently, and size on your own
side reduces the risk score rather than being spun as confirmation. A whale is
evidence about pressure, never about outcome, and every line says so.

### On the success rate

It is **reported, never promised**, and there is only one honest lever for
raising it: **stay quiet when unsure**. That does not make the model better — it
makes the bot silent about the cases where it is least sure, and that is exactly
what a high hit rate is made of.

So the bar to *interrupt a room* is deliberately higher than the bar to *answer a
question*:

| | Bar |
|---|---|
| `/picks read` answers | whatever the engine says, refusals included |
| An alert posts | only tradeable, **≥4¢ net** after spread and both fees |
| A whale posts alone | **≥1000 contracts**, lean ≥0.6, labelled "not a trade call" |

Plus: one alert per contract *ever* — a market announced twice is a market
somebody enters twice — and never two alerts within three minutes, so a volatile
hour cannot flood the channel.

Four cents net against the engine's six-cent gross bar is not a second number
pulled from the air: the engine's threshold is gross edge against the price, and
this one is what survives the spread and both fees, so a signal clearing six
gross can easily be under four net.

The panel prints the **measured** record with its sample size attached, and says
outright that anything under about thirty settled calls is noise rather than a
track record. A panel claiming a win rate is worth nothing; a panel showing the
real one, including when it is bad, is the only version that survives a member
who is counting.

### A collision worth recording

The new subcommand was first called `/picks panel` — which already existed, as
the analyst console, and had for months. The router branches in order, so the
old handler won and the new one was unreachable dead code that every unit test
passed straight through. It only surfaced because a test drove the *router*
rather than the function. Renamed to `/picks signals`.

Running total: ten ideas built and measured, four shipped.

---

## "Scalp 10% on every market" — the arithmetic, in full

Asked for directly and repeatedly: always recommend a side, always target about
ten percent. It is a genuinely different bet from the rest of this engine, so it
gets its own arithmetic rather than an opinion.

### Why the win rate has to be so absurdly high

A +10% target pays **a tenth of the stake**. A miss, on a binary held to the
bell, costs **all of it**. That asymmetry is the whole trade:

| Entry | Break-even win rate at +10% |
|---|---|
| 25¢ | 100% |
| 40¢ | 100% |
| 50¢ | 98.0% |
| 65¢ | 96.3% |
| 80¢ | 94.1% |

Ten wins per loss just to stand still, before the exchange is paid.

### What the odds actually are

The chance of *touching* a target is roughly **twice** the chance of finishing
beyond it — the reflection principle, and the most useful fact in the file. So
scalp targets do get hit far more often than people expect. Just not enough:

| Time left | Entry | Touches +10% | Needs | |
|---|---|---|---|---|
| 12 min | 30¢ | 66% | 100% | ❌ |
| 12 min | 50¢ | 90% | 98% | ❌ |
| 5 min | 50¢ | 90% | 98% | ❌ |

Expected value on a 40¢ entry: **−4.74¢ per contract**, about −12% per trade.

### "Then cut the loser at −10% instead of holding it to zero"

This is the obvious repair and it does not work either, for a reason that is
not a matter of tuning. **A Kalshi price IS a probability, and a probability is
a martingale.** Optional stopping says that if you exit at either barrier, the
probability of hitting the up one first is exactly the fraction that makes the
expectation zero — here, exactly 50%.

So symmetric ±10% is a genuine coin flip, and you pay the fee both ways:

- 40¢ entry: 0.5·(+10%) + 0.5·(−10%) − 10.0% fee = **−10.0% per trade**
- 80¢ entry: 0.5·(+10%) + 0.5·(−10%) − 3.8% fee = **−3.8% per trade**

No take-profit rule, no stop, no combination of the two has positive expectancy
on a fairly priced contract. Only being right about the price does.

### The one genuinely actionable finding, and it is backwards

Kalshi's fee is `0.07·P·(1−P)` per contract, so **as a share of the stake it is
`0.07·(1−P)`** — which *falls* as the contract gets more expensive:

| Price | Round-trip fee, as % of stake |
|---|---|
| 15¢ | **13.3%** |
| 25¢ | 16.0% |
| 40¢ | 10.0% |
| 65¢ | 6.2% |
| 80¢ | **3.8%** |

A ten percent target on a 15¢ lottery ticket is under water before the price
moves at all. The same target on an 80¢ contract clears the fee nearly three
times over. **The instinct to scalp the cheap side — more room to run, bigger
percentage swings — is exactly backwards once the exchange is paid.**
`cheapestToScalp()` returns the expensive side, and the name is deliberate.

### What shipped

`/picks read` now gives a scalp recommendation on **every** market, whatever the
engine decided about trading it: the side, the entry, the +10% exit, the real
touch probability, the break-even rate, and a one-line verdict —

- **worth taking** — odds clear the bar AND the model has an edge behind it
- **coin flip** — odds clear the bar but nothing is driving it
- **against you** — the odds do not clear the bar, and repeating this loses

The recommendation is always there, which is what was asked for. The numbers are
always next to it, which is what stops it being a lie.

Running total: eleven ideas built and measured, four shipped.
