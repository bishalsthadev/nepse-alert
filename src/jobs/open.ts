// Market-open job: re-sync the securities master list (detect new listings and
// notify the owner), then take the opening full-market snapshot.
import { Api } from "grammy";
import type { Env } from "../env";
import { Repo } from "../db/repo";
import { NepseClient } from "../nepse/client";
import { syncSecurities } from "../nepse/sync";
import { fullSnapshot } from "../alerts/engine";

export async function runMarketOpen(env: Env): Promise<{ newListings: string[]; snapshot: number }> {
  const nepse = new NepseClient(env.CACHE);
  const repo = new Repo(env.DB);

  const before = new Set((await repo.listAllSecurities()).map((s) => s.symbol));
  await syncSecurities(nepse, repo);
  const after = await repo.listAllSecurities();
  const newListings = after.filter((s) => !before.has(s.symbol)).map((s) => s.symbol);

  // Only notify once we have a baseline (skip the very first sync from empty).
  if (newListings.length > 0 && before.size > 0 && env.OWNER_TELEGRAM_ID) {
    try {
      const api = new Api(env.TELEGRAM_BOT_TOKEN);
      await api.sendMessage(
        Number(env.OWNER_TELEGRAM_ID),
        `🆕 New on NEPSE today: ${newListings.join(", ")}`,
      );
    } catch (e) {
      console.error("new-listing notify failed:", e);
    }
  }

  const snap = await fullSnapshot(env);
  return { newListings, snapshot: snap.count };
}
