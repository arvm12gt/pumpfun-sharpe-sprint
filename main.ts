// Steady Sharpe: many small round trips, every hour alike.
//
// A pump.fun launch bot for the Sharpe Sprint (pumpfun-replay/v2). Ranked by
// HOURLY Sharpe over a 6-hour forward window, with a prize only for net PnL > 0
// and guardrails (>=20 distinct mints at >=0.01 SOL per round trip, <=5 open
// positions, max drawdown <=50%). The entry is executed twice and both action
// logs must match byte-for-byte, so this bot is fully deterministic: no random
// numbers, no wall clock, no iteration over anything but first-seen order.
//
// What the dev data (24h pump.fun sample, 2026-11-02/03) actually shows:
//   - The launch burst is over in ~2 slots. The first trade is the creator in
//     97% of launches (~1 SOL), then a handful of large buys spike the price
//     +15-50% and dump within ~10 slots. Buying after the spike is a losing
//     trade: median return from slot+2 onward is ~0% before fees for every
//     holding window, and only ~20% of coins beat the ~4.6% round-trip
//     friction at a 0.01 SOL stake.
//   - The coins that DO pay are the ones that launch quietly and get a second
//     wave of large buys 15-50 slots later. They are rare and cannot be told
//     apart at launch, so the edge is not picking them: it is refusing to pay
//     for the coins that already ran. Entry is only allowed while the price is
//     still within +11% of its create price, with a tight 2% buy slippage so a
//     fill that jumps in the 2-slot latency is refused for free.
//   - A fixed small take-profit (+10%) beats a trailing stop: the second wave
//     spikes and dumps within a couple of slots, so the sell must be decided
//     the moment the mark clears +10% and the fill lands near the wave's peak.
//     Letting it run gives the gain back to the dump.
//   - Stakes are capped at 1% of real reserve per buy, so the most a buy can
//     spend early is ~0.01-0.015 SOL. That is the counting size and the whole
//     position: one buy per mint, never re-bought, never averaged down.
//   - The creator selling is NOT an exit signal (the second wave often arrives
//     after the creator sells), but a coin the creator already sold before
//     entry is skipped.
//
// The result on the dev window is deliberately boring: ~150 round trips over
// 24h, ~30% win rate, PnL within a whisker of zero, drawdown ~0.2%. The point
// is not a big dev PnL (there is no big edge to find in this market for a
// 2-slot-latency taker) but the smallest possible variance per hour, so that
// the hourly Sharpe is not dragged down by the blow-ups that kill the
// momentum / sniper / reversion pilots (Sharpe -0.5 to -0.8, drawdowns up to
// 95%). Steady, small, and everywhere beats spiky and occasionally right.

import { runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const BPS = 10_000n;

// ---------------------------------------------------------------- parameters
// Chosen by stress-median Sharpe on the dev window (see README): a plateau,
// not a spike. Every parameter below was swept; the PnL surface is flat to
// within noise around zero, and these values sit in the middle of the flat
// region with the trip count comfortably above the 20-mint guardrail.
const P = {
  stakeLamports: 15_000_000n, // 0.015 SOL target per buy (cap usually binds first)
  minBuyLamports: 5_000_000n, // never send a buy smaller than 0.005 SOL
  minRealSolLamports: 500_000_000n, // need >=0.5 SOL real reserve to consider
  maxRealSolLamports: 30_000_000_000n, // above 30 SOL the early pump is over
  minTrades: 1, // at least one trade seen
  minBuyers: 2, // at least two distinct non-creator buyers
  minNetLamports: 300_000_000n, // >=0.3 SOL net inflow since create
  maxAge: 400, // first buy within 400 slots of create
  minUpBps: 0, // price vs create must be...
  maxUpBps: 1_100, // ...at most +11% (the core filter)
  tpBps: 1_000, // take profit +10% vs cost
  slBps: 800, // stop loss -8% vs cost
  maxHold: 200, // time-stop: exit after 200 slots held
  staleSlots: 60, // exit if no trade for 60 slots
  exitOnDevSell: false, // creator selling is not an exit (waves follow it)
  skipDevSold: true, // ...but never enter a coin the creator already sold
  buySlipBps: 200, // tight: refuse a buy that jumps >2% in the latency
  sellSlipBps: 10_000, // sells always go out
};

// ---------------------------------------------------------------- per-coin tape
interface TapeTrade {
  slot: number;
  isBuy: boolean;
  sol: bigint;
  user: Pubkey;
}

interface Coin {
  mint: Pubkey;
  creator: Pubkey;
  createdSlot: number;
  createVq: bigint;
  createVt: bigint;
  trades: TapeTrade[];
  buyers: Set<string>;
  netIn: bigint;
  lastTradeSlot: number;
  devSold: boolean;
  decided: boolean;
  complete: boolean;
}

interface Held {
  entrySlot: number;
}

export function createStrategy() {
  const coins = new Map<Pubkey, Coin>();
  const held = new Map<Pubkey, Held>();
  const pendingBuys = new Map<string, Pubkey>();
  const pendingSells = new Map<string, Pubkey>();
  let orderSeq = 0;

  function onCreate(e: Extract<Batch['events'][number], { event: 'CreateEvent' }>): void {
    if (coins.has(e.mint)) return;
    // Use the EVENT's own reserves: state.curves already folded this batch's
    // trades in, so the curve's reserves are the post-trade ones.
    coins.set(e.mint, {
      mint: e.mint,
      creator: e.creator,
      createdSlot: e.slot,
      createVq: BigInt(e.virtual_quote_reserves),
      createVt: BigInt(e.virtual_token_reserves),
      trades: [],
      buyers: new Set<string>(),
      netIn: 0n,
      lastTradeSlot: e.slot,
      devSold: false,
      decided: false,
      complete: false,
    });
  }

  function onTrade(state: BotState, e: Extract<Batch['events'][number], { event: 'TradeEvent' }>): void {
    let c = coins.get(e.mint);
    if (c === undefined) {
      // Curve seen first through a trade: synthesise from current reserves.
      const curve = state.curves.get(e.mint);
      c = {
        mint: e.mint,
        creator: e.creator,
        createdSlot: e.slot,
        createVq: curve ? curve.virtual_quote_reserves : BigInt(e.virtual_quote_reserves),
        createVt: curve ? curve.virtual_token_reserves : BigInt(e.virtual_token_reserves),
        trades: [],
        buyers: new Set<string>(),
        netIn: 0n,
        lastTradeSlot: e.slot,
        devSold: false,
        decided: false,
        complete: false,
      };
      coins.set(e.mint, c);
    }
    const sol = BigInt(e.sol_amount);
    c.trades.push({ slot: e.slot, isBuy: e.is_buy, sol, user: e.user });
    if (c.trades.length > 128) c.trades.splice(0, c.trades.length - 128);
    c.netIn += e.is_buy ? sol : -sol;
    if (e.is_buy && e.user !== c.creator) c.buyers.add(e.user);
    if (!e.is_buy && e.user === c.creator) c.devSold = true;
    c.lastTradeSlot = e.slot;
  }

  function onFills(batch: Batch): void {
    for (const f of batch.fills) {
      if (f.status !== 'filled') {
        // A refused buy (e.g. slippage) leaves the coin undecided: it may be
        // retried on a later batch while it still qualifies.
        const mint = pendingBuys.get(f.client_id);
        if (mint !== undefined) {
          pendingBuys.delete(f.client_id);
          const c = coins.get(mint);
          if (c !== undefined) c.decided = false;
        }
        pendingSells.delete(f.client_id);
        continue;
      }
      const buyMint = pendingBuys.get(f.client_id);
      if (buyMint !== undefined) {
        pendingBuys.delete(f.client_id);
        // First fill of a position starts its hold clock.
        if (!held.has(buyMint)) held.set(buyMint, { entrySlot: batch.slot });
        continue;
      }
      const sellMint = pendingSells.get(f.client_id);
      if (sellMint !== undefined) pendingSells.delete(f.client_id);
    }
  }

  function tryExits(state: BotState, batch: Batch, orders: OrderInput[]): void {
    const caps = state.hello.caps;
    for (const [mint, pos] of state.positions) {
      if (orders.length >= caps.max_orders_per_batch) return;
      // Don't double-sell while a sell on this mint is still pending.
      let pendingSell = false;
      for (const po of state.pending.values()) {
        if (po.order.mint === mint && po.order.side === 'sell') {
          pendingSell = true;
          break;
        }
      }
      if (pendingSell) continue;
      const h = held.get(mint);
      const curve = state.curves.get(mint);
      if (curve === undefined) continue;
      if (curve.complete) continue; // the harness closes it
      const cost = pos.cost_lamports;
      if (cost === 0n) continue;
      // Mark value: tokens held at the current curve price.
      const value = (pos.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
      const diffBps = ((value - cost) * BPS) / cost;
      let reason = '';
      if (diffBps >= BigInt(P.tpBps)) reason = 'tp';
      else if (diffBps <= -BigInt(P.slBps)) reason = 'sl';
      else if (h !== undefined && batch.slot - h.entrySlot >= P.maxHold) reason = 'hold';
      else if (h !== undefined && P.exitOnDevSell) {
        const c = coins.get(mint);
        if (c !== undefined && c.devSold) reason = 'devsell';
      }
      if (reason === '') {
        const c = coins.get(mint);
        if (c !== undefined && batch.slot - c.lastTradeSlot >= P.staleSlots) reason = 'stale';
      }
      if (reason === '') continue;
      held.delete(mint);
      const cid = `s${++orderSeq}`;
      pendingSells.set(cid, mint);
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: P.sellSlipBps, client_id: cid });
    }
  }

  function tryBuys(state: BotState, batch: Batch, orders: OrderInput[]): void {
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();
    for (const e of batch.events) {
      if (orders.length >= caps.max_orders_per_batch || slots <= 0) return;
      if (e.event !== 'TradeEvent' && e.event !== 'CreateEvent') continue;
      const c = coins.get(e.mint);
      if (c === undefined || c.decided || c.complete) continue;
      const curve = state.curves.get(e.mint);
      if (curve === undefined || curve.complete) {
        c.decided = true;
        continue;
      }
      const age = batch.slot - c.createdSlot;
      if (age > P.maxAge) {
        c.decided = true;
        continue;
      }
      if (c.trades.length < P.minTrades) continue;
      if (c.buyers.size < P.minBuyers) continue;
      if (c.netIn < P.minNetLamports) continue;
      if (P.skipDevSold && c.devSold) {
        c.decided = true;
        continue;
      }
      if (curve.real_quote_reserves < P.minRealSolLamports) continue;
      if (curve.real_quote_reserves > P.maxRealSolLamports) {
        c.decided = true;
        continue;
      }
      // Price rise vs create, in bps (cross-multiplied to stay in integers).
      const nowVq = curve.virtual_quote_reserves;
      const nowVt = curve.virtual_token_reserves;
      if (nowVt === 0n || c.createVt === 0n) continue;
      const upBps = ((nowVq * c.createVt - c.createVq * nowVt) * BPS) / (c.createVq * nowVt);
      if (upBps < BigInt(P.minUpBps) || upBps > BigInt(P.maxUpBps)) continue;
      const cap = state.maxBuyLamports(e.mint);
      if (cap < P.minBuyLamports) continue;
      const amount = cap < P.stakeLamports ? cap : P.stakeLamports;
      if (free < amount + tx) continue;
      c.decided = true;
      const cid = `b${++orderSeq}`;
      pendingBuys.set(cid, e.mint);
      orders.push({ side: 'buy', mint: e.mint, quote_lamports: amount, max_slippage_bps: P.buySlipBps, client_id: cid });
      free -= amount + tx;
      slots -= 1;
    }
  }

  function onBatch(state: BotState, batch: Batch): OrderInput[] {
    onFills(batch);
    for (const e of batch.events) {
      if (e.event === 'CreateEvent') onCreate(e);
      else if (e.event === 'TradeEvent') onTrade(state, e);
      else if (e.event === 'CompleteEvent') {
        const c = coins.get(e.mint);
        if (c !== undefined) c.complete = true;
        held.delete(e.mint);
      }
    }
    const orders: OrderInput[] = [];
    tryExits(state, batch, orders);
    tryBuys(state, batch, orders);
    return orders;
  }

  return { onBatch };
}

const strategy = createStrategy();

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
