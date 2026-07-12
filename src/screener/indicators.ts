// Pure technical-indicator math over a chronological close-price series.
// No dependencies — unit-testable in plain Node.

/** Simple moving average of the last `period` values (null if too short). */
export function sma(values: number[], period: number): number | null {
  if (values.length < period) return null;
  let sum = 0;
  for (let i = values.length - period; i < values.length; i++) sum += values[i];
  return sum / period;
}

/** Full EMA series (same length as input); seeded with the SMA of the first `period`. */
export function emaSeries(values: number[], period: number): number[] {
  if (values.length === 0) return [];
  const k = 2 / (period + 1);
  const out: number[] = [];
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    if (i < period) {
      // seed region: running SMA up to i
      const slice = values.slice(0, i + 1);
      prev = slice.reduce((a, b) => a + b, 0) / slice.length;
    } else {
      prev = values[i] * k + prev * (1 - k);
    }
    out.push(prev);
  }
  return out;
}

export function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const s = emaSeries(values, period);
  return s[s.length - 1];
}

/** Wilder's RSI over `period` (default 14). Null if insufficient data. */
export function rsi(values: number[], period = 14): number | null {
  if (values.length < period + 1) return null;
  let gain = 0,
    loss = 0;
  // initial average over first `period` changes
  for (let i = 1; i <= period; i++) {
    const ch = values[i] - values[i - 1];
    if (ch >= 0) gain += ch;
    else loss -= ch;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  // Wilder smoothing for the rest
  for (let i = period + 1; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(ch, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-ch, 0)) / period;
  }
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

export interface Macd {
  macd: number;
  signal: number;
  histogram: number;
}

/** MACD (12,26,9). Null until there are enough points for the slow EMA + signal. */
export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): Macd | null {
  if (values.length < slow + signalPeriod) return null;
  const fastE = emaSeries(values, fast);
  const slowE = emaSeries(values, slow);
  const macdLine = values.map((_, i) => fastE[i] - slowE[i]);
  const signalE = emaSeries(macdLine, signalPeriod);
  const i = values.length - 1;
  return { macd: macdLine[i], signal: signalE[i], histogram: macdLine[i] - signalE[i] };
}
