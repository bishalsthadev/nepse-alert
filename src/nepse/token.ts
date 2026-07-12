// NEPSE access-token derivation — pure TypeScript, no WASM, no dependencies.
// The /api/authenticate/prove endpoint returns an obfuscated accessToken plus
// five numeric salts. Five decode functions turn the salts into slice indices;
// removing the characters at those indices yields the valid token, which is sent
// as `Authorization: Salter <token>`.
//
// Constants extracted from NEPSE's WASM/JS (via dahsameer/nepse-api-helper).
// Verified returning HTTP 200 from live endpoints on 2026-07-12. If NEPSE rotates
// these, this module is the single place to patch.

export interface ProveResponse {
  accessToken: string;
  refreshToken: string;
  salt1: number;
  salt2: number;
  salt3: number;
  salt4: number;
  salt5: number;
  serverTime: number;
}

const LOOKUP_TABLE = [
  5, 8, 4, 7, 9, 4, 6, 9, 5, 5,
  6, 5, 3, 5, 4, 4, 9, 6, 6, 8,
  8, 6, 8, 6, 5, 8, 4, 9, 5, 9,
  8, 5, 3, 4, 7, 7, 4, 7, 3, 9,
];

function digits(v: number) {
  return { ones: v % 10, tens: Math.floor(v / 10) % 10, hundreds: Math.floor(v / 100) % 10 };
}

const cdx = (v1: number) => { const { ones, tens, hundreds } = digits(v1); return LOOKUP_TABLE[ones + tens + hundreds] + 22; };
const rdx = (v1: number) => { const { ones, tens, hundreds } = digits(v1); const a = tens + hundreds; return a + LOOKUP_TABLE[a + ones] + 32; };
const bdx = (v1: number) => { const { ones, tens, hundreds } = digits(v1); const a = tens + hundreds; return a + LOOKUP_TABLE[a + ones] + 60; };
const ndx = (v1: number) => { const { ones, tens, hundreds } = digits(v1); return tens + LOOKUP_TABLE[tens + ones + hundreds] + 88; };
const mdx = (v1: number) => { const { ones, tens, hundreds } = digits(v1); return hundreds + LOOKUP_TABLE[hundreds + tens + ones] + 110; };

/** Derive the valid access token from a `prove` response. */
export function generateValidToken(prove: ProveResponse): string {
  const { accessToken, salt2 } = prove;
  // All five decode fns key off salt2 (the reference implementation passes the
  // other salts too, but only var1 is used); ordering of the slices matters.
  const c = cdx(salt2);
  const r = rdx(salt2);
  const b = bdx(salt2);
  const n = ndx(salt2);
  const m = mdx(salt2);
  return (
    accessToken.slice(0, c) +
    accessToken.slice(c + 1, r) +
    accessToken.slice(r + 1, b) +
    accessToken.slice(b + 1, n) +
    accessToken.slice(n + 1, m) +
    accessToken.slice(m + 1)
  );
}

// dummyData for the POST-body `id` some endpoints require (today-price, security detail).
const DUMMY_DATA = [
  147, 117, 239, 143, 157, 312, 161, 612, 512, 804, 411, 527, 170, 511, 421, 667, 764, 621, 301, 106,
  133, 793, 411, 511, 312, 423, 344, 346, 653, 758, 342, 222, 236, 811, 711, 611, 122, 447, 128, 199,
  183, 135, 489, 703, 800, 745, 152, 863, 134, 211, 142, 564, 375, 793, 212, 153, 138, 153, 648, 611,
  151, 649, 318, 143, 117, 756, 119, 141, 717, 113, 112, 146, 162, 660, 693, 261, 362, 354, 251, 641,
  157, 178, 631, 192, 734, 445, 192, 883, 187, 122, 591, 731, 852, 384, 565, 596, 451, 772, 624, 691,
];

/** Body `id` NEPSE expects on certain POST endpoints, keyed off the market id. */
export function calculateBodyId(marketId: number): number {
  const nepalDay = new Date(
    new Date().toLocaleString("en-US", { timeZone: "Asia/Kathmandu" }),
  ).getDate();
  return DUMMY_DATA[marketId] + marketId + 2 * nepalDay;
}
