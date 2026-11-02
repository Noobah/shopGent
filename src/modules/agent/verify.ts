import { formatInr } from "@/modules/budget";

/**
 * No-invented-numbers post-check.
 *
 * The model is allowed to write prose, but every amount, product name and URL in
 * the final answer must trace back to a tool result (or the code-owned budget).
 * This is intentionally conservative: a false positive costs one regeneration,
 * while a false negative puts a made-up price in front of a shopper.
 *
 * Checks:
 *  - currency amounts (₹ / Rs / INR, with k/lakh/crore multipliers)
 *  - quoted product names (must be a known title/brand/model substring)
 *  - model-like tokens (e.g. WH-1000XM5) when not present in tool data
 *  - outbound URLs (must be one of the URLs returned by a tool)
 */

export interface VerificationContext {
  text: string;
  budgetPaise: number | null;
  /** Every successful tool payload in this run, plus tool payloads from history. */
  toolPayloads: unknown[];
}

export interface VerificationResult {
  ok: boolean;
  violations: string[];
  knownAmountsPaise: number[];
}

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  l: 100_000,
  lac: 100_000,
  lakh: 100_000,
  cr: 10_000_000,
  crore: 10_000_000,
};

const MONEY_RE =
  /(?:₹|rs\.?\s*|inr\s*)([0-9][0-9,]*(?:\.[0-9]{1,2})?)(?:\s*(k|thousand|l|lac|lakh|cr|crore))?/giu;

const MONEY_WORD_RE = /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:rupees|rupaye)\b/giu;

/**
 * Bare multiplier amounts ("1.2 lakh", "3 crore", "50 thousand"). These are
 * unambiguously money in prose. A bare `k` is included only with a decimal
 * ("1.2k") so spec tokens such as "4K" are never treated as cash.
 */
const BARE_MULTIPLIER_RE =
  /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(l|lac|lakh|cr|crore|thousand)\b/giu;

const BARE_K_RE = /([0-9][0-9,]*\.[0-9]{1,2})\s*(k)\b/giu;

const URL_ONLY_RE = /https?:\/\/[^\s)>"'\]]+/gu;

const QUOTED_RE = /"([^"\n]{3,80})"|“([^”\n]{3,80})”/gu;

const MODEL_TOKEN_RE =
  /\b(?=[A-Z0-9-]*[A-Z])(?=[A-Z0-9-]*[0-9])[A-Z0-9][A-Z0-9-]{2,}\b/gu;

const URL_RE = /https?:\/\/[^\s)>"'\]]+/gu;

/** Tokens that are specs/standards, not invented product names. */
const SPEC_TOKEN_ALLOWLIST = new Set([
  "4K",
  "5G",
  "8K",
  "FHD",
  "QHD",
  "UHD",
  "HDR",
  "HDR10",
  "USB",
  "USBC",
  "HDMI",
  "SSD",
  "HDD",
  "GB",
  "TB",
  "DDR4",
  "DDR5",
  "WIFI6",
  "BT5",
]);

const NAME_KEYS = new Set([
  "title",
  "brand",
  "modelNumber",
  "sellerName",
  "name",
  "productName",
]);

const URL_KEYS = new Set(["url", "imageUrl"]);

function walk(data: unknown, visit: (key: string | null, value: unknown) => void): void {
  const seen = new Set<unknown>();

  const recurse = (value: unknown, key: string | null): void => {
    if (value === null || typeof value !== "object") {
      visit(key, value);
      return;
    }
    if (seen.has(value)) return;
    seen.add(value);

    if (Array.isArray(value)) {
      for (const item of value) recurse(item, key);
      return;
    }

    for (const [childKey, childValue] of Object.entries(value)) {
      recurse(childValue, childKey);
    }
  };

  recurse(data, null);
}

/** Collect every integer-paise amount present in tool data. */
export function collectKnownAmountsPaise(toolPayloads: unknown[]): number[] {
  const amounts = new Set<number>();

  for (const payload of toolPayloads) {
    walk(payload, (key, value) => {
      if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return;
      if (key === "price" || key === "mrp" || (key !== null && /paise$/i.test(key))) {
        amounts.add(value);
      }
    });
  }

  return [...amounts].sort((a, b) => a - b);
}

interface KnownNames {
  /** Normalized names and tokens, used for substring matching. */
  keys: Set<string>;
  /** Original-cased model numbers/titles, used to seed model-token checks. */
  raw: string[];
}

export function collectKnownNames(toolPayloads: unknown[]): KnownNames {
  const keys = new Set<string>();
  const raw = new Set<string>();

  for (const payload of toolPayloads) {
    walk(payload, (key, value) => {
      if (key === null || !NAME_KEYS.has(key) || typeof value !== "string") return;
      const trimmed = value.trim();
      if (!trimmed) return;

      raw.add(trimmed);
      keys.add(normalizeKey(trimmed));
      for (const token of trimmed.split(/[^\p{L}\p{N}]+/u)) {
        if (token.length > 1) keys.add(normalizeKey(token));
      }
    });
  }

  return { keys, raw: [...raw] };
}

