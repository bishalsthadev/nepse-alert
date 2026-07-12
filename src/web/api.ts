// JSON API for the web app. Market data is public; portfolio & alerts are
// personal and gated by WEB_ACCESS_KEY (maps to the owner's Telegram id).

import type { Env } from "../env";
import { Repo } from "../db/repo";
import { NepseClient, type LivePrice } from "../nepse/client";
import { resolveSecurityId, syncSecurities } from "../nepse/sync";

const ALERT_TYPES = new Set(["price_above", "price_below", "pct_change", "volume_spike"]);

function authOwner(request: Request, env: Env): number | null {
  const key = request.headers.get("x-access-key") ?? "";
  if (!env.WEB_ACCESS_KEY || key.length === 0 || key !== env.WEB_ACCESS_KEY) return null;
  const id = Number(env.OWNER_TELEGRAM_ID);
  return Number.isFinite(id) ? id : null;
}

async function ltpFor(env: Env, nepse: NepseClient, repo: Repo, symbol: string, marketId: number): Promise<number> {
  const cached = await env.CACHE.get(`price:${symbol}`);
  if (cached) return Number((JSON.parse(cached) as LivePrice).ltp) || 0;
  const sid = await repo.getSecurityId(symbol);
  const d = sid ? await nepse.getSecurityDetail(sid, marketId) : null;
  return d?.ltp ?? 0;
}

/** Returns a Response if it handles the path, else null so the Worker falls through. */
export async function handleApi(request: Request, env: Env, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/")) return null;

  const repo = new Repo(env.DB);
  const nepse = new NepseClient(env.CACHE);

  // --- public: daily price history for a symbol (charts) ---
  if (p === "/api/history" && request.method === "GET") {
    const symbol = (url.searchParams.get("symbol") ?? "").toUpperCase();
    if (!symbol) return Response.json({ error: "symbol required" }, { status: 400 });
    const cacheKey = `hist:${symbol}`;
    const cached = await env.CACHE.get(cacheKey);
    if (cached) {
      return new Response(cached, {
        headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
      });
    }
    const sid = await resolveSecurityId(symbol, nepse, repo);
    if (sid === null) return Response.json({ error: `unknown symbol ${symbol}` }, { status: 404 });
    const market = await nepse.getMarketStatus().catch(() => ({ id: 0 }) as any);
    const series = await nepse.getPriceHistory(sid, market.id, 180).catch(() => []);
    // Warm the screener's history for this symbol while we're here.
    if (series.length > 0) {
      await repo
        .upsertDailyOhlc(series.map((s) => ({ symbol, date: s.date, open: s.open, high: s.high, low: s.low, close: s.close, volume: s.volume })))
        .catch(() => {});
    }
    const payload = JSON.stringify({ symbol, points: series.map((s) => ({ date: s.date, close: s.close })) });
    await env.CACHE.put(cacheKey, payload, { expirationTtl: 3600 });
    return new Response(payload, {
      headers: { "content-type": "application/json", "cache-control": "public, max-age=3600" },
    });
  }

  // --- public: securities list for the searchable dropdown ---
  if (p === "/api/securities" && request.method === "GET") {
    let list = await repo.listAllSecurities();
    if (list.length === 0) {
      await syncSecurities(nepse, repo).catch(() => {});
      list = await repo.listAllSecurities();
    }
    return Response.json(list, { headers: { "cache-control": "public, max-age=3600" } });
  }

  // --- personal endpoints below require the access key ---
  const isPersonal = p.startsWith("/api/portfolio") || p.startsWith("/api/alerts");
  const owner = authOwner(request, env);
  if (isPersonal && owner === null) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // --- portfolio ---
  if (p === "/api/portfolio" && request.method === "GET") {
    const lots = await repo.listPortfolio(owner!);
    const market = await nepse.getMarketStatus().catch(() => ({ id: 0 }) as any);
    const prices = new Map<string, number>();
    let cost = 0,
      value = 0;
    const holdings = [];
    for (const l of lots) {
      if (!prices.has(l.symbol)) prices.set(l.symbol, await ltpFor(env, nepse, repo, l.symbol, market.id));
      const ltp = prices.get(l.symbol)!;
      const c = l.quantity * l.buy_price;
      const v = l.quantity * ltp;
      cost += c;
      value += v;
      holdings.push({ id: l.id, symbol: l.symbol, quantity: l.quantity, buyPrice: l.buy_price, ltp, cost: c, value: v, pl: v - c });
    }
    return Response.json({ holdings, totals: { cost, value, pl: value - cost, plPct: cost ? ((value - cost) / cost) * 100 : 0 } });
  }

  if (p === "/api/portfolio" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as any;
    const symbol = String(b.symbol ?? "").toUpperCase();
    const quantity = Number(b.quantity);
    const buyPrice = Number(b.buyPrice);
    if (!symbol || !(quantity > 0) || !(buyPrice > 0)) {
      return Response.json({ error: "symbol, quantity>0 and buyPrice>0 required" }, { status: 400 });
    }
    if ((await resolveSecurityId(symbol, nepse, repo)) === null) {
      return Response.json({ error: `unknown symbol ${symbol}` }, { status: 400 });
    }
    await repo.ensureUser(owner!);
    await repo.addLot(owner!, symbol, quantity, buyPrice);
    return Response.json({ ok: true });
  }

  if (p.startsWith("/api/portfolio/") && request.method === "DELETE") {
    const id = Number(p.split("/").pop());
    const ok = Number.isInteger(id) && (await repo.deleteLot(owner!, id));
    return Response.json({ ok }, { status: ok ? 200 : 404 });
  }

  // --- alerts ---
  if (p === "/api/alerts" && request.method === "GET") {
    return Response.json(await repo.listAlerts(owner!));
  }

  if (p === "/api/alerts" && request.method === "POST") {
    const b = (await request.json().catch(() => ({}))) as any;
    const symbol = String(b.symbol ?? "").toUpperCase();
    const type = String(b.type ?? "");
    const threshold = Number(b.threshold);
    if (!symbol || !ALERT_TYPES.has(type) || !Number.isFinite(threshold)) {
      return Response.json({ error: "symbol, valid type, numeric threshold required" }, { status: 400 });
    }
    if ((await resolveSecurityId(symbol, nepse, repo)) === null) {
      return Response.json({ error: `unknown symbol ${symbol}` }, { status: 400 });
    }
    await repo.ensureUser(owner!);
    const id = await repo.addAlert(owner!, symbol, type, threshold);
    await repo.addWatch(owner!, symbol); // ensure the poll covers it
    return Response.json({ ok: true, id });
  }

  if (p.startsWith("/api/alerts/") && request.method === "DELETE") {
    const id = Number(p.split("/").pop());
    const ok = Number.isInteger(id) && (await repo.deleteAlert(owner!, id));
    return Response.json({ ok }, { status: ok ? 200 : 404 });
  }

  return null;
}
