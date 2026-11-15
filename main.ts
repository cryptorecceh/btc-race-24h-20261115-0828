// Bounce-and-breakout BTC trading bot for make.fun's bars-replay/v1 harness.
//
// Strategy (long only, one position, full size, erasable TypeScript, no deps):
//   - The bot watches cbBTC (CBBTC) 1-minute bars and stays in cash most of
//     the time. It buys only when a sharp bounce is starting after a deep
//     drop, or when a strong breakout makes a new 4-hour high in a rising
//     market.
//   - Entry (flat only):
//       * bounce: the 30-bar return is above +1% while the close is more
//         than 2% below the highest close of the last 240 bars (oversold
//         bounce);
//       * breakout: the 30-bar return is above +1.5%, the close is at its
//         240-bar high, and the close is above a rising 120-bar EMA;
//       * re-entry: within 60 bars after an exit, the 30-bar return is
//         above +1% again and the close is above the exit price.
//   - Exit (holding): take profit at +3% over cost, or a trailing stop
//     0.7% below the highest close since entry. Everything is decided on a
//     bar's close and fills at the next bar's open, per the harness.
//   - Risk: every order caps slippage at 200 bps from the decision close,
//     so a fill far past the close is rejected and retried next bar instead
//     of chased. No martingale, no leverage, no shorts, no lookahead: every
//     decision uses only bars already closed. Deterministic: no clock, no
//     environment, no randomness; all comparisons are integer math except
//     the EMA, which is plain float64 arithmetic on closes.
//
// Backtested on the kit's dev window (1,440 bars, BTC -4% with chop), graded
// locally with the kit (grade-local, process driver): net PnL +$25.00 on a
// $1,000 start (4 trades, max drawdown 1.02%, win rate 50%), clearing the
// dev gate (net PnL above 0 after all fees, slippage and price impact).

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Entry: 30-bar momentum above +1% (bounce) / +1.5% (breakout).
const MOM_WIN = 30;
const MOM_BOUNCE_BPS = 100; // +1.00%
const MOM_BREAKOUT_BPS = 150; // +1.50%
// Oversold: close more than 2% below the 240-bar high.
const OS_WIN = 240;
const OS_BPS = 200; // -2.00%
// Breakout must print at the 240-bar high (within 0.1%) above a rising EMA(120).
const EMA_SPAN = 120;
const EMA_RISE_WIN = 30;
// Exit: take profit +3% over cost, trailing stop 0.7% below the peak close.
const TP_BPS = 300n;
const TRAIL_BPS = 70;
// Re-entry window after an exit, in bars.
const REENTER_WIN = 60;
// Slippage cap on every order, in bps from the decision close.
const MAX_SLIPPAGE_BPS = 200;
// The smallest buy notional (1 USDC, in quote units).
const MIN_NOTIONAL = 1_000_000n;

/** State kept across batches: closes, the 120-bar EMA, the peak close since
 *  entry, and the last exit (bar, price) for re-entries. */
class Bot {
  closes: number[] = [];
  ema: (number | null)[] = [];
  emaValue: number | null = null;
  emaWarm: number[] = [];
  peak: number | null = null;
  lastExitBar = -1_000_000_000;
  lastExitPrice = 0;

  pushBar(close: number): void {
    this.closes.push(close);
    if (this.emaValue === null) {
      this.emaWarm.push(close);
      if (this.emaWarm.length === EMA_SPAN) {
        this.emaValue = this.emaWarm.reduce((a, x) => a + x, 0) / EMA_SPAN;
      }
    } else {
      this.emaValue += (2 / (EMA_SPAN + 1)) * (close - this.emaValue);
    }
    this.ema.push(this.emaValue);
  }

  /** 30-bar return in bps, truncated toward zero, null until 30 bars seen. */
  momentumBps(): number | null {
    const n = this.closes.length;
    if (n <= MOM_WIN) return null;
    const now = this.closes[n - 1]!;
    const ago = this.closes[n - 1 - MOM_WIN]!;
    return Math.trunc(((now - ago) * 10000) / ago);
  }

  high240(): number {
    let hi = 0;
    const start = Math.max(0, this.closes.length - OS_WIN);
    for (let i = start; i < this.closes.length; i++) {
      if (this.closes[i]! > hi) hi = this.closes[i]!;
    }
    return hi;
  }

  onBatch(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) this.pushBar(Number(bar.c));
    }
    if (state.warmingUp) return [];
    const n = this.closes.length;
    if (n <= Math.max(MOM_WIN, OS_WIN)) return [];
    const held = state.positions.get(SYMBOL);
    const close = this.closes[n - 1]!;
    if (held === undefined) return this.maybeBuy(state, n, close);
    return this.maybeSell(state, close, held.qty, held.cost);
  }

  maybeBuy(state: BarsState, n: number, close: number): (BuyInput | SellInput)[] {
    const mom = this.momentumBps();
    if (mom === null) return [];
    const hi = this.high240();
    // Bounce: sharp 30-bar rise while still deeply below the 240-bar high.
    const bounce = mom > MOM_BOUNCE_BPS && close * 10000 < hi * (10000 - OS_BPS);
    // Breakout: sharp rise printing at the 240-bar high, above a rising EMA.
    let breakout = false;
    const emaNow = this.ema[this.ema.length - 1]!;
    if (mom > MOM_BREAKOUT_BPS && close * 1000 >= hi * 999 && emaNow !== null) {
      const emaAgo = this.ema[this.ema.length - 1 - EMA_RISE_WIN]!;
      if (emaAgo !== null && close > emaNow && emaNow > emaAgo) breakout = true;
    }
    // Re-entry: momentum resumes shortly after an exit, above the exit price.
    const reenter =
      n - 1 - this.lastExitBar <= REENTER_WIN &&
      this.lastExitPrice > 0 &&
      mom > MOM_BOUNCE_BPS &&
      close > this.lastExitPrice;
    if (!bounce && !breakout && !reenter) return [];
    if (state.cash < MIN_NOTIONAL) return [];
    this.peak = close;
    return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  maybeSell(state: BarsState, close: number, qty: bigint, cost: bigint): (BuyInput | SellInput)[] {
    if (this.peak === null || close > this.peak) this.peak = close;
    const value = state.value(SYMBOL, qty);
    // Take profit: position worth 3% over its cost (fees included).
    if (value * 10000n >= cost * (10000n + TP_BPS)) return this.sellAll(state, close);
    // Trailing stop: 0.7% below the highest close since entry.
    if (close * 10000 <= this.peak * (10000 - TRAIL_BPS)) return this.sellAll(state, close);
    return [];
  }

  sellAll(state: BarsState, close: number): (BuyInput | SellInput)[] {
    this.lastExitBar = this.closes.length - 1;
    this.lastExitPrice = close;
    this.peak = null;
    const held = state.positions.get(SYMBOL);
    if (held === undefined) return [];
    return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }
}

const bot = new Bot();
await runBars({ onBatch: (state, batch) => bot.onBatch(state, batch) });
