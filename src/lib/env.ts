import { z } from "zod";

/**
 * Environment schema.
 *
 * Next.js already loads `.env*` files into `process.env` natively, so we do NOT
 * use the `dotenv` package. This module's only job is to VALIDATE and TYPE the
 * already-loaded env at startup so a missing/malformed var fails fast with a
 * clear message instead of crashing mid-request.
 *
 * To add a var: add it here + document it in `.env.example`.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // MongoDB connection string. No Docker on this machine, so local dev uses the
  // system mongod (see docker-compose.yml for the portable alternative).
  MONGODB_URI: z.string().min(1, "MONGODB_URI is required"),

  // --- LLM (LLMProvider seam) --------------------------------------------
  // Which provider adapter to construct. `mock` is the default for dev and all
  // tests so no API key is ever required to boot the app or run the suite.
  LLM_PROVIDER: z.enum(["mock", "grok"]).default("mock"),

  // xAI Grok speaks an OpenAI-compatible API. Only required when
  // LLM_PROVIDER=grok; the factory enforces presence at construction time so
  // the app still boots with the mock when no key is set.
  GROK_API_KEY: z.string().optional(),
  GROK_MODEL: z.string().min(1).default("grok-3"),
  GROK_BASE_URL: z.string().url().default("https://api.x.ai"),

  // Live external tests only run when explicitly enabled (default off).
  RUN_LIVE_TESTS: z
    .enum(["0", "1"])
    .default("0")
    .transform((v) => v === "1"),
});

export type Env = z.infer<typeof envSchema>;

let cached: Env | null = null;

/** Parse and validate `process.env`, throwing a readable error on failure. */
export function getEnv(): Env {
  if (cached) return cached;

  const parsed = envSchema.safeParse(process.env);

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => {
        const key = issue.path.join(".") || "(root)";
        return `  • ${key}: ${issue.message}`;
      })
      .join("\n");
    throw new Error(
      `Invalid environment variables:\n${issues}\n\nCopy .env.example to .env and fill in the values.`,
    );
  }

  cached = parsed.data;
  return cached;
}

/**
 * Validated env, available as a typed object.
 *
 * Accessed lazily via a Proxy so that merely importing this module (e.g. during
 * `next build` or in a unit test) does NOT throw before env is set. The first
 * property access triggers validation.
 */
export const env = new Proxy({} as Env, {
  get(_target, prop) {
    return getEnv()[prop as keyof Env];
  },
  has(_target, prop) {
    return prop in getEnv();
  },
  ownKeys() {
    return Reflect.ownKeys(getEnv());
  },
  getOwnPropertyDescriptor(_target, prop) {
    return Object.getOwnPropertyDescriptor(getEnv(), prop);
  },
});

/** Test-only: clear the cache so a test can mutate process.env and re-validate. */
export function resetEnvCache(): void {
  cached = null;
}
