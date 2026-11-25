# Steady Sharpe — Pump.fun Sharpe Sprint

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/arvm12gt/pumpfun-sharpe-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/arvm12gt/pumpfun-sharpe-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

A trading bot for the [Pump.fun Sharpe Sprint](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) on make.fun: a 6-hour pump.fun forward replay, ranked by **hourly Sharpe**, prize only for net PnL > 0.

## Idea

Most entrants chase momentum or buy everything equal-weight. The dev data says both lose: the launch burst is over in ~2 slots (the creator buys ~1 SOL in 97% of launches, a handful of large buys spike the price +15–50% and dump within ~10 slots), and the median return from slot+2 onward is ~0% before fees for every holding window. Only ~20% of coins beat the ~4.6% round-trip friction at a 0.01 SOL stake.

The coins that do pay launch quietly and get a second wave of large buys 15–50 slots later. They cannot be told apart at launch, so this bot does not try to pick them — it refuses to pay for the coins that already ran:

- **Enter only while the price is within +11% of its create price**, with ≥0.5 SOL real reserve, ≥2 distinct non-creator buyers, ≥0.3 SOL net inflow, and the creator not yet sold. (+11%, not +10%: at +10% the 20-mint guardrail fails in a quiet 6h block of the dev window — 15.8 counted mints vs 20 required — while +11% lifts the worst block to ~20.6; +12% costs far more Sharpe than it buys in safety.)
- **Tight 2% buy slippage**: a fill that jumps in the 2-slot latency is refused for free — a spike filter, not a cost.
- **One buy per mint, ~0.015 SOL** (the 1%-of-real-reserve cap binds first), never re-bought, never averaged down, never held to curve completion.
- **Fixed exits: +10% take-profit, −8% stop-loss, 200-slot time-stop.** A trailing stop loses to the fixed TP here — the second wave spikes and dumps within a couple of slots, so the sell must be decided the moment the mark clears +10% and the fill lands near the wave's peak.
- **Creator selling is not an exit** (the second wave often arrives after the creator sells), but a coin the creator already sold before entry is skipped.

## Results (dev window, `grade-local --driver process`)

| metric | this bot | sniper pilot | momentum pilot | reversion pilot | equal-weight |
|---|---|---|---|---|---|
| net PnL (SOL) | **−0.0056** | −0.50 | −9.44 | −3.99 | −0.019 |
| hourly Sharpe | **−0.058** | −0.84 | −0.58 | −0.48 | −0.22 |
| max drawdown | 0.23% | 5.4% | 95% | 49% | — |
| win rate | ~30% | 12.7% | 6.7% | 26.8% | — |
| round trips / distinct mints | 175 / 175 | 354 / 354 | 80 / 48 | 425 / — | 5 / 5 |
| counted round trips (≥0.01 SOL) | 116 | 270 | — | — | — |

Deliberately boring: ~175 round trips over 24h, PnL within a whisker of zero, drawdown ~0.2%. There is no big edge to find in this market for a 2-slot-latency taker; the point is the smallest possible variance per hour, so the hourly Sharpe is not dragged down by the blow-ups that kill the pilots. (At +10% entry cap the dev PnL is +0.0010 SOL with Sharpe +0.013, but the 20-mint guardrail fails in the quietest 6h block of the dev window — 15.8 counted mints — so +11% is the chosen compromise. Stress test: 20/20 rebuilt copies of the dev window lose money, median −0.042 SOL — the dev result is a top-decile draw and the true expectation is slightly negative; the final 6h window is a fresh draw, and this bot is still far ahead of every pilot on Sharpe and PnL.)

## Layout

- `main.ts` — the whole strategy (self-authored, fully deterministic: no randomness, no wall clock, first-seen iteration order only).
- `vendor/makefun-bot.ts` — byte-for-byte copy of the kit's `sdk/ts/makefun-bot.ts` (authorship-exempt shim).
- `.makefun/owner.json` — entry wallet.

## Run

The grader runs `node /bot/main.ts` (Node 22+). Local grading: `node cli/makefun.mjs grade-local --kit . --bot <repo> --driver process` from inside the kit.
