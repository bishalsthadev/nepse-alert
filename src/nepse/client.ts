// Workers-native NEPSE client: pure `fetch`, token cached in KV for its ~5-min TTL.
// Cloudflare's edge fetch tolerates NEPSE's incomplete TLS chain (missing
// GeoTrust intermediate) that Node rejects — see [[nepse-data-access]] memory.

import { calculateBodyId, generateValidToken, type ProveResponse } from "./token";

const BASE_URL = "https://nepalstock.com.np";
const TOKEN_KV_KEY = "nepse:token";
const TOKEN_TTL_S = 240; // refresh a bit before NEPSE's ~5 min expiry

export interface SecurityBrief {
  id: number;
  symbol: string;
  securityName: string;
  activeStatus: string;
}

export interface IndexDetail {
  index: string;
  currentValue: number;
  change: number;
  perChange: number;
}

export interface MarketStatus {
  isOpen: string;
  asOf: string;
  id: number;
}

export interface Mover {
  symbol: string;
  name: string;
  ltp: number;
  change: number;
  pctChange: number;
}

export interface Ranked {
  symbol: string;
  name: string;
  value: number; // turnover (Rs) or shares traded
  price: number;
}

/** One security's latest trade figures, normalized. */
export interface LivePrice {
  symbol: string;
  securityId: number;
  ltp: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
  volume: number;
  businessDate?: string;
}

function baseHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    "User-Agent": "Mozilla/5.0",
    Accept: "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${BASE_URL}/`,
    "Content-Type": "application/json",
  };
  if (token) h["Authorization"] = `Salter ${token}`;
  return h;
}

export class NepseClient {
  constructor(private cache?: KVNamespace) {}

  /** Fetch (or reuse from KV) a valid access token. Pass force to bypass cache. */
  async getToken(force = false): Promise<string> {
    if (!force && this.cache) {
      const cached = await this.cache.get(TOKEN_KV_KEY);
      if (cached) return cached;
    }
    const res = await fetch(`${BASE_URL}/api/authenticate/prove`, {
      headers: { "User-Agent": "Mozilla/5.0", Referer: BASE_URL },
    });
    if (!res.ok) throw new Error(`prove failed: ${res.status}`);
    const prove = (await res.json()) as ProveResponse;
    const token = generateValidToken(prove);
    if (this.cache) {
      await this.cache.put(TOKEN_KV_KEY, token, { expirationTtl: TOKEN_TTL_S });
    }
    return token;
  }

  // NEPSE occasionally returns 401 UNAUTHORIZED ACCESS even for a valid token
  // (anti-bot). Retry once with a freshly-minted token before giving up.
  private async authed(path: string, init?: RequestInit): Promise<Response> {
    const req = (token: string) =>
      fetch(`${BASE_URL}${path}`, {
        ...init,
        headers: { ...baseHeaders(token), ...(init?.headers as Record<string, string>) },
      });
    let res = await req(await this.getToken());
    if (res.status === 401) res = await req(await this.getToken(true));
    return res;
  }

  async getMarketStatus(): Promise<MarketStatus> {
    const res = await this.authed("/api/nots/nepse-data/market-open");
    if (!res.ok) throw new Error(`market-open failed: ${res.status}`);
    return (await res.json()) as MarketStatus;
  }

  /**
   * Daily OHLC history for a security (up to ~1 year), via the graph endpoint
   * (POST with the computed body id). Newest last. Powers charts + screener backfill.
   */
  async getPriceHistory(
    securityId: number,
    marketId: number,
    limit = 180,
  ): Promise<{ date: string; open: number; high: number; low: number; close: number; volume: number }[]> {
    const res = await this.authed(`/api/nots/market/graphdata/${securityId}`, {
      method: "POST",
      body: JSON.stringify({ id: calculateBodyId(marketId) }),
    });
    if (!res.ok) throw new Error(`graphdata failed: ${res.status}`);
    const rows = (await res.json()) as any[];
    if (!Array.isArray(rows)) return [];
    return rows.slice(-limit).map((r) => ({
      date: String(r.businessDate).slice(0, 10),
      open: Number(r.openPrice),
      high: Number(r.highPrice),
      low: Number(r.lowPrice),
      close: Number(r.closePrice ?? r.lastTradedPrice),
      volume: Number(r.totalTradedQuantity),
    }));
  }

