import { Bot } from "grammy";
import type { Env } from "../env";
import { Repo } from "../db/repo";
import { NepseClient } from "../nepse/client";
import { resolveSecurityId, syncSecurities } from "../nepse/sync";
import { refreshNews } from "../jobs/news";
import { analyzeSymbol, runScreen } from "../screener/screen";

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const HELP = `*NEPSE Alert* — commands:

*Prices & watchlist*
/price SYMBOL — latest price (e.g. /price NABIL)
/watch SYMBOL · /unwatch SYMBOL · /watchlist

*Alerts*
/alert SYMBOL above|below PRICE — e.g. /alert NABIL above 500
/alert SYMBOL pct PERCENT — move ≥ PERCENT% either way
/alerts — list your alerts
/delalert ID — delete an alert

*Portfolio*
/buy SYMBOL QTY PRICE — record a holding
/portfolio — holdings + live value
/pnl — profit/loss summary
/sell LOT-ID — remove a holding lot (id from /portfolio)

*News & analysis*
/news — latest NEPSE headlines
/ta SYMBOL — technical indicators (RSI, SMA, MACD)
/screen — scan your watchlist for RSI extremes

/help — this message`;

const ALERT_TYPES: Record<string, string> = {
  above: "price_above",
  below: "price_below",
  pct: "pct_change",
  volume: "volume_spike",
};

