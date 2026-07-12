/** Cloudflare bindings + secrets available to the Worker. */
export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  TELEGRAM_BOT_TOKEN: string;
  TELEGRAM_WEBHOOK_SECRET: string;
  /** Optional: restrict the bot to this Telegram user id (personal deployment). */
  OWNER_TELEGRAM_ID?: string;
  /** Passphrase gating the web app's personal (portfolio/alerts) endpoints. */
  WEB_ACCESS_KEY?: string;
}
