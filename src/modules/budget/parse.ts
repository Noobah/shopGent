/**
 * Deterministic budget extraction.
 *
 * The user states a budget in plain language ("gaming setup under ₹60,000",
 * "budget is 60k"). The LLM never decides the budget: this parser turns the
 * message into integer paise ONCE, the loop stores it on the chat session, and
 * every budget calculation later reads that stored number.
 *
 * Deliberately conservative:
 *  - currency-marked amounts win over bare numbers
 *  - explicit multipliers (k / lakh / crore) are supported
 *  - a bare number is only accepted next to a budget cue ("under 60000"),
 *    never a quantity ("under 2 monitors")
 *  - absurd or non-positive amounts return null rather than a guess
 */

/** ₹1,000 crore — a sanity bound, not a product constraint. */
const MAX_BUDGET_PAISE = 1_000_000_000_000;
/** Smallest bare (no currency/suffix) amount accepted next to a cue. */
const MIN_BARE_BUDGET_PAISE = 10_000; // ₹100

const MULTIPLIERS: Record<string, number> = {
  k: 1_000,
  thousand: 1_000,
  l: 100_000,
  lac: 100_000,
  lakh: 100_000,
  cr: 10_000_000,
  crore: 10_000_000,
};

interface Candidate {
  amountPaise: number;
  /** Higher wins: currency marker 3, multiplier 2, bare cue 1. */
  rank: number;
  index: number;
}

const CURRENCY_RE =
  /(?:₹|rs\.?|inr)\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(k|thousand|l|lac|lakh|cr|crore)?/giu;

const CUE_BEFORE_RE =
  /\b(?:budget|under|below|within|upto|up\s*to|max(?:imum)?|less\s+than|spend(?:ing)?)\b[^0-9]{0,24}(?:₹|rs\.?|inr)?\s*([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(k|thousand|l|lac|lakh|cr|crore)?/giu;

const CUE_AFTER_RE =
  /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(k|thousand|l|lac|lakh|cr|crore)?\s*(?:budget|max(?:imum)?|limit|to\s+spend)\b/giu;

const RUPEES_AFTER_RE = /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(?:rupees|rupaye|rupee)\b/giu;

/**
 * Bare suffix amounts. `lakh`/`crore`/`thousand` are unambiguous money; a bare
 * `k` is NOT included here because display specs ("4K monitor") would otherwise
 * become budgets. Money-flagged (`₹60k`) and budget-cued ("under 60k", "60k to
 * spend") forms are matched by the other patterns above.
 */
const STANDALONE_SUFFIX_RE =
  /([0-9][0-9,]*(?:\.[0-9]{1,2})?)\s*(thousand|lac|lakh|cr|crore)\b/giu;

function toPaise(rawAmount: string, rawSuffix: string | undefined): number | null {
  const amount = Number(rawAmount.replace(/,/g, ""));
  if (!Number.isFinite(amount) || amount <= 0) return null;

  const suffix = rawSuffix?.toLowerCase();
  const multiplier = suffix ? MULTIPLIERS[suffix] : 1;
  if (!multiplier) return null;

  const paise = Math.round(amount * multiplier * 100);
  if (!Number.isSafeInteger(paise) || paise <= 0 || paise > MAX_BUDGET_PAISE) {
    return null;
  }
  return paise;
}

function collect(
  text: string,
  re: RegExp,
  rank: number,
  options: { requireBareMinimum?: boolean } = {},
): Candidate[] {
  const candidates: Candidate[] = [];
  // RegExp instances are module-level and stateful; reset before each scan.
  re.lastIndex = 0;

  for (const match of text.matchAll(re)) {
    const rawAmount = match[1];
    const rawSuffix = match[2];
    if (!rawAmount) continue;

    const amountPaise = toPaise(rawAmount, rawSuffix);
    if (amountPaise === null) continue;

    // A bare number next to "under"/"budget" is probably a quantity unless it
    // is large enough to plausibly be money. Currency/suffix amounts bypass it.
    const hasCurrency = /(?:₹|rs\.?|inr)/iu.test(match[0]);
    if (
      options.requireBareMinimum &&
      !rawSuffix &&
      !hasCurrency &&
      amountPaise < MIN_BARE_BUDGET_PAISE
    ) {
      continue;
    }

    candidates.push({
      amountPaise,
      rank,
      index: match.index ?? 0,
    });
  }

  return candidates;
}

/**
 * Extract the user's stated budget as integer paise, or null when absent.
 *
 * Pure and deterministic: the same text always yields the same number.
 */
export function parseBudgetPaise(text: string): number | null {
  if (typeof text !== "string" || text.trim() === "") return null;

  // A budget cue ("budget is ₹30,000", "under 60k") outranks an arbitrary
  // currency mention, because a message may also quote a product price.
  const candidates: Candidate[] = [
    ...collect(text, CUE_BEFORE_RE, 4, { requireBareMinimum: true }),
    ...collect(text, CUE_AFTER_RE, 4, { requireBareMinimum: true }),
    ...collect(text, CURRENCY_RE, 3),
    ...collect(text, STANDALONE_SUFFIX_RE, 2),
    ...collect(text, RUPEES_AFTER_RE, 2, { requireBareMinimum: true }),
  ];

  if (candidates.length === 0) return null;

  // Highest-confidence marker first; then the earliest mention (users usually
  // state the budget before listing items).
  candidates.sort((a, b) => b.rank - a.rank || a.index - b.index);
  return candidates[0]?.amountPaise ?? null;
}
