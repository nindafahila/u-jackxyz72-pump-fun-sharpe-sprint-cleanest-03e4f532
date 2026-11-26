// Sharpe Sprint paper bot — pump.fun replay v2 (agent-fun/replay/v2).
//
// A small deterministic momentum bot. It reads the harness stream on stdin
// (newline-delimited JSON: one "hello", then "batch" messages, then "done")
// and answers every batch with one "reply" carrying its "orders" for that
// batch, echoing the batch "seq". No network, no secrets, no dependencies.
//
// Strategy, in one paragraph: watch every mint's bonding-curve price
// (virtual SOL reserves / virtual token reserves). A mint becomes a
// candidate once it has real trading activity (several trades and net buy
// volume). Buy a small fixed slice of capital when the price has risen a
// few percent over its recent window while buyers are still active —
// momentum with confirmation, not chasing a single tick. Every position
// carries a take-profit, a stop-loss and a trailing exit from its peak,
// plus a maximum holding age, so losers are cut and winners are banked.
// Position sizes are small and capped by the harness limits, which keeps
// the equity curve smooth — exactly what an hourly Sharpe ratio rewards.
//
// All state is rebuilt from the stream itself: fills and the account
// snapshot in each batch are authoritative, so the bot never drifts from
// what the harness actually executed.

import * as readline from "node:readline";

// ---- Tunables (fractions are plain numbers, everything deterministic) ----
const BUY_FRACTION_OF_CAPITAL = 0.02; // 2% of starting capital per buy
const MIN_TRADES = 8; // trades seen before a mint is tradable
const LOOKBACK_TRADES = 20; // window for the momentum comparison
const MOMENTUM_MIN = 0.04; // buy only if price is up >= 4% over window
const TAKE_PROFIT = 0.20; // sell at +20% vs entry
const STOP_LOSS = 0.10; // sell at -10% vs entry
const TRAIL_DROP = 0.08; // sell if price falls 8% from the peak held
const MAX_HOLD_BATCHES = 600; // sell whatever is left after this many batches
const MAX_SLIPPAGE_BPS = 100; // 1%

// ---- Types for the wire messages (subset of protocol.schema.json) ----
type Hello = {
  type: "hello";
  capital: { lamports: string };
  caps: {
    max_open_positions: number;
    max_order_bps_of_real_reserve: number;
    max_orders_per_batch: number;
  };
};

type TradeEvent = {
  event: "TradeEvent";
  mint: string;
  sol_amount: string;
  is_buy: boolean;
  virtual_sol_reserves: string;
  virtual_token_reserves: string;
  real_sol_reserves: string;
};

type CreateEvent = {
  event: "CreateEvent";
  mint: string;
  virtual_sol_reserves: string;
  virtual_token_reserves: string;
  real_token_reserves: string;
};

type Batch = {
  type: "batch";
  seq: number;
  slot: number;
  events: Array<TradeEvent | CreateEvent | Record<string, unknown>>;
  marks?: Array<{
    mint: string;
    virtual_token_reserves: string;
    virtual_quote_reserves: string;
    real_token_reserves: string;
    real_quote_reserves: string;
  }>;
  fills?: Array<{
    client_id: string;
    mint: string;
    side: "buy" | "sell";
    status: "filled" | "rejected" | "failed";
    quote_lamports: string;
    token_amount: string;
  }>;
  account?: {
    cash_lamports: string;
    positions: Array<{ mint: string; token_amount: string; cost_lamports: string }>;
  };
};

type Order =
  | {
      side: "buy";
      client_id: string;
      mint: string;
      quote_lamports: string;
      max_slippage_bps: number;
    }
  | {
      side: "sell";
      client_id: string;
      mint: string;
      token_amount: string;
      max_slippage_bps: number;
    };

// ---- Per-mint market state ----
type MintState = {
  prices: number[]; // price history, lamports per token (bounded window)
  trades: number;
  buyVolumeLamports: bigint;
  sellVolumeLamports: bigint;
  realSolReserves: bigint;
  completed: boolean;
};

type Position = {
  mint: string;
  tokens: bigint;
  costLamports: bigint;
  entryPrice: number;
  peakPrice: number;
  entryBatch: number;
};

const mints = new Map<string, MintState>();
const positions = new Map<string, Position>();

