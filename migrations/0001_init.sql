-- nepse-alert initial schema (Cloudflare D1 / SQLite)
-- Accessed only through src/db/* so a later swap to Supabase/Postgres stays contained.

CREATE TABLE IF NOT EXISTS users (
  telegram_id   INTEGER PRIMARY KEY,          -- Telegram user id
  chat_id       INTEGER NOT NULL,             -- where to deliver messages
  username      TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  settings_json TEXT NOT NULL DEFAULT '{}'
);

-- Master security list, refreshed periodically from NEPSE.
CREATE TABLE IF NOT EXISTS securities (
  symbol       TEXT PRIMARY KEY,              -- e.g. NABIL
  security_id  INTEGER NOT NULL,              -- NEPSE numeric id (for detail endpoint)
  name         TEXT NOT NULL,
  sector       TEXT,
  active        INTEGER NOT NULL DEFAULT 1,
  updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS watchlist (
  telegram_id  INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (telegram_id, symbol)
);
CREATE INDEX IF NOT EXISTS idx_watchlist_symbol ON watchlist(symbol);

-- Alert rules. type ∈ price_above | price_below | pct_change | volume_spike | ma_cross
CREATE TABLE IF NOT EXISTS alert_rules (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id      INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  symbol           TEXT NOT NULL,
  type             TEXT NOT NULL,
  threshold        REAL NOT NULL,
  active           INTEGER NOT NULL DEFAULT 1,
  last_triggered_at TEXT,
  created_at       TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alert_rules_symbol_active ON alert_rules(symbol, active);
CREATE INDEX IF NOT EXISTS idx_alert_rules_user ON alert_rules(telegram_id);

CREATE TABLE IF NOT EXISTS portfolio (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id  INTEGER NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL,
  quantity     REAL NOT NULL,
  buy_price    REAL NOT NULL,
  buy_date     TEXT NOT NULL DEFAULT (date('now')),
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_portfolio_user ON portfolio(telegram_id);

-- Daily OHLC accumulated at EOD; source of truth for the technical screener.
CREATE TABLE IF NOT EXISTS daily_ohlc (
  symbol  TEXT NOT NULL,
  date    TEXT NOT NULL,                       -- YYYY-MM-DD (business date)
  open    REAL,
  high    REAL,
  low     REAL,
  close   REAL,
  volume  REAL,
  PRIMARY KEY (symbol, date)
);

CREATE TABLE IF NOT EXISTS news_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  source       TEXT NOT NULL,                  -- sharesansar | merolagani
  category     TEXT,                           -- news | dividend | ipo | announcement
  title        TEXT NOT NULL,
  url          TEXT,
  symbol       TEXT,
  published_at TEXT,
  hash         TEXT NOT NULL UNIQUE,           -- dedupe key
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alert_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id  INTEGER NOT NULL,
  rule_id      INTEGER,
  message      TEXT NOT NULL,
  sent_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_alert_log_user ON alert_log(telegram_id);
