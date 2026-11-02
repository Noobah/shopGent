import { ValidationError, ExternalServiceError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { productSchema, type Product } from "./types";

/**
 * normalize.ts — raw vendor payload → validated `Product`.
 *
 * This is where untrusted upstream data is tamed:
 *  - money arrives as rupees (number or "₹1,299.50") and becomes INTEGER PAISE
 *  - a record with neither a model number nor an EAN is rejected, never
 *    "matched" on title (the spec's hard rule)
 *  - a missing MRP falls back to the price itself, so we never fabricate a
 *    discount that the source did not report
 *
 * Everything here is pure and LLM-free.
 */

export interface NormalizeOptions {
  /** Source id to stamp on the record (e.g. "live"). */
  source: string;
  /** UTC ISO timestamp to stamp; defaults to now. */
  fetchedAt?: string;
}

/** Any shape a vendor might send for money. */
export type MoneyInput = number | string | null | undefined;

/**
 * Convert vendor money into integer paise.
 *
 * Numbers are treated as RUPEES (e.g. 1299 → 129900 paise); strings may be
 * "₹1,299.50", "1299", or "1299.50". Half-paise rounds to the nearest paise —
 * never silently truncated, never NaN, never negative.
 */
export function toPaise(value: MoneyInput): number {
  if (value === null || value === undefined || value === "") {
    throw new ValidationError("price is missing");
  }

  let rupees: number;
  if (typeof value === "number") {
    rupees = value;
  } else {
    // Strip currency symbols/commas only AFTER rejecting a negative sign —
    // otherwise "-5" would silently become +5 and inflate the cart.
    if (/[-−]/.test(value)) {
      throw new ValidationError("money cannot be negative");
    }
    const cleaned = value.replace(/[^\d.]/g, "");
    if (!cleaned || !/^\d*\.?\d*$/.test(cleaned)) {
      throw new ValidationError(`unparseable money value: ${value}`);
    }
    rupees = Number(cleaned);
  }

  if (!Number.isFinite(rupees)) {
    throw new ValidationError(`unparseable money value: ${String(value)}`);
  }

  // Binary floats make exact half-paise values land just under the tie
  // (9.995 * 100 === 999.4999999999999). Snapping to 15 significant digits
  // restores the decimal value before Math.round's half-up.
  const paise = Math.round(Number((rupees * 100).toPrecision(15)));
  if (paise < 0) throw new ValidationError("money cannot be negative");
  return paise;
}

/** Raw fields a live adapter might hand us (loose by design). */
export interface RawProduct {
  id: string | number;
  title: string;
  brand?: string;
  category?: string;
  modelNumber?: string | null;
  ean?: string | number | null;
  price: MoneyInput;
  mrp?: MoneyInput;
  rating?: number | null;
  ratingCount?: number | null;
  sellerName?: string | null;
  isOfficialStore?: boolean | null;
  inStock?: boolean | null;
  deliveryEstimate?: string | null;
  url?: string;
  imageUrl?: string;
  /** Vendor-specific category we map into our three allowed categories. */
  vendorCategory?: string;
}

const CATEGORY_KEYWORDS: Record<Product["category"], string[]> = {
  electronics: [
    "electronic",
    "computer",
    "laptop",
    "monitor",
    "audio",
    "phone",
    "camera",
    "accessor",
  ],
  home: ["home", "kitchen", "furniture", "appliance", "bedding", "garden"],
  fashion: ["fashion", "apparel", "clothing", "shoes", "footwear", "wear", "style"],
};

/** Map a vendor category string into one of our three categories. */
export function normalizeCategory(value?: string | null): Product["category"] {
  const v = (value ?? "").toLowerCase();
  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((k) => v.includes(k))) return category as Product["category"];
  }
  // Unknown bucket: "electronics" is the least-wrong default, and the record
  // still carries its real title/brand — we never claim it came from a category
  // the source did not suggest... but we must pick one to satisfy the schema.
  throw new ValidationError(`unrecognized product category: ${value ?? "(missing)"}`);
}