export function createBot(env: Env): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN);
  const repo = new Repo(env.DB);
  const nepse = new NepseClient(env.CACHE);

  // Personal-deployment guard: if OWNER_TELEGRAM_ID is set, ignore everyone else.
  bot.use(async (ctx, next) => {
    const owner = env.OWNER_TELEGRAM_ID;
    if (owner && String(ctx.from?.id) !== owner) return; // silently drop
    await next();
  });

  // Register the user on any interaction so we can deliver alerts to their chat.
  bot.use(async (ctx, next) => {
    if (ctx.from && ctx.chat) {
      await repo.upsertUser({
        telegram_id: ctx.from.id,
        chat_id: ctx.chat.id,
        username: ctx.from.username ?? null,
      });
    }
    await next();
  });

  bot.command("start", (ctx) => ctx.reply(HELP, { parse_mode: "Markdown" }));
  bot.command("help", (ctx) => ctx.reply(HELP, { parse_mode: "Markdown" }));

  bot.command("price", async (ctx) => {
    const symbol = (ctx.match ?? "").trim().toUpperCase();
    if (!symbol) return ctx.reply("Usage: /price SYMBOL — e.g. /price NABIL");

    const id = await resolveSecurityId(symbol, nepse, repo);
    if (id === null) return ctx.reply(`Unknown symbol: ${symbol}`);

    const market = await nepse.getMarketStatus();
    const d = await nepse.getSecurityDetail(id, market.id);
    if (!d) return ctx.reply(`Couldn't fetch price for ${symbol}.`);

    const chg = d.ltp - d.previousClose;
    const pct = d.previousClose ? (chg / d.previousClose) * 100 : 0;
    const arrow = chg > 0 ? "🟢▲" : chg < 0 ? "🔴▼" : "⚪";
    await ctx.reply(
      `*${symbol}*  ${arrow}\n` +
        `LTP: *${d.ltp.toFixed(2)}*  (${chg >= 0 ? "+" : ""}${chg.toFixed(2)}, ${pct.toFixed(2)}%)\n` +
        `Open ${d.open.toFixed(2)} · High ${d.high.toFixed(2)} · Low ${d.low.toFixed(2)}\n` +
        `Prev close ${d.previousClose.toFixed(2)} · Vol ${d.volume.toLocaleString()}\n` +
        `Market: ${market.isOpen}`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("watch", async (ctx) => {
    const symbol = (ctx.match ?? "").trim().toUpperCase();
    if (!symbol) return ctx.reply("Usage: /watch SYMBOL");
    const id = await resolveSecurityId(symbol, nepse, repo);
    if (id === null) return ctx.reply(`Unknown symbol: ${symbol}`);
    await repo.addWatch(ctx.from!.id, symbol);
    await ctx.reply(`👀 Watching *${symbol}*`, { parse_mode: "Markdown" });
  });

  bot.command("unwatch", async (ctx) => {
    const symbol = (ctx.match ?? "").trim().toUpperCase();
    if (!symbol) return ctx.reply("Usage: /unwatch SYMBOL");
    await repo.removeWatch(ctx.from!.id, symbol);
    await ctx.reply(`Removed *${symbol}* from watchlist`, { parse_mode: "Markdown" });
  });

  bot.command("watchlist", async (ctx) => {
    const list = await repo.listWatch(ctx.from!.id);
    if (list.length === 0) return ctx.reply("Your watchlist is empty. Add one with /watch SYMBOL");
    await ctx.reply(`*Your watchlist:*\n${list.map((s) => `• ${s}`).join("\n")}`, {
      parse_mode: "Markdown",
    });
  });

  // --- alerts ---
  bot.command("alert", async (ctx) => {
    const parts = (ctx.match ?? "").trim().split(/\s+/);
    if (parts.length < 3) {
      return ctx.reply("Usage: /alert SYMBOL above|below|pct|volume VALUE\ne.g. /alert NABIL above 500");
    }
    const symbol = parts[0].toUpperCase();
    const type = ALERT_TYPES[parts[1].toLowerCase()];
    const value = Number(parts[2]);
    if (!type) return ctx.reply("Type must be one of: above, below, pct, volume");
    if (!Number.isFinite(value)) return ctx.reply("VALUE must be a number.");

    const id = await resolveSecurityId(symbol, nepse, repo);
    if (id === null) return ctx.reply(`Unknown symbol: ${symbol}`);

    const alertId = await repo.addAlert(ctx.from!.id, symbol, type, value);
    await repo.addWatch(ctx.from!.id, symbol); // ensure it's polled
    await ctx.reply(`✅ Alert #${alertId} set: *${symbol}* ${parts[1].toLowerCase()} ${value}`, {
      parse_mode: "Markdown",
    });
  });

  bot.command("alerts", async (ctx) => {
    const rules = await repo.listAlerts(ctx.from!.id);
    if (rules.length === 0) return ctx.reply("No alerts. Add one with /alert SYMBOL above PRICE");
    const label: Record<string, string> = {
      price_above: "above",
      price_below: "below",
      pct_change: "pct",
      volume_spike: "volume",
    };
    const lines = rules.map(
      (r) => `#${r.id} ${r.symbol} ${label[r.type] ?? r.type} ${r.threshold}${r.active ? "" : " (off)"}`,
    );
    await ctx.reply(`*Your alerts:*\n${lines.join("\n")}`, { parse_mode: "Markdown" });
  });

  bot.command("delalert", async (ctx) => {
    const id = Number((ctx.match ?? "").trim());
    if (!Number.isInteger(id)) return ctx.reply("Usage: /delalert ID (see /alerts)");
    const ok = await repo.deleteAlert(ctx.from!.id, id);
    await ctx.reply(ok ? `Deleted alert #${id}` : `No alert #${id} found.`);
  });

  // --- portfolio ---
  bot.command("buy", async (ctx) => {
    const parts = (ctx.match ?? "").trim().split(/\s+/);
    if (parts.length < 3) return ctx.reply("Usage: /buy SYMBOL QTY PRICE — e.g. /buy NABIL 10 480");
    const symbol = parts[0].toUpperCase();
    const qty = Number(parts[1]);
    const price = Number(parts[2]);
    if (!Number.isFinite(qty) || !Number.isFinite(price) || qty <= 0) {
      return ctx.reply("QTY and PRICE must be positive numbers.");
    }
    const id = await resolveSecurityId(symbol, nepse, repo);
    if (id === null) return ctx.reply(`Unknown symbol: ${symbol}`);
    await repo.addLot(ctx.from!.id, symbol, qty, price);
    await ctx.reply(`📌 Recorded: ${qty} × *${symbol}* @ ${price}`, { parse_mode: "Markdown" });
  });

  bot.command("sell", async (ctx) => {
    const id = Number((ctx.match ?? "").trim());
    if (!Number.isInteger(id)) return ctx.reply("Usage: /sell LOT_ID (see /portfolio)");
    const ok = await repo.deleteLot(ctx.from!.id, id);
    await ctx.reply(ok ? `Removed lot #${id}` : `No lot #${id} found.`);
  });

  bot.command("portfolio", async (ctx) => {
    const lots = await repo.listPortfolio(ctx.from!.id);
    if (lots.length === 0) return ctx.reply("Empty portfolio. Add with /buy SYMBOL QTY PRICE");
    const market = await nepse.getMarketStatus();

    // Latest price per symbol (KV cache first, then live).
    const ltpFor = new Map<string, number>();
    for (const lot of lots) {
      if (ltpFor.has(lot.symbol)) continue;
      const cached = await env.CACHE.get(`price:${lot.symbol}`);
      if (cached) {
        ltpFor.set(lot.symbol, JSON.parse(cached).ltp);
      } else {
        const sid = await repo.getSecurityId(lot.symbol);
        const d = sid ? await nepse.getSecurityDetail(sid, market.id) : null;
        ltpFor.set(lot.symbol, d?.ltp ?? 0);
      }
    }

    let cost = 0,
      value = 0;
    const lines = lots.map((l) => {
      const ltp = ltpFor.get(l.symbol) ?? 0;
      const c = l.quantity * l.buy_price;
      const v = l.quantity * ltp;
      cost += c;
      value += v;
      const pl = v - c;
      const sign = pl >= 0 ? "+" : "";
      return `#${l.id} ${l.symbol}: ${l.quantity} @ ${l.buy_price} → ${ltp.toFixed(2)} (${sign}${pl.toFixed(2)})`;
    });
    const totalPl = value - cost;
    const totalPct = cost ? (totalPl / cost) * 100 : 0;
    await ctx.reply(
      `*Portfolio*\n${lines.join("\n")}\n\n` +
        `Cost ${cost.toFixed(2)} · Value *${value.toFixed(2)}*\n` +
        `P/L ${totalPl >= 0 ? "🟢+" : "🔴"}${totalPl.toFixed(2)} (${totalPct.toFixed(2)}%)`,
      { parse_mode: "Markdown" },
    );
  });

  bot.command("pnl", async (ctx) => {
    const lots = await repo.listPortfolio(ctx.from!.id);
    if (lots.length === 0) return ctx.reply("Empty portfolio.");
    const market = await nepse.getMarketStatus();
    let cost = 0,
      value = 0;
    const seen = new Map<string, number>();
    for (const l of lots) {
      let ltp = seen.get(l.symbol);
      if (ltp === undefined) {
        const cached = await env.CACHE.get(`price:${l.symbol}`);
        if (cached) {
          ltp = Number(JSON.parse(cached).ltp) || 0;
        } else {
          const sid = await repo.getSecurityId(l.symbol);
          const d = sid ? await nepse.getSecurityDetail(sid, market.id) : null;
          ltp = d?.ltp ?? 0;
        }
        seen.set(l.symbol, ltp);
      }
      cost += l.quantity * l.buy_price;
      value += l.quantity * ltp;
    }
    const pl = value - cost;
    const pct = cost ? (pl / cost) * 100 : 0;
    await ctx.reply(
      `*P/L:* ${pl >= 0 ? "🟢 +" : "🔴 "}${pl.toFixed(2)} (${pct.toFixed(2)}%)\nCost ${cost.toFixed(2)} → Value ${value.toFixed(2)}`,
      { parse_mode: "Markdown" },
    );
  });

  // --- news ---
  bot.command("news", async (ctx) => {
    let items = await repo.recentNews(10);
    if (items.length === 0) {
      // Cold start: scrape on demand.
      await refreshNews(env);
      items = await repo.recentNews(10);
    }
    if (items.length === 0) return ctx.reply("No news right now — try again shortly.");
    const emoji: Record<string, string> = { dividend: "💰", ipo: "📢", agm: "📅", news: "📰" };
    const body = items
      .map((i) => `${emoji[i.category] ?? "📰"} <a href="${i.url}">${escapeHtml(i.title)}</a>`)
      .join("\n\n");
    await ctx.reply(`<b>Latest NEPSE news</b>\n\n${body}`, {
      parse_mode: "HTML",
      link_preview_options: { is_disabled: true },
    });
  });

  // --- technical analysis / screener ---
  bot.command("ta", async (ctx) => {
    const symbol = (ctx.match ?? "").trim().toUpperCase();
    if (!symbol) return ctx.reply("Usage: /ta SYMBOL — e.g. /ta NABIL");
    const a = await analyzeSymbol(repo, symbol);
    if (a.bars === 0) {
      return ctx.reply(
        `No price history stored for ${symbol} yet. History builds up from each market close — check back after a few trading days.`,
      );
    }
    const fmt = (n: number | null, d = 2) => (n === null ? "—" : n.toFixed(d));
    await ctx.reply(
      `*${symbol}* — technicals (${a.bars} bars)\n` +
        `Close ${fmt(a.close)} · RSI ${fmt(a.rsi, 0)}\n` +
        `SMA20 ${fmt(a.sma20)} · SMA50 ${fmt(a.sma50)}\n` +
        `MACD hist ${fmt(a.macdHist, 3)}\n\n` +
        (a.signals.length ? a.signals.map((s) => `• ${s}`).join("\n") : "No notable signals."),
      { parse_mode: "Markdown" },
    );
  });

  bot.command("screen", async (ctx) => {
    const syms = await repo.listWatch(ctx.from!.id);
    if (syms.length === 0) {
      return ctx.reply("Add symbols to your watchlist first (/watch SYMBOL), then /screen looks for RSI extremes.");
    }
    const hits = await runScreen(repo, syms);
    if (hits.length === 0) {
      return ctx.reply(
        "No RSI extremes in your watchlist right now (or history is still accumulating — needs ~20 trading days per symbol).",
      );
    }
    const body = hits.map((a) => `*${a.symbol}* — ${a.signals.join(", ")}`).join("\n");
    await ctx.reply(`*Screener hits:*\n${body}`, { parse_mode: "Markdown" });
  });

  // Admin: force a securities master-list sync.
  bot.command("sync", async (ctx) => {
    const n = await syncSecurities(nepse, repo);
    await ctx.reply(`Synced ${n} securities.`);
  });

  return bot;
}
