// Keep the D1 `securities` master list fresh from NEPSE.
import { Repo } from "../db/repo";
import { NepseClient } from "./client";

/** Fetch the full security list and upsert into D1. Returns the count synced. */
export async function syncSecurities(nepse: NepseClient, repo: Repo): Promise<number> {
  const list = await nepse.getSecurities();
  const rows = list
    .filter((s) => s.symbol && s.activeStatus === "A")
    .map((s) => ({ symbol: s.symbol.toUpperCase(), security_id: s.id, name: s.securityName }));
  await repo.upsertSecurities(rows);
  return rows.length;
}

/** Resolve a symbol to its NEPSE security id, syncing the list on a cache miss. */
export async function resolveSecurityId(
  symbol: string,
  nepse: NepseClient,
  repo: Repo,
): Promise<number | null> {
  let id = await repo.getSecurityId(symbol);
  if (id === null && (await repo.securitiesCount()) === 0) {
    await syncSecurities(nepse, repo);
    id = await repo.getSecurityId(symbol);
  }
  return id;
}
