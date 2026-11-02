import { z } from "zod";

/**
 * Normalized Product — the single shape every source must produce.
 *
 * Money is integer paise (INR). Every field here is DATA FROM THE SOURCE; the
 * agent must never invent any of them. `fetchedAt` (UTC ISO) records freshness
 * so the handoff phase can re-fetch and show price deltas.
 *
 * Validation is part of the seam: sources hand back records, we parse them with
 * `productSchema` before anything downstream sees them.
 */

export const productCategorySchema = z.enum(["electronics", "home", "fashion"]);
export type ProductCategory = z.infer<typeof productCategorySchema>;

/** Non-negative integer paise. Fractional or negative money is a bug, not data. */
export const paiseSchema = z
  .number()
  .int("paise must be an integer")
  .min(0, "paise cannot be negative");

/** Discounted/selling price. */
export const priceSchema = paiseSchema;

/** Rating on a 0–5 scale (one decimal place in practice). */
export const ratingSchema = z.number().min(0).max(5);

export const productSchema = z.object({
  /** Stable id, unique WITHIN a source (sources never share an id space). */
  id: z.string().min(1),
  /** Which ProductSource produced this record, e.g. "mock" | "live". */
  source: z.string().min(1),
  category: productCategorySchema,

  title: z.string().min(1),
  brand: z.string().min(1),
  /** Manufacturer model code, e.g. "LG-27UL650-W". Normalized by match.ts. */
  modelNumber: z.string().min(1),
  /** Optional barcode. When present it is the strongest match key. */
  ean: z
    .string()
    .regex(/^\d{8,14}$/, "EAN must be 8–14 digits")
    .optional(),

  price: priceSchema,
  /** Maximum retail price in paise (>= price when a discount is shown). */
  mrp: paiseSchema,
  rating: ratingSchema,
  ratingCount: z.number().int().min(0),
  sellerName: z.string().min(1),
  isOfficialStore: z.boolean(),
  inStock: z.boolean(),
  /** Human-readable delivery window as reported by the source. */
  deliveryEstimate: z.string().min(1),

  /** Outbound retailer URL — must be https; allowlist is enforced at handoff. */
  url: z.string().url(),
  imageUrl: z.string().url(),
  /** UTC ISO timestamp of when the source produced this record. */
  fetchedAt: z.string().datetime({ offset: true }),
});

/** The normalized product type, inferred from its Zod schema. */
export type Product = z.infer<typeof productSchema>;

/** Parse a source record, failing loudly rather than passing bad data through. */
export function parseProduct(record: unknown): Product {
  return productSchema.parse(record);
}
