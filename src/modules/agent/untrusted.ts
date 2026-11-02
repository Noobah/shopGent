/**
 * Prompt-injection boundary for product/tool data.
 *
 * Product titles, seller names, delivery strings and URLs are attacker-controlled
 * in a live source. We cannot "sanitize" meaning out of them, so we do two
 * things instead:
 *   1. serialize them as JSON DATA inside a clearly labelled wrapper
 *   2. escape the characters that could break out of that wrapper
 *
 * The system prompt tells the model that everything inside the wrapper is data,
 * never instructions. The wrapper is also what the verifier parses back out when
 * it needs the known amounts from earlier turns.
 */

const OPEN = "<untrusted_product_data";
const CLOSE = "</untrusted_product_data>";

/** Escape characters that could terminate or spoof the data wrapper. */
export function escapeUntrustedJson(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * Serialize a complete tool result (success or error envelope) for the model.
 * `toolName` comes from our registry, never from product data.
 */
export function wrapToolResult(toolName: string, payload: unknown): string {
  const json = escapeUntrustedJson(JSON.stringify(payload));
  return `${OPEN} tool="${toolName}">\n${json}\n${CLOSE}`;
}

/**
 * Read the JSON payload back out of a wrapped tool message.
 *
 * Returns null for messages that are not in our wrapper (or were corrupted),
 * so callers can fall back to ignoring that history entry.
 */
export function extractToolPayload(content: string | null | undefined): unknown {
  if (!content) return null;

  const openEnd = content.indexOf(">");
  const closeStart = content.lastIndexOf(CLOSE);
  if (!content.startsWith(OPEN) || openEnd === -1 || closeStart === -1) {
    return null;
  }

  const raw = content.slice(openEnd + 1, closeStart).trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}
