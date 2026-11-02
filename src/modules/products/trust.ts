import { z } from "zod";
import type { Product } from "./types";

/**
 * Seller trust — configurable, code-enforced (never the LLM's opinion).
 *
 * Policy:
 *  - a listing must meet the minimum rating AND minimum rating count
 *  - official brand stores are preferred when ranking
 *  - third-party sellers are always LABELED, never hidden silently
 *
 * Defaults come from env (TRUST_MIN_RATING / TRUST_MIN_RATING_COUNT), so
 * tuning trust is a config change, not a code change.
 */

export const trustPolicySchema = z.object({
  /** Minimum star rating (0–5) for a listing to be considered trusted. */
  minRating: z.number().min(0).max(5).default(4.0),
  /** Minimum number of ratings — protects against 5.0 from 3 people. */
  minRatingCount: z.number().int().min(0).default(50),
  /** Whether official stores may bypass the numeric thresholds. */
  officialBypass: z.boolean().default(true),
});

export type TrustPolicy = z.infer<typeof trustPolicySchema>;

export const DEFAULT_TRUST_POLICY: TrustPolicy = trustPolicySchema.parse({});

export type SellerKind = "official_store" | "third_party";

export interface TrustVerdict {
  /** Trust policy passes (rating + count thresholds). */
  trusted: boolean;
  sellerKind: SellerKind;
  /** Why it failed, when it did. Empty when trusted. */
  reasons: string[];
}

/** Classify + evaluate a single listing against a policy. */
export function evaluateTrust(
  product: Product,
  policy: TrustPolicy = DEFAULT_TRUST_POLICY,
): TrustVerdict {
  const sellerKind: SellerKind = product.isOfficialStore
    ? "official_store"
    : "third_party";
  const reasons: string[] = [];

  if (product.rating < policy.minRating) {
    reasons.push(
      `rating ${product.rating.toFixed(1)} is below the minimum ${policy.minRating.toFixed(1)}`,
    );
  }
  if (product.ratingCount < policy.minRatingCount) {
    reasons.push(
      `only ${product.ratingCount} ratings, minimum is ${policy.minRatingCount}`,
    );
  }

  const passes = reasons.length === 0;
  // Official stores are the brand's own channel: policy decides whether they
  // bypass the numeric thresholds (default: yes, but still counted).
  const trusted = passes || (sellerKind === "official_store" && policy.officialBypass);

  return { trusted, sellerKind, reasons: passes ? [] : reasons };
}

/**
 * Drop untrusted listings.
 *
 * `keepOfficial` (default true) retains official stores that only missed the
 * numeric bar — the brand's own store is not a random third-party seller.
 */
export function filterTrusted(
  products: Product[],
  policy: TrustPolicy = DEFAULT_TRUST_POLICY,
  options: { keepOfficial?: boolean } = {},
): Product[] {
  const keepOfficial = options.keepOfficial ?? true;
  // `keepOfficial` only decides whether the policy's official-store bypass is
  // honoured here. Turning it off must actually drop official stores that miss
  // the numeric bar — otherwise the option is a no-op whenever the policy
  // allows a bypass.
  const effectivePolicy = keepOfficial ? policy : { ...policy, officialBypass: false };
  return products.filter((p) => evaluateTrust(p, effectivePolicy).trusted);
}

/**
 * Rank for display: official stores first, then trusted, then higher rating,
 * then more ratings, then cheaper. Deterministic tiebreak on id.
 */
export function rankByTrust(
  products: Product[],
  policy: TrustPolicy = DEFAULT_TRUST_POLICY,
): Product[] {
  return [...products].sort((a, b) => {
    const va = evaluateTrust(a, policy);
    const vb = evaluateTrust(b, policy);
    return (
      Number(vb.sellerKind === "official_store") -
        Number(va.sellerKind === "official_store") ||
      Number(vb.trusted) - Number(va.trusted) ||
      b.rating - a.rating ||
      b.ratingCount - a.ratingCount ||
      a.price - b.price ||
      a.id.localeCompare(b.id)
    );
  });
}

/** Human-readable label for UI/handoff ("Official store" / "Third-party seller"). */
export function sellerKindLabel(product: Product): string {
  return product.isOfficialStore ? "Official store" : "Third-party seller";
}