  /** Top gainers & losers for the day (NEPSE returns last session when closed). */
  async getTopMovers(limit = 5): Promise<{ gainers: Mover[]; losers: Mover[] }> {
    const map = (rows: any[]): Mover[] =>
      rows.map((r) => ({
        symbol: r.symbol,
        name: r.securityName,
        ltp: Number(r.ltp),
        change: Number(r.pointChange),
        pctChange: Number(r.percentageChange),
      }));
    const [g, l] = await Promise.all([
      this.authed("/api/nots/top-ten/top-gainer"),
      this.authed("/api/nots/top-ten/top-loser"),
    ]);
    const gainers = g.ok ? map((await g.json()) as any[]).sort((a, b) => b.pctChange - a.pctChange).slice(0, limit) : [];
    const losers = l.ok ? map((await l.json()) as any[]).sort((a, b) => a.pctChange - b.pctChange).slice(0, limit) : [];
    return { gainers, losers };
  }

  /** Top securities by turnover (Rs) and by shares traded ("most traded"). */
  async getTopLists(limit = 5): Promise<{ turnover: Ranked[]; volume: Ranked[] }> {
    const [t, v] = await Promise.all([
      this.authed("/api/nots/top-ten/turnover"),
      this.authed("/api/nots/top-ten/trade"),
    ]);
    const turnover = t.ok
      ? ((await t.json()) as any[])
          .map((r) => ({ symbol: r.symbol, name: r.securityName, value: Number(r.turnover), price: Number(r.closingPrice) }))
          .sort((a, b) => b.value - a.value)
          .slice(0, limit)
      : [];
    const volume = v.ok
      ? ((await v.json()) as any[])
          .map((r) => ({ symbol: r.symbol, name: r.securityName, value: Number(r.shareTraded), price: Number(r.closingPrice) }))
          .sort((a, b) => b.value - a.value)
          .slice(0, limit)
      : [];
    return { turnover, volume };
  }

  async getNepseIndex(): Promise<IndexDetail[]> {
    const res = await this.authed("/api/nots/nepse-index");
    if (!res.ok) throw new Error(`nepse-index failed: ${res.status}`);
    return (await res.json()) as IndexDetail[];
  }

  async getSecurities(): Promise<SecurityBrief[]> {
    const res = await this.authed("/api/nots/security?nonDelisted=false");
    if (!res.ok) throw new Error(`security list failed: ${res.status}`);
    return (await res.json()) as SecurityBrief[];
  }

  /** Per-symbol detail (POST needs the computed body id). Returns null if unknown. */
  async getSecurityDetail(securityId: number, marketId: number): Promise<LivePrice | null> {
    const res = await this.authed(`/api/nots/security/${securityId}`, {
      method: "POST",
      body: JSON.stringify({ id: calculateBodyId(marketId) }),
    });
    if (!res.ok) return null;
    const d = (await res.json()) as any;
    const t = d.securityDailyTradeDto ?? {};
    return {
      symbol: d.security?.symbol,
      securityId,
      ltp: Number(t.lastTradedPrice),
      open: Number(t.openPrice),
      high: Number(t.highPrice),
      low: Number(t.lowPrice),
      previousClose: Number(t.previousClose),
      volume: Number(t.totalTradeQuantity),
      businessDate: t.businessDate,
    };
  }

  /**
   * Bulk snapshot of all securities' latest trade stats for the day, via
   * /api/nots/securityDailyTradeStat/{marketId} (GET). Returns [] outside market
   * hours (NEPSE serves an empty array when closed). Field names mapped
   * defensively; verify against a live market session.
   */
  async getTodayPrices(marketId: number): Promise<LivePrice[]> {
    const res = await this.authed(`/api/nots/securityDailyTradeStat/${marketId}`);
    if (!res.ok) throw new Error(`securityDailyTradeStat failed: ${res.status}`);
    const data = (await res.json()) as any;
    const rows: any[] = Array.isArray(data) ? data : (data.content ?? []);
    return rows.map((r) => ({
      symbol: r.symbol,
      securityId: Number(r.securityId),
      ltp: Number(r.lastTradedPrice ?? r.ltp ?? r.closePrice),
      open: Number(r.openPrice),
      high: Number(r.highPrice),
      low: Number(r.lowPrice),
      previousClose: Number(r.previousDayClosePrice ?? r.previousClose),
      volume: Number(r.totalTradeQuantity ?? r.totalTradedQuantity),
      businessDate: r.businessDate,
    }));
  }
}
