import { z } from "zod";
import { productCategorySchema, type Product } from "./types";

/**
 * ProductSource — the SECOND and last allowed abstraction seam.
 *
 * Agent code talks only to this interface; swapping the mock for a live
 * shopping API means writing one adapter or changing an env var. Every source
 * must be cancelable (abort signal) and every call is bounded by a timeout in
 * the adapter (see sources/live.ts).
 *
 * Output rule: adapters return already-normalized `Product` records; the
 * factory-level wrapper validates them with `productSchema` so a malformed
 * upstream record can never reach the agent or the cart.
 */

export const searchProductsParamsSchema = z.object({
  /** Free-text query matched against title/brand/category. */
  query: z.string().trim().max(200).optional(),
  category: productCategorySchema.optional(),
  /** Upper bound in integer paise (INR). */
  maxPricePaise: z.number().int().min(0).optional(),
  /** Minimum rating (0–5). */
  minRating: z.number().min(0).max(5).optional(),
  /** Only products sold by the brand's own/official store. */
  officialOnly: z.boolean().optional(),
  /** Hard cap on results. Tools pass 10. */
  limit: z.number().int().min(1).max(50).default(10),
  /** Cancellation — part of the seam contract (every external call honors it). */
  signal: z.custom<AbortSignal>((v) => v instanceof AbortSignal).optional(),
});

export type SearchProductsParams = z.infer<typeof searchProductsParamsSchema>;

export interface GetByIdParams {
  signal?: AbortSignal;
}

/**
 * The source seam.
 *
 * Contract for implementations:
 *  - honor `signal` on every request and fail with ExternalServiceError on
 *    timeout/transport errors (never hang, never return partial garbage)
 *  - return Products that already satisfy `productSchema`
 *  - be deterministic under the mock (same input, same output, no clock use)
 */
export interface ProductSource {
  /** Human-readable id, e.g. "mock" or "live". Mirrors Product.source. */
  readonly id: string;
  search(params: SearchProductsParams): Promise<Product[]>;
  /** Fetch one product by its source-scoped id, or null when not found. */
  getById(id: string, params?: GetByIdParams): Promise<Product | null>;
}
