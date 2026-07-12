// End-of-day job: persist today's OHLC into daily_ohlc (the screener's history).
// Screener execution and news digest are layered on in their own steps.

import type { Env } from "../env";
import { Repo } from "../db/repo";
import { NepseClient } from "../nepse/client";
import { newsDigest } from "./news";

export async function runEod(env: Env): Promise<{ stored: number; freshNews: number }> {
  const nepse = new NepseClient(env.CACHE);
  const repo = new Repo(env.DB);
  const market = await nepse.getMarketStatus();

  const rows = await nepse.getTodayPrices(market.id);
  const date = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kathmandu" }))
    .toISOString()
    .slice(0, 10);

  const ohlc = rows
    .filter((r) => r.symbol && Number.isFinite(r.ltp))
    .map((r) => ({
      symbol: r.symbol.toUpperCase(),
      date: r.businessDate?.slice(0, 10) ?? date,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.ltp,
      volume: r.volume,
    }));

  await repo.upsertDailyOhlc(ohlc);

  // News digest (best-effort — never let it block OHLC persistence).
  let freshNews = 0;
  try {
    freshNews = (await newsDigest(env)).fresh;
  } catch (e) {
    console.error("newsDigest failed:", e);
  }
  // TODO: run technical screener (its own step).
  return { stored: ohlc.length, freshNews };
}
