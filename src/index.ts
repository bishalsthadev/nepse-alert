import { webhookCallback } from "grammy";
import type { Env } from "./env";
import { NepseClient } from "./nepse/client";
import { createBot } from "./bot/bot";
import { fullSnapshot, pollWatched } from "./alerts/engine";
import { runEod } from "./jobs/eod";
import { runMarketOpen } from "./jobs/open";
import { DASHBOARD_HTML } from "./web/dashboard";
import { Repo } from "./db/repo";
import { refreshNews } from "./jobs/news";
import { handleApi } from "./web/api";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Read-only web dashboard.
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response(DASHBOARD_HTML, {
        headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=60" },
      });
    }

    // Web JSON API (securities dropdown, portfolio, alerts — key-gated).
    const api = await handleApi(request, env, url);
    if (api) return api;

    // Public summary API for the dashboard. Served from a KV cache with a
    // cooldown so NEPSE is hit at most once per SUMMARY_TTL regardless of how
    // many browser tabs refresh — this is the fetch cooldown.
    if (url.pathname === "/api/summary") {
      const SUMMARY_TTL = 120; // seconds
      const cached = await env.CACHE.get("summary:v4");
      if (cached) {
        return new Response(cached, {
          headers: {
            "content-type": "application/json",
            "cache-control": `public, max-age=${SUMMARY_TTL}`,
            "x-cache": "hit",
          },
        });
      }
      const nepse = new NepseClient(env.CACHE);
      const repo = new Repo(env.DB);
      try {
        const [indices, marketStatus, movers, topLists] = await Promise.all([
          nepse.getNepseIndex().catch(() => []),
          nepse.getMarketStatus().catch(() => null),
          nepse.getTopMovers(5).catch(() => ({ gainers: [], losers: [] })),
          nepse.getTopLists(5).catch(() => ({ turnover: [], volume: [] })),
        ]);
        // News comes from D1 (populated by the EOD cron) — never scrape on a
        // dashboard hit unless the table is completely empty (first-ever load).
        let news = await repo.recentNews(12);
        if (news.length === 0) {
          await refreshNews(env).catch(() => {});
          news = await repo.recentNews(12);
        }
        const payload = JSON.stringify({ indices, marketStatus, movers, topLists, news });
        await env.CACHE.put("summary:v4", payload, { expirationTtl: SUMMARY_TTL });
        return new Response(payload, {
          headers: { "content-type": "application/json", "cache-control": `public, max-age=${SUMMARY_TTL}`, "x-cache": "miss" },
        });
      } catch (e) {
        return Response.json({ error: String(e) }, { status: 502 });
      }
    }

    // Telegram webhook. Path carries the secret; grammY also verifies the
    // X-Telegram-Bot-Api-Secret-Token header via secretToken.
    if (url.pathname === `/telegram/${env.TELEGRAM_WEBHOOK_SECRET}` && request.method === "POST") {
      const bot = createBot(env);
      await bot.init();
      const handle = webhookCallback(bot, "cloudflare-mod", {
        secretToken: env.TELEGRAM_WEBHOOK_SECRET,
      });
      return handle(request);
    }

    return new Response("not found", { status: 404 });
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    console.log(`cron fired: ${event.cron}`);
    const job = (async () => {
      switch (event.cron) {
        case "15 5 * * mon-fri": // market open — sync new listings + full snapshot
          console.log("runMarketOpen:", await runMarketOpen(env));
          break;
        case "15 9 * * mon-fri": // market close — full snapshot (closing prices)
          console.log("fullSnapshot:", await fullSnapshot(env));
          break;
        case "*/15 5-9 * * mon-fri": // in-hours — watched securities poll (every 15 min)
          console.log("pollWatched:", await pollWatched(env));
          break;
        case "30 9 * * mon-fri": // EOD — persist daily OHLC + news digest
          console.log("runEod:", await runEod(env));
          break;
        default:
          console.warn(`unhandled cron: ${event.cron}`);
      }
    })();
    ctx.waitUntil(job);
  },
};