export function collectKnownUrls(toolPayloads: unknown[]): string[] {
  const urls = new Set<string>();

  for (const payload of toolPayloads) {
    walk(payload, (key, value) => {
      if (key === null || !URL_KEYS.has(key) || typeof value !== "string") return;
      if (/^https?:\/\//i.test(value)) urls.add(value);
    });
  }

  return [...urls];
}

/** Extract all currency mentions as integer paise. */
export function extractMoneyMentions(text: string): number[] {
  const amounts: number[] = [];

  for (const match of text.matchAll(MONEY_RE)) {
    const amount = match[1];
    if (!amount) continue;
    const paise = toPaise(amount, match[2]);
    if (paise !== null) amounts.push(paise);
  }
  for (const match of text.matchAll(MONEY_WORD_RE)) {
    const amount = match[1];
    if (!amount) continue;
    const paise = toPaise(amount, undefined);
    if (paise !== null) amounts.push(paise);
  }
  for (const match of text.matchAll(BARE_MULTIPLIER_RE)) {
    const amount = match[1];
    if (!amount) continue;
    const paise = toPaise(amount, match[2]);
    if (paise !== null) amounts.push(paise);
  }
  for (const match of text.matchAll(BARE_K_RE)) {
    const amount = match[1];
    if (!amount) continue;
    const paise = toPaise(amount, match[2]);
    if (paise !== null) amounts.push(paise);
  }

  return [...new Set(amounts)];
}

export function verifyFinalAnswer(context: VerificationContext): VerificationResult {
  const text = context.text.trim();
  const violations: string[] = [];

  if (!text) {
    return {
      ok: false,
      violations: ["The final answer is empty."],
      knownAmountsPaise: [],
    };
  }

  const knownAmounts = new Set(collectKnownAmountsPaise(context.toolPayloads));
  if (context.budgetPaise !== null) knownAmounts.add(context.budgetPaise);

  // 1) Amounts.
  for (const amount of extractMoneyMentions(text)) {
    if (!knownAmounts.has(amount)) {
      violations.push(
        `Amount ${formatInr(amount)} was not returned by any tool (known amounts: ${
          [...knownAmounts]
            .sort((a, b) => a - b)
            .map(formatInr)
            .join(", ") || "none"
        }).`,
      );
    }
  }

  // 2) URLs.
  const knownUrls = new Set(collectKnownUrls(context.toolPayloads));
  for (const match of text.matchAll(URL_RE)) {
    const rawUrl = match[0].replace(/[.,;:!?]+$/u, "");
    if (!knownUrls.has(rawUrl)) {
      violations.push(`URL ${rawUrl} was not returned by any tool.`);
    }
  }

  // 3) Quoted product names.
  // URLs are validated separately above; mask them so an id embedded in a
  // query string (for example an ASIN) is not mistaken for an invented model.
  const textForNames = text.replace(URL_ONLY_RE, " ");
  const knownNames = collectKnownNames(context.toolPayloads);
  for (const match of textForNames.matchAll(QUOTED_RE)) {
    const quote = (match[1] ?? match[2] ?? "").trim();
    if (!isProductLikeQuote(quote)) continue;
    if (!isKnownName(quote, knownNames.keys)) {
      violations.push(`Quoted name "${quote}" was not returned by any tool.`);
    }
  }

  // 4) Model-like tokens (WH-1000XM5, 27UL650-W, ...).
  for (const match of textForNames.matchAll(MODEL_TOKEN_RE)) {
    const token = match[0];
    if (SPEC_TOKEN_ALLOWLIST.has(token.toUpperCase())) continue;
    if (isKnownName(token, knownNames.keys)) continue;
    violations.push(`Model-like token "${token}" was not returned by any tool.`);
  }

  return {
    ok: violations.length === 0,
    // Deduplicate while keeping the first occurrence order.
    violations: [...new Set(violations)],
    knownAmountsPaise: [...knownAmounts].sort((a, b) => a - b),
  };
}

// ---- helpers -------------------------------------------------------------

function toPaise(rawAmount: string, rawSuffix: string | undefined): number | null {
  const value = Number(rawAmount.replace(/,/g, ""));
  if (!Number.isFinite(value) || value < 0) return null;
  const suffix = rawSuffix?.toLowerCase();
  const multiplier = suffix ? MULTIPLIERS[suffix] : 1;
  if (!multiplier) return null;
  const paise = Math.round(value * multiplier * 100);
  return Number.isSafeInteger(paise) ? paise : null;
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
}

function isKnownName(value: string, knownKeys: Set<string>): boolean {
  const key = normalizeKey(value);
  if (key.length < 3) return false;
  for (const known of knownKeys) {
    if (known.length < 3) continue;
    if (known.includes(key) || key.includes(known)) return true;
  }
  return false;
}

/**
 * Only quotes that look like product/model names are checked. All-lowercase
 * phrases such as "gaming setup" are allowed; a quoted proper name or model is
 * not, because the prompt requires exact titles from tool data.
 */
function isProductLikeQuote(quote: string): boolean {
  if (quote.length < 3) return false;
  const words = quote.split(/\s+/).filter(Boolean);
  if (words.length < 2) return false;
  return /[A-Z]/.test(quote);
}
