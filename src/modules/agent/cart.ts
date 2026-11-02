import { z } from "zod";
import type { CartItem } from "@/modules/sessions";

/**
 * A cart as the client sees it.
 *
 * Line totals and the subtotal are computed HERE from integer paise — the LLM
 * never produces them. Shipping/tax are deliberately absent: they are cart-level
 * rules, not product data, and the budget result reports whether they are known.
 */

export const cartLineViewSchema = z.object({
  productId: z.string().min(1),
  source: z.string().min(1),
  title: z.string().min(1),
  brand: z.string().min(1),
  modelNumber: z.string().min(1),
  quantity: z.number().int().min(1).max(99),
  unitPricePaise: z.number().int().min(0),
  lineTotalPaise: z.number().int().min(0),
  sellerName: z.string().min(1),
  isOfficialStore: z.boolean(),
  deliveryEstimate: z.string().min(1),
  url: z.string().url(),
  imageUrl: z.string().url(),
});

export type CartLineView = z.infer<typeof cartLineViewSchema>;

export const cartViewSchema = z.object({
  sessionId: z.string().min(1),
  itemCount: z.number().int().min(0),
  subtotalPaise: z.number().int().min(0),
  lines: z.array(cartLineViewSchema),
});

export type CartView = z.infer<typeof cartViewSchema>;

/** Build the public cart view from persisted lines. */
export function toCartView(sessionId: string, lines: CartItem[]): CartView {
  const viewLines: CartLineView[] = lines.map((line) => ({
    productId: line.productId,
    source: line.source,
    title: line.title,
    brand: line.brand,
    modelNumber: line.modelNumber,
    quantity: line.quantity,
    unitPricePaise: line.unitPricePaise,
    lineTotalPaise: line.unitPricePaise * line.quantity,
    sellerName: line.sellerName,
    isOfficialStore: line.isOfficialStore,
    deliveryEstimate: line.deliveryEstimate,
    url: line.url,
    imageUrl: line.imageUrl,
  }));

  const itemCount = viewLines.reduce((sum, line) => sum + line.quantity, 0);
  const subtotalPaise = viewLines.reduce((sum, line) => sum + line.lineTotalPaise, 0);

  return cartViewSchema.parse({
    sessionId,
    itemCount,
    subtotalPaise,
    lines: viewLines,
  });
}
