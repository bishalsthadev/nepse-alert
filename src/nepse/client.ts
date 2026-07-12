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

  /** Fetch (or reuse from KV) a valid access token. */
  async getToken(): Promise<string> {
    if (this.cache) {
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

  private async authed(path: string, init?: RequestInit): Promise<Response> {
    const token = await this.getToken();
    return fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: { ...baseHeaders(token), ...(init?.headers as Record<string, string>) },
    });
  }

  async getMarketStatus(): Promise<MarketStatus> {
    const res = await this.authed("/api/nots/nepse-data/market-open");
    if (!res.ok) throw new Error(`market-open failed: ${res.status}`);
    return (await res.json()) as MarketStatus;
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
