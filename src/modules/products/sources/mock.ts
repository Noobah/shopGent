import { ExternalServiceError } from "@/lib/errors";
import { parseProduct, type Product } from "../types";
import type { ProductSource, SearchProductsParams } from "../source";
import { MOCK_PRODUCTS } from "./mock.data";

/**
 * MockSource — the DEFAULT ProductSource for dev and every test.
 *
 * Deterministic: same params in, same records out, no clock, no network. It is
 * also the reference implementation of the seam contract: every record returned
 * is validated against `productSchema` (bad fixture = loud failure, never
 * silently-passed garbage).
 *
 * Constructor options let tests substitute fixture sets or a fixed `fetchedAt`
 * (used later by price-freshness tests) without inventing a third seam.
 */

export interface MockSourceOptions {
  /** Override the fixture set (defaults to the shared ~40 products). */
  products?: Product[];
  /** Rewind/advance `fetchedAt` on returned records (UTC ISO). */
  fetchedAt?: string;
}

/** Search parameters AFTER schema defaults are applied. */
type ResolvedParams = SearchProductsParams;

export class MockSource implements ProductSource {
  readonly id = "mock";

  private readonly base: Product[];
  private readonly fetchedAt?: string;

  constructor(options: MockSourceOptions = {}) {
    this.base = options.products ?? MOCK_PRODUCTS;
    this.fetchedAt = options.fetchedAt;
  }

  async search(params: ResolvedParams): Promise<Product[]> {
    // An already-aborted caller must not get data back.
    if (params.signal?.aborted) {
      throw new ExternalServiceError(504, "MockSource search aborted");
    }

    const tokens = tokenize(params.query);
    const scored: { product: Product; score: number }[] = [];

    for (const product of this.base) {
      if (params.category && product.category !== params.category) continue;
      if (params.maxPricePaise !== undefined && product.price > params.maxPricePaise) {
        continue;
      }
      if (params.minRating !== undefined && product.rating < params.minRating) continue;
      if (params.officialOnly && !product.isOfficialStore) continue;

      const score = relevanceScore(product, tokens);
      // With no query, everything scores 0 and ordering falls through to the
      // deterministic tiebreakers below.
      if (tokens.length > 0 && score === 0) continue;

      scored.push({ product, score });
    }

    // Deterministic ordering: relevance, then official stores, then rating,
    // then price, then id (a total order — never dependent on input order).
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        Number(b.product.isOfficialStore) - Number(a.product.isOfficialStore) ||
        b.product.rating - a.product.rating ||
        a.product.price - b.product.price ||
        a.product.id.localeCompare(b.product.id),
    );

    return scored.slice(0, params.limit).map((s) => this.stamp(s.product));
  }

  async getById(id: string, params?: { signal?: AbortSignal }): Promise<Product | null> {
    if (params?.signal?.aborted) {
      throw new ExternalServiceError(504, "MockSource getById aborted");
    }
    const found = this.base.find((p) => p.id === id);
    return found ? this.stamp(found) : null;
  }

  /** Apply the configured timestamp and re-validate — outputs must parse. */
  private stamp(product: Product): Product {
    const record = this.fetchedAt ? { ...product, fetchedAt: this.fetchedAt } : product;
    return parseProduct(record);
  }
}

function tokenize(query?: string): string[] {
  if (!query) return [];
  return query
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 1);
}

/**
 * Case-insensitive token overlap against title + brand + model + category.
 * Title counts double so exact title tokens outrank incidental matches.
 */
function relevanceScore(product: Product, tokens: string[]): number {
  if (tokens.length === 0) return 0;
  const title = product.title.toLowerCase();
  const brand = product.brand.toLowerCase();
  const model = product.modelNumber.toLowerCase();
  const category = product.category.toLowerCase();

  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 2;
    else if (brand.includes(token)) score += 2;
    else if (model.includes(token)) score += 1;
    else if (category.includes(token)) score += 1;
  }
  return score;
}