let capitalLamports = 0n;
let cashLamports = 0n;
let maxOpenPositions = 5;
let maxOrderBps = 500;
let maxOrdersPerBatch = 10;
let batchIndex = 0;
let orderCounter = 0;

function priceOf(virtualSol: string, virtualTokens: string): number {
  const sol = Number(virtualSol);
  const tok = Number(virtualTokens);
  if (!tok || !sol) return 0;
  return sol / tok;
}

function mintState(mint: string): MintState {
  let s = mints.get(mint);
  if (!s) {
    s = {
      prices: [],
      trades: 0,
      buyVolumeLamports: 0n,
      sellVolumeLamports: 0n,
      realSolReserves: 0n,
      completed: false,
    };
    mints.set(mint, s);
  }
  return s;
}

function recordPrice(mint: string, price: number): void {
  if (!price || !Number.isFinite(price)) return;
  const s = mintState(mint);
  s.prices.push(price);
  if (s.prices.length > LOOKBACK_TRADES + 1) s.prices.shift();
}

function applyFills(batch: Batch): void {
  for (const f of batch.fills ?? []) {
    if (f.status !== "filled") continue;
    const pos = positions.get(f.mint);
    if (f.side === "buy") {
      if (pos) {
        pos.tokens += BigInt(f.token_amount);
        pos.costLamports += BigInt(f.quote_lamports);
      } else {
        const s = mintState(f.mint);
        const entry = s.prices.length ? s.prices[s.prices.length - 1] : 0;
        positions.set(f.mint, {
          mint: f.mint,
          tokens: BigInt(f.token_amount),
          costLamports: BigInt(f.quote_lamports),
          entryPrice: entry,
          peakPrice: entry,
          entryBatch: batchIndex,
        });
      }
    } else if (pos) {
      pos.tokens -= BigInt(f.token_amount);
      if (pos.tokens <= 0n) positions.delete(f.mint);
    }
  }
}

function reconcileAccount(batch: Batch): void {
  if (!batch.account) return;
  cashLamports = BigInt(batch.account.cash_lamports);
  const seen = new Set<string>();
  for (const p of batch.account.positions) {
    seen.add(p.mint);
    const pos = positions.get(p.mint);
    const tokens = BigInt(p.token_amount);
    if (tokens <= 0n) continue;
    if (pos) {
      pos.tokens = tokens;
      pos.costLamports = BigInt(p.cost_lamports);
    } else {
      const s = mintState(p.mint);
      const entry = s.prices.length ? s.prices[s.prices.length - 1] : 0;
      positions.set(p.mint, {
        mint: p.mint,
        tokens,
        costLamports: BigInt(p.cost_lamports),
        entryPrice: entry,
        peakPrice: entry,
        entryBatch: batchIndex,
      });
    }
  }
  for (const mint of [...positions.keys()]) {
    if (!seen.has(mint)) positions.delete(mint);
  }
}

