import type { NextRequest } from "next/server";
import { handleApiError } from "./errors";

/**
 * Wrap an async Route Handler / Server Action so any thrown or rejected value
 * is funnelled into the global error mapper. This removes try/catch boilerplate
 * from every route and guarantees the standardized `{ error: { code, message } }`
 * shape on failure.
 *
 * Usage in a route:
 *   export const POST = withAsyncHandler(async (req: NextRequest) => { ... });
 */

type HandlerArgs = [NextRequest, ...unknown[]];

export function withAsyncHandler<
  A extends HandlerArgs,
  R extends Response | Promise<Response>,
>(handler: (...args: A) => R): (...args: A) => Promise<Response> {
  return async (...args: A): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      return handleApiError(err);
    }
  };
}
