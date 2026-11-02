import { z } from "zod";
import { paiseFieldSchema } from "@/modules/budget";
import {
  compareProducts,
  filterTrusted,
  productCategorySchema,
  productSchema,
  rankByTrust,
  type Product,
} from "@/modules/products";
import { ToolError, defineTool } from "./types";

/**
 * Read-only product tools.
 *
 * All product records come from the ProductSource seam and are re-validated
 * against `productSchema` before they reach the model. Title/seller text is
 * wrapped as untrusted data by the registry; it is never interpreted here.
 */

const searchInputSchema = z.object({
  query: z.string().trim().min(1).max(200).optional(),
  category: productCategorySchema.optional(),
  /** Upper bound in integer paise. */
  maxPricePaise: paiseFieldSchema.optional(),
  minRating: z.number().min(0).max(5).optional(),
  officialOnly: z.boolean().optional(),
});

export const searchOutputSchema = z.object({
  products: z.array(productSchema),
  count: z.number().int().min(0),
  note: z.string().optional(),
});

export const searchProductsTool = defineTool({
  name: "search_products",
  description:
    "Search the product catalog by free-text query, category, maximum price (integer paise) and minimum rating. Returns at most 10 normalized products after the seller-trust policy is applied. Always search before naming a product.",
  inputSchema: searchInputSchema,
  outputSchema: searchOutputSchema,
  run: async (context, input) => {
    if (context.signal?.aborted) {
      throw new ToolError("ABORTED", "The request was cancelled.");
    }

    const found = await context.productSource.search({
      ...input,
      limit: 10,
      signal: context.signal,
    });

    const trusted = filterTrusted(found, context.trustPolicy);
    const ranked = rankByTrust(trusted, context.trustPolicy).slice(0, 10);

    return {
      output: searchOutputSchema.parse({
        products: ranked,
        count: ranked.length,
        ...(found.length > 0 && ranked.length === 0
          ? {
              note: "No listing met the seller-trust policy; do not recommend untrusted sellers.",
            }
          : {}),
      }),
    };
  },
});

const productDetailsInputSchema = z.object({
  productId: z.string().trim().min(1).max(200),
});

export const productDetailsOutputSchema = z.object({
  product: productSchema,
});

export const getProductDetailsTool = defineTool({
  name: "get_product_details",
  description:
    "Fetch current price, stock, rating, seller and delivery data for one product by the id returned from search_products. This refreshes fetchedAt from the source.",
  inputSchema: productDetailsInputSchema,
  outputSchema: productDetailsOutputSchema,
  run: async (context, input) => {
    const product = await context.productSource.getById(input.productId, {
      signal: context.signal,
    });
    if (!product) {
      throw new ToolError("NOT_FOUND", `No product found with id "${input.productId}".`);
    }
    return { output: productDetailsOutputSchema.parse({ product }) };
  },
});

const compareInputSchema = z.object({
  productIds: z.array(z.string().trim().min(1).max(200)).min(2).max(10),
});

const compareRowSchema = z.object({
  key: z.string().min(1),
  productId: z.string().min(1),
  title: z.string().min(1),
  brand: z.string().min(1),
  modelNumber: z.string().min(1),
  pricePaise: z.number().int().min(0),
  mrpPaise: z.number().int().min(0),
  rating: z.number().min(0).max(5),
  ratingCount: z.number().int().min(0),
  sellerName: z.string().min(1),
  isOfficialStore: z.boolean(),
  inStock: z.boolean(),
  deliveryEstimate: z.string().min(1),
  listingCount: z.number().int().min(1),
  minPricePaise: z.number().int().min(0),
  maxPricePaise: z.number().int().min(0),
});

export const compareOutputSchema = z.object({
  rows: z.array(compareRowSchema),
  missingProductIds: z.array(z.string()),
});

export const compareProductsTool = defineTool({
  name: "compare_products",
  description:
    "Compare 2-10 products side by side on price, rating, seller and delivery. Listings are matched by model number or EAN (never by title), so variants stay separate and duplicate listings collapse into one row.",
  inputSchema: compareInputSchema,
  outputSchema: compareOutputSchema,
  run: async (context, input) => {
    const uniqueIds = [...new Set(input.productIds)];
    const fetched = await Promise.all(
      uniqueIds.map(async (id) => ({
        id,
        product: await context.productSource.getById(id, { signal: context.signal }),
      })),
    );

    const missingProductIds = fetched
      .filter((entry) => entry.product === null)
      .map((entry) => entry.id);
    const products = fetched
      .map((entry) => entry.product)
      .filter((product): product is Product => product !== null);

    const rows = compareProducts(products).map((row) => {
      const prices = row.listings.map((listing) => listing.price);
      return compareRowSchema.parse({
        key: row.key,
        productId: row.best.id,
        title: row.best.title,
        brand: row.best.brand,
        modelNumber: row.best.modelNumber,
        pricePaise: row.best.price,
        mrpPaise: row.best.mrp,
        rating: row.best.rating,
        ratingCount: row.best.ratingCount,
        sellerName: row.best.sellerName,
        isOfficialStore: row.best.isOfficialStore,
        inStock: row.best.inStock,
        deliveryEstimate: row.best.deliveryEstimate,
        listingCount: row.listings.length,
        minPricePaise: Math.min(...prices),
        maxPricePaise: Math.max(...prices),
      });
    });

    return {
      output: compareOutputSchema.parse({ rows, missingProductIds }),
    };
  },
});
