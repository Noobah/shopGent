import { AppError, ExternalServiceError, NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { normalizeProduct, normalizeProducts, sourceTransportError } from "../normalize";
import type { RawProduct } from "../normalize";
import type { GetByIdParams, ProductSource, SearchProductsParams } from "../source";
import { parseProduct, type Product } from "../types";

/**
 * LiveSource — the real HTTP ProductSource adapter.
 *
 * Wire contract with any vendor that speaks our normalized shape:
 *   GET {baseUrl}/search?query=&category=&limit=   -> { "products": RawProduct[] }
 *                                                    (a bare array is accepted)
 *   GET {baseUrl}/products/{id}                    -> RawProduct | 404
 *
 * Hardening per the build rules:
 *  - every request carries the caller's abort signal AND a timeout; the two are
 *    linked through one AbortController, and a caller abort is never reported
 *    as a timeout
 *  - non-2xx / malformed JSON / transport failures map to ExternalServiceError
 *    (502, or 504 for timeouts) — never partial garbage
 *  - upstream records are UNTRUSTED: they go through `normalizeProducts`, which
 *    rejects records with no model number/EAN and validates the final shape
 *
 * Config comes from env (PRODUCT_SOURCE_BASE_URL / PRODUCT_SOURCE_API_KEY); the
 * factory refuses to build this adapter when the base URL is missing.
 */

export interface LiveSourceOptions {
  /** Base URL without a trailing slash, e.g. https://api.example.com */
  baseUrl: string;
  /** Optional bearer token sent as `Authorization: Bearer …`. */
  apiKey?: string;
  /** Per-request timeout in ms. */
  timeoutMs?: number;
  /** Injectable fetch for tests (HTTP-level mocking). */
  fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/** Vendor payload for a search response. Loose by design — normalize decides. */
interface SearchPayload {
  products?: RawProduct[];
}

export class LiveSource implements ProductSource {
  readonly id = "live";

  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: LiveSourceOptions) {
    if (!options.baseUrl) {
      throw new ExternalServiceError(
        502,
        "LiveSource requires a base URL (set PRODUCT_SOURCE_BASE_URL)",
      );
    }
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  async search(params: SearchProductsParams): Promise<Product[]> {
    const url = new URL(`${this.baseUrl}/search`);
    if (params.query) url.searchParams.set("query", params.query);
    if (params.category) url.searchParams.set("category", params.category);
    url.searchParams.set("limit", String(params.limit));

    const payload = await this.request<SearchPayload | RawProduct[]>(url, params.signal);
    const raws: unknown = Array.isArray(payload) ? payload : payload.products;
    if (!Array.isArray(raws)) {
      throw sourceTransportError(this.id, "search response had no `products` array");
    }

    // Bad individual records are skipped (logged), not silently passed on.
    const products = normalizeProducts(raws as RawProduct[], { source: this.id });

    // The vendor is untrusted: enforce every filter the seam promised, plus
    // the hard result cap, even if the upstream ignored our query parameters.
    return (
      products
        .filter(
          (p) =>
            (params.maxPricePaise === undefined || p.price <= params.maxPricePaise) &&
            (params.minRating === undefined || p.rating >= params.minRating) &&
            (!params.officialOnly || p.isOfficialStore),
        )
        .slice(0, params.limit)
        // Belt and braces: every record we hand to the agent must parse.
        .map(parseProduct)
    );
  }

  async getById(id: string, params?: GetByIdParams): Promise<Product | null> {
    const url = new URL(`${this.baseUrl}/products/${encodeURIComponent(id)}`);
    try {
      const payload = await this.request<RawProduct | { product: RawProduct }>(
        url,
        params?.signal,
      );
      const raw = isWrapped(payload) ? payload.product : payload;
      return parseProduct(normalizeProduct(raw, { source: this.id }));
    } catch (err) {
      // A 404 from the vendor means "no such product", not a failure.
      if (err instanceof NotFoundError) return null;
      throw err;
    }
  }

  /**
   * One bounded HTTP round-trip: caller signal + timeout linked, errors mapped
   * to ExternalServiceError, body parsed as JSON.
   */
  private async request<T>(url: URL, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) {
      throw new ExternalServiceError(504, `Product source "${this.id}" request aborted`);
    }

    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          accept: "application/json",
          ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
        },
        signal: controller.signal,
      });

      if (!response.ok) {
        if (response.status === 404) {
          throw new NotFoundError(`Product source "${this.id}" has no such product`);
        }
        const detail = await safeText(response);
        throw sourceTransportError(this.id, detail, response.status);
      }

      try {
        return (await response.json()) as T;
      } catch (err) {
        throw sourceTransportError(this.id, `invalid JSON: ${errorMessage(err)}`);
      }
    } catch (err) {
      if (isAbort(err)) {
        if (signal?.aborted) {
          throw new ExternalServiceError(
            504,
            `Product source "${this.id}" request aborted`,
          );
        }
        logger.warn(`products.${this.id}.timeout`, { timeoutMs: this.timeoutMs });
        throw new ExternalServiceError(
          504,
          `Product source "${this.id}" request timed out`,
        );
      }
      if (err instanceof AppError) throw err;
      logger.error(`products.${this.id}.unknown_error`, { err });
      throw sourceTransportError(this.id, errorMessage(err));
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

function isWrapped(payload: unknown): payload is { product: RawProduct } {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "product" in payload &&
    typeof (payload as { product: unknown }).product === "object"
  );
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && err.name === "AbortError";
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return "";
  }
}
