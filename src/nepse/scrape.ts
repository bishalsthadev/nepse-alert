// News / dividend / IPO signals scraped from ShareSansar with Cloudflare's
// native HTMLRewriter. ShareSansar serves valid TLS and clean markup:
// <a href="https://www.sharesansar.com/newsdetail/<slug>-<YYYY-MM-DD>" title="Headline">

export interface NewsItem {
  source: string;
  category: string; // news | dividend | ipo | agm
  title: string;
  url: string;
  symbol: string | null;
  publishedAt: string | null;
}

const CATEGORY_KEYWORDS: [string, RegExp][] = [
  ["dividend", /dividend|bonus share|cash dividend/i],
  ["ipo", /\bipo\b|\bfpo\b|right share|issue open|allotment|oversubscrib/i],
  ["agm", /\bagm\b|book\s?close|annual general/i],
];

function categorize(title: string): string {
  for (const [cat, re] of CATEGORY_KEYWORDS) if (re.test(title)) return cat;
  return "news";
}

/** Scrape the latest ShareSansar news feed. */
export async function scrapeShareSansarNews(limit = 20): Promise<NewsItem[]> {
  const res = await fetch("https://www.sharesansar.com/category/latest", {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) throw new Error(`sharesansar fetch failed: ${res.status}`);

  const items: NewsItem[] = [];
  const seen = new Set<string>();
  const rewriter = new HTMLRewriter().on('a[href*="/newsdetail/"]', {
    element(el) {
      const url = el.getAttribute("href");
      const title = el.getAttribute("title");
      if (!url || !title || seen.has(url)) return;
      seen.add(url);
      const m = url.match(/(\d{4}-\d{2}-\d{2})$/);
      items.push({
        source: "sharesansar",
        category: categorize(title),
        title: title.trim(),
        url,
        symbol: null,
        publishedAt: m ? m[1] : null,
      });
    },
  });
  await rewriter.transform(res).arrayBuffer(); // drive the parser
  return items.slice(0, limit);
}
