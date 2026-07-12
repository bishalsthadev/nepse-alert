// Scrape news, store new items (dedup), and push an EOD digest to all users.
import { Api } from "grammy";
import type { Env } from "../env";
import { Repo } from "../db/repo";
import { scrapeShareSansarNews } from "../nepse/scrape";

const CAT_EMOJI: Record<string, string> = { dividend: "💰", ipo: "📢", agm: "📅", news: "📰" };

/** Scrape + persist. Returns the items that were newly seen this run. */
export async function refreshNews(env: Env): Promise<number> {
  const repo = new Repo(env.DB);
  const items = await scrapeShareSansarNews(25);
  const fresh = await repo.insertNews(
    items.map((i) => ({
      source: i.source,
      category: i.category,
      title: i.title,
      url: i.url,
      symbol: i.symbol,
      published_at: i.publishedAt,
    })),
  );
  return fresh.length;
}

/** EOD digest: scrape, store, and message every user with the new headlines. */
export async function newsDigest(env: Env): Promise<{ fresh: number }> {
  const repo = new Repo(env.DB);
  const items = await scrapeShareSansarNews(25);
  const fresh = await repo.insertNews(
    items.map((i) => ({
      source: i.source,
      category: i.category,
      title: i.title,
      url: i.url,
      symbol: i.symbol,
      published_at: i.publishedAt,
    })),
  );
  if (fresh.length === 0) return { fresh: 0 };

  // Prioritise corporate signals; cap the digest length.
  const ranked = fresh
    .sort((a, b) => (a.category === "news" ? 1 : 0) - (b.category === "news" ? 1 : 0))
    .slice(0, 12);
  const body = ranked
    .map((i) => `${CAT_EMOJI[i.category] ?? "📰"} <a href="${i.url}">${escapeHtml(i.title)}</a>`)
    .join("\n\n");
  const msg = `<b>📊 NEPSE — market close digest</b>\n\n${body}`;

  const api = new Api(env.TELEGRAM_BOT_TOKEN);
  for (const u of await repo.allUsers()) {
    try {
      await api.sendMessage(u.chat_id, msg, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    } catch (e) {
      console.error(`digest send failed for ${u.telegram_id}:`, e);
    }
  }
  return { fresh: fresh.length };
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
