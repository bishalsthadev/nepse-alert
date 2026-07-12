// Alert engine: fetch latest prices, evaluate active rules, dispatch Telegram
// messages with dedupe. Invoked from the scheduled (cron) handler.

import { Api } from "grammy";
import type { Env } from "../env";
import { Repo } from "../db/repo";
import { NepseClient, type LivePrice } from "../nepse/client";

const COOLDOWN_MS = 4 * 60 * 60 * 1000; // don't re-fire the same rule within 4h

function pct(p: LivePrice): number {
  return p.previousClose ? ((p.ltp - p.previousClose) / p.previousClose) * 100 : 0;
}

function ruleFires(type: string, threshold: number, p: LivePrice): boolean {
  switch (type) {
    case "price_above":
      return p.ltp >= threshold;
    case "price_below":
      return p.ltp <= threshold;
    case "pct_change":
      return Math.abs(pct(p)) >= threshold;
    case "volume_spike":
      return p.volume >= threshold;
    default:
      return false; // ma_cross handled at EOD (needs history)
  }
}

function describe(type: string, threshold: number, symbol: string, p: LivePrice): string {
  const ltp = p.ltp.toFixed(2);
  switch (type) {
    case "price_above":
      return `🔔 *${symbol}* rose above ${threshold} — LTP *${ltp}*`;
    case "price_below":
      return `🔔 *${symbol}* fell below ${threshold} — LTP *${ltp}*`;
    case "pct_change":
      return `🔔 *${symbol}* moved ${pct(p).toFixed(2)}% (≥${threshold}%) — LTP *${ltp}*`;
    case "volume_spike":
      return `🔔 *${symbol}* volume ${p.volume.toLocaleString()} (≥${threshold}) — LTP *${ltp}*`;
    default:
      return `🔔 *${symbol}* — LTP *${ltp}*`;
  }
}

/** Evaluate all active rules for the symbols we have fresh prices for. */
export async function evaluateAlerts(env: Env, prices: Map<string, LivePrice>): Promise<number> {
  const repo = new Repo(env.DB);
  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  const symbols = [...prices.keys()];
  const rules = await repo.activeAlertsForSymbols(symbols);

  let fired = 0;
  for (const rule of rules) {
    const p = prices.get(rule.symbol.toUpperCase());
    if (!p || !Number.isFinite(p.ltp)) continue;
    if (!ruleFires(rule.type, rule.threshold, p)) continue;

    // Dedupe via cooldown.
    if (rule.last_triggered_at) {
      const age = Date.now() - Date.parse(rule.last_triggered_at + "Z");
      if (age < COOLDOWN_MS) continue;
    }

    const chatId = await repo.chatIdFor(rule.telegram_id);
    if (!chatId) continue;
    const msg = describe(rule.type, rule.threshold, rule.symbol, p);
    try {
      await api.sendMessage(chatId, msg, { parse_mode: "Markdown" });
      await repo.markAlertTriggered(rule.id);
      await repo.logAlert(rule.telegram_id, rule.id, msg);
      fired++;
    } catch (e) {
      console.error(`sendMessage failed for rule ${rule.id}:`, e);
    }
  }
  return fired;
}

/** Poll just the watched securities (every 30 min during market hours). */
export async function pollWatched(env: Env): Promise<{ polled: number; fired: number }> {
  const repo = new Repo(env.DB);
  const nepse = new NepseClient(env.CACHE);
  const symbols = await repo.allWatchedSymbols();
  if (symbols.length === 0) return { polled: 0, fired: 0 };

  const market = await nepse.getMarketStatus();
  const prices = new Map<string, LivePrice>();
  for (const symbol of symbols) {
    const id = await repo.getSecurityId(symbol);
    if (id === null) continue;
    const d = await nepse.getSecurityDetail(id, market.id);
    if (d && d.symbol) {
      const key = d.symbol.toUpperCase();
      prices.set(key, d);
      await env.CACHE.put(`price:${key}`, JSON.stringify(d), { expirationTtl: 3600 });
    }
  }
  const fired = await evaluateAlerts(env, prices);
  return { polled: prices.size, fired };
}

/** Full-market snapshot (market open & close). Bulk endpoint; falls back to watched-only. */
export async function fullSnapshot(env: Env): Promise<{ count: number; fired: number }> {
  const nepse = new NepseClient(env.CACHE);
  const market = await nepse.getMarketStatus();
  let rows: LivePrice[] = [];
  try {
    rows = await nepse.getTodayPrices(market.id);
  } catch (e) {
    console.error("bulk today-price failed, falling back to watched poll:", e);
    const r = await pollWatched(env);
    return { count: r.polled, fired: r.fired };
  }

  const prices = new Map<string, LivePrice>();
  for (const r of rows) {
    if (!r.symbol) continue;
    const key = r.symbol.toUpperCase();
    prices.set(key, r);
    await env.CACHE.put(`price:${key}`, JSON.stringify(r), { expirationTtl: 3600 });
  }
  const fired = await evaluateAlerts(env, prices);
  return { count: prices.size, fired };
}
