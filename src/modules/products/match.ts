import type { Product } from "./types";

/**
 * match.ts — product identity.
 *
 * THE RULE: two listings are the same real product only if they share a model
 * number or an EAN. Titles are never used ("LG 27UL650-W 27\" 4K Monitor" vs
 * "LG 27UL650 4K HDR10 Monitor (Renewed)" are the same product; a 24" sibling
 * is not). Pure functions, no I/O, no LLM.
 */

/** Uppercase and strip every non-alphanumeric character: "G502-HERO" → "G502HERO". */
export function normalizeModelNumber(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/** Digits only, so "8806084935120" and "8806084935120 " compare equal. */
export function normalizeEan(value: string): string {
  return value.replace(/\D/g, "");
}

/**
 * All identity keys a listing claims.
 *
 * EAN first (strongest), then the model number. The synthetic `ean:<digits>`
 * model we emit for EAN-only records is deliberately NOT a key — its EAN is.
 */
export function identityKeys(product: Product): string[] {
  const keys: string[] = [];

  if (product.ean) {
    const ean = normalizeEan(product.ean);
    if (ean) keys.push(`ean:${ean}`);
  }

  // Skip the synthetic "ean:..." placeholder — the EAN already keyed it.
  if (product.modelNumber && !product.modelNumber.startsWith("ean:")) {
    const model = normalizeModelNumber(product.modelNumber);
    if (model) keys.push(`model:${model}`);
  }

  return keys;
}

/** The primary key used for equality maps: EAN when present, else model. */
export function primaryIdentityKey(product: Product): string {
  return identityKeys(product)[0] ?? `id:${product.source}:${product.id}`;
}

/** Are these two listings the same real-world product? (Never title-based.) */
export function areSameProduct(a: Product, b: Product): boolean {
  if (a.source === b.source && a.id === b.id) return true;

  const aKeys = new Set(identityKeys(a));
  if (aKeys.size === 0) return false;
  return identityKeys(b).some((key) => aKeys.has(key));
}

/** Every listing of the same product as `target` (excluding itself). */
export function findMatchingListings(all: Product[], target: Product): Product[] {
  return all.filter(
    (p) =>
      // Exclude the target itself (same source + id), even if a different
      // object instance is passed in.
      !(p.source === target.source && p.id === target.id) && areSameProduct(p, target),
  );
}

/**
 * Group listings into distinct products.
 *
 * Listings sharing a model number or EAN collapse into one group; genuine
 * variants (different model numbers) stay in their own groups. Within a group
 * the order is stable: official store first, then in-stock, then cheapest.
 */
export function groupByProduct(products: Product[]): Product[][] {
  // Union-find over product indices: any shared key unions two listings, so a
  // listing that bridges two earlier clusters (shares k1 with one and k2 with
  // another) correctly collapses all three into a single group.
  const parent = products.map((_, i) => i);
  const keyOwner = new Map<string, number>();

  const find = (i: number): number => {
    let root = i;
    while (parent[root] !== root) root = parent[root]!;
    // Path compression.
    let cur = i;
    while (parent[cur] !== root) {
      const next = parent[cur]!;
      parent[cur] = root;
      cur = next;
    }
    return root;
  };

  const union = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  products.forEach((product, index) => {
    for (const key of identityKeys(product)) {
      const owner = keyOwner.get(key);
      if (owner === undefined) keyOwner.set(key, index);
      else union(index, owner);
    }
  });

  const byRoot = new Map<number, Product[]>();
  products.forEach((product, index) => {
    const root = find(index);
    const bucket = byRoot.get(root);
    if (bucket) bucket.push(product);
    else byRoot.set(root, [product]);
  });

  // Stable, deterministic group order: by first-seen product index.
  return [...byRoot.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, group]) => sortGroup(group));
}

/** Stable within-group ordering: official → in stock → cheapest → source order. */
function sortGroup(group: Product[]): Product[] {
  return [...group].sort(
    (a, b) =>
      Number(b.isOfficialStore) - Number(a.isOfficialStore) ||
      Number(b.inStock) - Number(a.inStock) ||
      a.price - b.price ||
      a.id.localeCompare(b.id),
  );
}

/**
 * The preferred listing of a product group: official store beats third party,
 * in stock beats out of stock, then the lowest price wins.
 */
export function pickBestListing(group: Product[]): Product {
  const sorted = sortGroup(group);
  const first = sorted[0];
  if (!first) throw new Error("pickBestListing called with an empty group");
  return first;
}

export interface CompareRow {
  /** The distinct product these listings belong to. */
  key: string;
  best: Product;
  /** All listings found for this product (price spread across sellers). */
  listings: Product[];
}

/**
 * Side-by-side comparison across DISTINCT products: one row per real product,
 * cheapest-first rows, best listing first within each row.
 */
export function compareProducts(products: Product[]): CompareRow[] {
  return groupByProduct(products)
    .map((listings) => {
      const best = pickBestListing(listings);
      return { key: primaryIdentityKey(best), best, listings };
    })
    .sort(
      (a, b) =>
        a.best.price - b.best.price ||
        b.best.rating - a.best.rating ||
        a.best.id.localeCompare(b.best.id),
    );
}
