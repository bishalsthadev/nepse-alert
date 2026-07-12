// Repository layer — the ONLY code that touches the database. Swapping D1 for
// Supabase/Postgres later means reimplementing just this file. See [[nepse-alert-plan]].

export interface UserRow {
  telegram_id: number;
  chat_id: number;
  username: string | null;
}

export interface AlertRule {
  id: number;
  telegram_id: number;
  symbol: string;
  type: string;
  threshold: number;
  active: number;
  last_triggered_at: string | null;
}

export interface PortfolioLot {
  id: number;
  telegram_id: number;
  symbol: string;
  quantity: number;
  buy_price: number;
  buy_date: string;
}

export class Repo {
  constructor(private db: D1Database) {}

  // --- users ---
  async upsertUser(u: UserRow): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO users (telegram_id, chat_id, username) VALUES (?, ?, ?)
         ON CONFLICT(telegram_id) DO UPDATE SET chat_id = excluded.chat_id, username = excluded.username`,
      )
      .bind(u.telegram_id, u.chat_id, u.username)
      .run();
  }

  // --- securities master list ---
  async upsertSecurities(rows: { symbol: string; security_id: number; name: string }[]): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO securities (symbol, security_id, name, updated_at) VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(symbol) DO UPDATE SET security_id = excluded.security_id, name = excluded.name, updated_at = datetime('now')`,
    );
    // D1 batch — chunk to stay well within limits.
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50).map((r) => stmt.bind(r.symbol, r.security_id, r.name));
      await this.db.batch(chunk);
    }
  }

  /** All securities for the web dropdown. */
  async listAllSecurities(): Promise<{ symbol: string; name: string }[]> {
    const res = await this.db
      .prepare(`SELECT symbol, name FROM securities ORDER BY symbol`)
      .all<{ symbol: string; name: string }>();
    return res.results;
  }

  /** Ensure a user row exists (web writes need the owner present for FK + delivery). */
  async ensureUser(telegram_id: number): Promise<void> {
    await this.db
      .prepare(`INSERT OR IGNORE INTO users (telegram_id, chat_id) VALUES (?, ?)`)
      .bind(telegram_id, telegram_id) // private-chat chat_id == user id
      .run();
  }

  async getSecurityId(symbol: string): Promise<number | null> {
    const row = await this.db
      .prepare(`SELECT security_id FROM securities WHERE symbol = ?`)
      .bind(symbol.toUpperCase())
      .first<{ security_id: number }>();
    return row?.security_id ?? null;
  }

  async securitiesCount(): Promise<number> {
    const row = await this.db.prepare(`SELECT COUNT(*) AS n FROM securities`).first<{ n: number }>();
    return row?.n ?? 0;
  }

  // --- watchlist ---
  async addWatch(telegram_id: number, symbol: string): Promise<void> {
    await this.db
      .prepare(`INSERT OR IGNORE INTO watchlist (telegram_id, symbol) VALUES (?, ?)`)
      .bind(telegram_id, symbol.toUpperCase())
      .run();
  }

  async removeWatch(telegram_id: number, symbol: string): Promise<void> {
    await this.db
      .prepare(`DELETE FROM watchlist WHERE telegram_id = ? AND symbol = ?`)
      .bind(telegram_id, symbol.toUpperCase())
      .run();
  }

  async listWatch(telegram_id: number): Promise<string[]> {
    const res = await this.db
      .prepare(`SELECT symbol FROM watchlist WHERE telegram_id = ? ORDER BY symbol`)
      .bind(telegram_id)
      .all<{ symbol: string }>();
    return res.results.map((r) => r.symbol);
  }

  /** All distinct symbols anyone is watching — the set we poll every 30 min. */
  async allWatchedSymbols(): Promise<string[]> {
    const res = await this.db.prepare(`SELECT DISTINCT symbol FROM watchlist`).all<{ symbol: string }>();
    return res.results.map((r) => r.symbol);
  }

  // --- alert rules ---
  async addAlert(telegram_id: number, symbol: string, type: string, threshold: number): Promise<number> {
    const res = await this.db
      .prepare(
        `INSERT INTO alert_rules (telegram_id, symbol, type, threshold) VALUES (?, ?, ?, ?) RETURNING id`,
      )
      .bind(telegram_id, symbol.toUpperCase(), type, threshold)
      .first<{ id: number }>();
    return res!.id;
  }

  async deleteAlert(telegram_id: number, id: number): Promise<boolean> {
    const res = await this.db
      .prepare(`DELETE FROM alert_rules WHERE id = ? AND telegram_id = ?`)
      .bind(id, telegram_id)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  async listAlerts(telegram_id: number): Promise<AlertRule[]> {
    const res = await this.db
      .prepare(`SELECT * FROM alert_rules WHERE telegram_id = ? ORDER BY symbol, id`)
      .bind(telegram_id)
      .all<AlertRule>();
    return res.results;
  }

  /** Active rules for a set of symbols — used by the engine each poll. */
  async activeAlertsForSymbols(symbols: string[]): Promise<AlertRule[]> {
    if (symbols.length === 0) return [];
    const placeholders = symbols.map(() => "?").join(",");
    const res = await this.db
      .prepare(`SELECT * FROM alert_rules WHERE active = 1 AND symbol IN (${placeholders})`)
      .bind(...symbols.map((s) => s.toUpperCase()))
      .all<AlertRule>();
    return res.results;
  }

  async markAlertTriggered(id: number): Promise<void> {
    await this.db
      .prepare(`UPDATE alert_rules SET last_triggered_at = datetime('now') WHERE id = ?`)
      .bind(id)
      .run();
  }

  async chatIdFor(telegram_id: number): Promise<number | null> {
    const row = await this.db
      .prepare(`SELECT chat_id FROM users WHERE telegram_id = ?`)
      .bind(telegram_id)
      .first<{ chat_id: number }>();
    return row?.chat_id ?? null;
  }

  async logAlert(telegram_id: number, rule_id: number, message: string): Promise<void> {
    await this.db
      .prepare(`INSERT INTO alert_log (telegram_id, rule_id, message) VALUES (?, ?, ?)`)
      .bind(telegram_id, rule_id, message)
      .run();
  }

  // --- portfolio ---
  async addLot(telegram_id: number, symbol: string, quantity: number, buy_price: number): Promise<void> {
    await this.db
      .prepare(`INSERT INTO portfolio (telegram_id, symbol, quantity, buy_price) VALUES (?, ?, ?, ?)`)
      .bind(telegram_id, symbol.toUpperCase(), quantity, buy_price)
      .run();
  }

  async listPortfolio(telegram_id: number): Promise<PortfolioLot[]> {
    const res = await this.db
      .prepare(`SELECT * FROM portfolio WHERE telegram_id = ? ORDER BY symbol, id`)
      .bind(telegram_id)
      .all<PortfolioLot>();
    return res.results;
  }

  async deleteLot(telegram_id: number, id: number): Promise<boolean> {
    const res = await this.db
      .prepare(`DELETE FROM portfolio WHERE id = ? AND telegram_id = ?`)
      .bind(id, telegram_id)
      .run();
    return (res.meta.changes ?? 0) > 0;
  }

  // --- daily OHLC (screener history) ---
  async upsertDailyOhlc(
    rows: { symbol: string; date: string; open: number; high: number; low: number; close: number; volume: number }[],
  ): Promise<void> {
    const stmt = this.db.prepare(
      `INSERT INTO daily_ohlc (symbol, date, open, high, low, close, volume) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(symbol, date) DO UPDATE SET open=excluded.open, high=excluded.high, low=excluded.low, close=excluded.close, volume=excluded.volume`,
    );
    for (let i = 0; i < rows.length; i += 50) {
      const chunk = rows.slice(i, i + 50).map((r) => stmt.bind(r.symbol, r.date, r.open, r.high, r.low, r.close, r.volume));
      await this.db.batch(chunk);
    }
  }

  async ohlcHistory(symbol: string, limit = 200): Promise<{ date: string; close: number; volume: number }[]> {
    const res = await this.db
      .prepare(`SELECT date, close, volume FROM daily_ohlc WHERE symbol = ? ORDER BY date DESC LIMIT ?`)
      .bind(symbol.toUpperCase(), limit)
      .all<{ date: string; close: number; volume: number }>();
    return res.results.reverse(); // chronological
  }

  async allUsers(): Promise<{ telegram_id: number; chat_id: number }[]> {
    const res = await this.db.prepare(`SELECT telegram_id, chat_id FROM users`).all<{ telegram_id: number; chat_id: number }>();
    return res.results;
  }

  // --- news (hash = url for dedupe) ---
  async insertNews(
    items: { source: string; category: string; title: string; url: string; symbol: string | null; published_at: string | null }[],
  ): Promise<typeof items> {
    const fresh: typeof items = [];
    const stmt = this.db.prepare(
      `INSERT INTO news_items (source, category, title, url, symbol, published_at, hash)
       VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(hash) DO NOTHING`,
    );
    for (const it of items) {
      const res = await stmt.bind(it.source, it.category, it.title, it.url, it.symbol, it.published_at, it.url).run();
      if ((res.meta.changes ?? 0) > 0) fresh.push(it);
    }
    return fresh;
  }

  async recentNews(limit = 10): Promise<{ title: string; url: string; category: string; published_at: string | null }[]> {
    const res = await this.db
      .prepare(`SELECT title, url, category, published_at FROM news_items ORDER BY id DESC LIMIT ?`)
      .bind(limit)
      .all<{ title: string; url: string; category: string; published_at: string | null }>();
    return res.results;
  }
}