/**
 * Normalize one raw record. Throws `ValidationError` when the record cannot be
 * trusted (missing identifiers, unparseable money, bad URL).
 */
export function normalizeProduct(raw: RawProduct, options: NormalizeOptions): Product {
  const id = String(raw.id ?? "").trim();
  if (!id) throw new ValidationError("product id is missing");

  const title = String(raw.title ?? "").trim();
  if (!title) throw new ValidationError("product title is missing");

  // Identifiers: model number OR EAN is mandatory — title-only matching is
  // explicitly forbidden. Never invent one.
  const modelNumber = String(raw.modelNumber ?? "").trim();
  const ean =
    raw.ean === null || raw.ean === undefined ? undefined : String(raw.ean).trim();
  if (!modelNumber && !ean) {
    throw new ValidationError(`product ${id} has neither a model number nor an EAN`);
  }
  if (ean && !/^\d{8,14}$/.test(ean)) {
    throw new ValidationError(`product ${id} has a malformed EAN: ${ean}`);
  }

  const price = toPaise(raw.price);
  // No reported MRP → MRP = price (no fabricated discount).
  const mrp = raw.mrp === null || raw.mrp === undefined ? price : toPaise(raw.mrp);
  if (mrp < price) {
    throw new ValidationError(`product ${id} has MRP below its price`);
  }

  const brand = String(raw.brand ?? "").trim() || title.split(/\s+/)[0]!;
  const url = String(raw.url ?? "").trim();
  if (!url || !/^https:\/\//i.test(url)) {
    throw new ValidationError(`product ${id} has a non-https url: ${url || "(missing)"}`);
  }
  const imageUrl = String(raw.imageUrl ?? "").trim() || fallbackImage(id, options.source);

  const record = {
    id,
    source: options.source,
    category: normalizeCategory(raw.category ?? raw.vendorCategory),
    title,
    brand,
    modelNumber: modelNumber || (ean ? `ean:${ean}` : ""),
    ...(ean ? { ean } : {}),
    price,
    mrp,
    rating: clampRating(raw.rating),
    ratingCount: Math.max(0, Math.round(raw.ratingCount ?? 0)),
    sellerName: String(raw.sellerName ?? "").trim() || "Unknown seller",
    isOfficialStore: raw.isOfficialStore === true,
    inStock: raw.inStock !== false,
    deliveryEstimate:
      String(raw.deliveryEstimate ?? "").trim() || "Delivery estimate unavailable",
    url,
    imageUrl,
    fetchedAt: options.fetchedAt ?? new Date().toISOString(),
  };

  return productSchema.parse(record);
}

/**
 * Normalize a batch: skip untrustworthy records (with a logged reason) instead
 * of failing an entire search because one seller sent garbage.
 */
export function normalizeProducts(
  raws: RawProduct[],
  options: NormalizeOptions,
): Product[] {
  const out: Product[] = [];
  for (const raw of raws) {
    try {
      out.push(normalizeProduct(raw, options));
    } catch (err) {
      logger.warn("products.normalize.skipped", {
        id: String(raw.id ?? "(unknown)"),
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return out;
}

function clampRating(rating: number | null | undefined): number {
  if (rating === null || rating === undefined || !Number.isFinite(rating)) return 0;
  return Math.min(5, Math.max(0, Math.round(rating * 10) / 10));
}

function fallbackImage(id: string, source: string): string {
  return `https://cdn.shoppilot.local/products/${source}-${encodeURIComponent(id)}.jpg`;
}

/** Transport-level failure helper so adapters share one error mapping. */
export function sourceTransportError(
  sourceId: string,
  detail: string,
  status?: number,
): never {
  throw new ExternalServiceError(
    status === 504 ? 504 : 502,
    `Product source "${sourceId}" request failed${status ? ` (${status})` : ""}`,
    { cause: detail },
  );
}
