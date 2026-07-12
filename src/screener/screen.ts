// Technical screening over accumulated daily_ohlc history.
import { Repo } from "../db/repo";
import { sma, rsi, macd } from "./indicators";

export interface Analysis {
  symbol: string;
  bars: number;
  close: number | null;
  rsi: number | null;
  sma20: number | null;
  sma50: number | null;
  macdHist: number | null;
  signals: string[];
}

/** Compute indicators + human-readable signals for one symbol's series. */
export function analyze(symbol: string, closes: number[]): Analysis {
  const close = closes.length ? closes[closes.length - 1] : null;
  const r = rsi(closes, 14);
  const s20 = sma(closes, 20);
  const s50 = sma(closes, 50);
  const m = macd(closes);
  const signals: string[] = [];

  if (r !== null) {
    if (r < 30) signals.push(`RSI ${r.toFixed(0)} — oversold`);
    else if (r > 70) signals.push(`RSI ${r.toFixed(0)} — overbought`);
  }
  if (close !== null && s20 !== null) {
    signals.push(close >= s20 ? "above SMA20" : "below SMA20");
  }
  if (close !== null && s50 !== null && s20 !== null) {
    if (s20 > s50) signals.push("SMA20 > SMA50 (bullish)");
    else signals.push("SMA20 < SMA50 (bearish)");
  }
  if (m) signals.push(m.histogram >= 0 ? "MACD bullish" : "MACD bearish");

  return { symbol, bars: closes.length, close, rsi: r, sma20: s20, sma50: s50, macdHist: m?.histogram ?? null, signals };
}

/** Analyze one symbol from its stored history. */
export async function analyzeSymbol(repo: Repo, symbol: string): Promise<Analysis> {
  const hist = await repo.ohlcHistory(symbol, 250);
  return analyze(symbol.toUpperCase(), hist.map((h) => h.close));
}

/** Screen a set of symbols, returning only those with a notable signal. */
export async function runScreen(repo: Repo, symbols: string[]): Promise<Analysis[]> {
  const out: Analysis[] = [];
  for (const sym of symbols) {
    const a = await analyzeSymbol(repo, sym);
    // "Notable" = RSI extreme or a MACD/SMA regime signal, and enough history.
    if (a.bars >= 20 && a.signals.some((s) => /oversold|overbought/.test(s))) out.push(a);
  }
  return out;
}
