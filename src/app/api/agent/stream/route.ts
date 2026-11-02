import type { NextRequest } from "next/server";
import { z } from "zod";
import { withAsyncHandler } from "@/lib/asyncHandler";
import { connectDb } from "@/lib/db";
import { NotFoundError } from "@/lib/errors";
import { parseBody } from "@/lib/validate";
import { assertSameOrigin } from "@/modules/auth/origin";
import { requireUser } from "@/modules/auth/requireUser";
import { encodeSseEvent, type AgentEvent } from "@/modules/agent/events";
import { runAgent } from "@/modules/agent/loop";
import { enforceAgentStreamRateLimits } from "@/modules/agent/rateLimit";
import { createChatSession, getChatSessionForUser } from "@/modules/sessions";

/**
 * POST /api/agent/stream — Server-Sent Events.
 *
 * Thin transport layer:
 *  - authenticate + rate limit + ownership check BEFORE opening the stream, so
 *    those failures are ordinary JSON errors (401/404/429), not SSE errors
 *  - create a session when the client doesn't supply one
 *  - pipe the agent generator's validated events into SSE
 *  - abort the loop when the client disconnects and always close the stream
 *
 * The actual work lives in modules/agent/loop.ts; this route never imports app/
 * code into modules and never touches product/budget rules itself.
 */

const streamInputSchema = z.object({
  sessionId: z.string().min(1).optional(),
  message: z.string().trim().min(1).max(4000),
});

export const POST = withAsyncHandler(async (req: NextRequest) => {
  assertSameOrigin(req);
  await connectDb();

  const user = await requireUser();
  const userId = user._id.toString();

  await enforceAgentStreamRateLimits(req, userId);

  const body = await parseBody(streamInputSchema, req);

  let sessionId: string;
  if (body.sessionId) {
    const session = await getChatSessionForUser(userId, body.sessionId);
    if (!session) throw new NotFoundError("Chat session not found");
    sessionId = session._id.toString();
  } else {
    const session = await createChatSession(userId, {
      title: body.message.slice(0, 80),
      budgetPaise: null,
    });
    sessionId = session._id.toString();
  }

  // Link the request signal to a controller the loop can observe. A client
  // disconnect aborts the provider/tool calls and stops DB work.
  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  if (req.signal.aborted) {
    abort.abort();
  } else {
    req.signal.addEventListener("abort", onAbort, { once: true });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let doneSent = false;

      const send = (event: AgentEvent): void => {
        if (abort.signal.aborted) return;
        try {
          controller.enqueue(encoder.encode(encodeSseEvent(event)));
          if (event.type === "done") doneSent = true;
        } catch {
          // The consumer went away between the abort check and enqueue.
          abort.abort();
        }
      };

      try {
        for await (const event of runAgent({
          userId,
          sessionId,
          userMessage: body.message,
          signal: abort.signal,
        })) {
          if (abort.signal.aborted) break;
          send(event);
        }
      } catch (err) {
        // runAgent catches its own failures and emits error/done. This is a
        // last-resort guard so a bug can never leave an open, silent stream.
        void err;
        if (!abort.signal.aborted) {
          send({
            type: "error",
            code: "INTERNAL_ERROR",
            message: "The agent stream failed.",
          });
          if (!doneSent) {
            send({
              type: "done",
              sessionId,
              status: "error",
              steps: 0,
            });
          }
        }
      } finally {
        req.signal.removeEventListener("abort", onAbort);
        try {
          controller.close();
        } catch {
          // Already closed or cancelled.
        }
      }
    },
    cancel() {
      abort.abort();
      req.signal.removeEventListener("abort", onAbort);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});