// Decide the orders for one batch. Buys first (new momentum), then exits
// for anything held that hit a target, a stop, a trailing drop or old age.
function decide(batch: Batch): Order[] {
  const orders: Order[] = [];
  const push = (o: Order): boolean => {
    if (orders.length >= maxOrdersPerBatch) return false;
    orders.push(o);
    return true;
  };

  // Exits: scan held positions against the latest mark price.
  for (const pos of [...positions.values()]) {
    const s = mints.get(pos.mint);
    const price = s?.prices.length ? s.prices[s.prices.length - 1] : 0;
    if (!price || pos.tokens <= 0n) continue;
    if (price > pos.peakPrice) pos.peakPrice = price;
    const ret = pos.entryPrice ? price / pos.entryPrice - 1 : 0;
    const fromPeak = price / pos.peakPrice - 1;
    const age = batchIndex - pos.entryBatch;
    if (
      ret >= TAKE_PROFIT ||
      ret <= -STOP_LOSS ||
      fromPeak <= -TRAIL_DROP ||
      age >= MAX_HOLD_BATCHES
    ) {
      if (
        push({
          side: "sell",
          client_id: `s-${batch.seq}-${orderCounter++}`,
          mint: pos.mint,
          token_amount: pos.tokens.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        })
      ) {
        // Assume the sell goes through so we do not re-order it next batch;
        // the fills/account in the next batch correct this if it did not.
        positions.delete(pos.mint);
      }
    }
  }

  // Entries: strongest momentum first, while slots and cash allow.
  if (positions.size < maxOpenPositions && cashLamports > 0n) {
    const candidates: Array<{ mint: string; momentum: number; price: number }> = [];
    for (const [mint, s] of mints) {
      if (s.completed || positions.has(mint)) continue;
      if (s.trades < MIN_TRADES) continue;
      if (s.buyVolumeLamports <= s.sellVolumeLamports) continue;
      if (s.prices.length < LOOKBACK_TRADES + 1) continue;
      const now = s.prices[s.prices.length - 1];
      const then = s.prices[0];
      if (!then) continue;
      const momentum = now / then - 1;
      if (momentum >= MOMENTUM_MIN) candidates.push({ mint, momentum, price: now });
    }
    candidates.sort((a, b) => b.momentum - a.momentum);
    for (const c of candidates) {
      if (positions.size >= maxOpenPositions) break;
      if (orders.length >= maxOrdersPerBatch) break;
      const s = mints.get(c.mint)!;
      let size = (capitalLamports * BigInt(Math.round(BUY_FRACTION_OF_CAPITAL * 10000))) / 10000n;
      const reserveCap = (s.realSolReserves * BigInt(maxOrderBps)) / 10000n;
      if (reserveCap > 0n && reserveCap < size) size = reserveCap;
      if (size > cashLamports) size = cashLamports;
      if (size <= 0n) continue;
      if (
        push({
          side: "buy",
          client_id: `b-${batch.seq}-${orderCounter++}`,
          mint: c.mint,
          quote_lamports: size.toString(),
          max_slippage_bps: MAX_SLIPPAGE_BPS,
        })
      ) {
        // Reserve the cash and the slot locally; fills correct this later.
        cashLamports -= size;
        positions.set(c.mint, {
          mint: c.mint,
          tokens: 0n,
          costLamports: size,
          entryPrice: c.price,
          peakPrice: c.price,
          entryBatch: batchIndex,
        });
      }
    }
  }
  return orders;
}

function handleBatch(batch: Batch): void {
  batchIndex += 1;
  for (const ev of batch.events ?? []) {
    if (ev.event === "TradeEvent") {
      const t = ev as TradeEvent;
      const s = mintState(t.mint);
      s.trades += 1;
      const amt = BigInt(t.sol_amount);
      if (t.is_buy) s.buyVolumeLamports += amt;
      else s.sellVolumeLamports += amt;
      s.realSolReserves = BigInt(t.real_sol_reserves);
      recordPrice(t.mint, priceOf(t.virtual_sol_reserves, t.virtual_token_reserves));
    } else if (ev.event === "CreateEvent") {
      const c = ev as CreateEvent;
      // A new mint: seed its price so momentum can be measured from birth.
      recordPrice(c.mint, priceOf(c.virtual_sol_reserves, c.virtual_token_reserves));
    } else if (ev.event === "CompleteEvent") {
      const m = (ev as { mint?: string }).mint;
      if (m) mintState(m).completed = true;
    }
  }
  for (const m of batch.marks ?? []) {
    const s = mintState(m.mint);
    s.realSolReserves = BigInt(m.real_quote_reserves);
    recordPrice(m.mint, priceOf(m.virtual_quote_reserves, m.virtual_token_reserves));
  }
  applyFills(batch);
  reconcileAccount(batch);
  const orders = decide(batch);
  process.stdout.write(JSON.stringify({ type: "reply", seq: batch.seq, orders }) + "\n");
}

async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let msg: { type?: string };
    try {
      msg = JSON.parse(line) as { type?: string };
    } catch {
      continue;
    }
    if (msg.type === "hello") {
      const h = msg as unknown as Hello;
      capitalLamports = BigInt(h.capital.lamports);
      cashLamports = capitalLamports;
      maxOpenPositions = h.caps.max_open_positions;
      maxOrderBps = h.caps.max_order_bps_of_real_reserve;
      maxOrdersPerBatch = h.caps.max_orders_per_batch;
    } else if (msg.type === "batch") {
      handleBatch(msg as unknown as Batch);
    } else if (msg.type === "done") {
      break;
    }
  }
}

main().catch(() => process.exit(1));
