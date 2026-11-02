// @vitest-environment node

import { NextRequest } from "next/server";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * SSE Route Handler tests for POST /api/agent/stream.
 *
 * `next/headers` is mocked with an in-memory cookie jar so the real
 * requireUser() path runs against the test DB. The route is imported AFTER the
 * mock, and each test injects a scripted MockProvider via the LLM singleton.
 */

const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => {
      jar.set(name, value);
    },
    delete: (name: string) => {
      jar.delete(name);
    },
  }),
}));

const { POST } = await import("@/app/api/agent/stream/route");
const { connectDb, disconnectDb } = await import("@/lib/db");
const { setRateLimiter } = await import("@/lib/rateLimit");
const { setLLMProvider } = await import("@/modules/llm");
const { MockProvider } = await import("@/modules/llm/mock");
const { decodeSseEvents } = await import("@/modules/agent/events");
const { UserModel, SessionModel } = await import("@/modules/auth/models");
const { createSession } = await import("@/modules/auth/session");
const {
  AgentUsageModel,
  CartModel,
  ChatSessionModel,
  HandoffModel,
  MessageModel,
  ToolTraceModel,
  createChatSession,
  getChatSessionForUser,
  listMessagesForUser,
} = await import("@/modules/sessions");

const MONITOR_ID = "el-mon-001";
const MONITOR_URL = "https://www.amazon.in/dp/B08XXXX001";
const FINAL_TEXT =
  `The LG UltraGear 27UL650 27-inch 4K UHD IPS Gaming Monitor is ₹34,999.00. ` +
  `Link: ${MONITOR_URL}`;

async function makeUser(email: string): Promise<string> {
  const user = await UserModel.create({
    email,
    passwordHash: "test-hash",
    displayName: "Test User",
  });
  return user._id.toString();
}

function streamRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost:3000/api/agent/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  await connectDb();
});

afterAll(async () => {
  await disconnectDb();
});

beforeEach(async () => {
  setLLMProvider(null);
  setRateLimiter(null);
  jar.clear();
  await Promise.all([
    UserModel.deleteMany({}),
    SessionModel.deleteMany({}),
    ChatSessionModel.deleteMany({}),
    MessageModel.deleteMany({}),
    CartModel.deleteMany({}),
    ToolTraceModel.deleteMany({}),
    HandoffModel.deleteMany({}),
    AgentUsageModel.deleteMany({}),
  ]);
});

describe("POST /api/agent/stream", () => {
  it("returns 401 before opening a stream when there is no session", async () => {
    const response = await POST(streamRequest({ message: "find a monitor" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 404 for another user's chat session", async () => {
    const owner = await makeUser("owner@example.com");
    await createSession(owner);
    const chat = await createChatSession(owner, { title: "private" });

    const intruder = await makeUser("intruder@example.com");
    jar.clear();
    await createSession(intruder);

    const response = await POST(
      streamRequest({ sessionId: chat._id.toString(), message: "hello" }),
    );
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("streams the expected SSE event sequence and persists the conversation", async () => {
    const user = await makeUser("stream@example.com");
    await createSession(user);

    setLLMProvider(
      new MockProvider({
        sequence: [
          {
            steps: [
              {
                kind: "tool_call",
                id: "s1",
                name: "search_products",
                input: { query: "monitor", officialOnly: true },
              },
            ],
          },
          {
            steps: [
              {
                kind: "tool_call",
                id: "s2",
                name: "add_to_cart",
                input: { productId: MONITOR_ID, quantity: 1 },
              },
            ],
          },
          {
            steps: [
              {
                kind: "tool_call",
                id: "s3",
                name: "check_budget",
                input: { flatShippingPaise: 0, taxRatePercent: 0 },
              },
            ],
          },
          {
            steps: [{ kind: "tool_call", id: "s4", name: "build_handoff", input: {} }],
          },
          { steps: [{ kind: "text", text: FINAL_TEXT }] },
        ],
      }),
    );

    const response = await POST(
      streamRequest({ message: "I need a monitor under ₹60,000" }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(response.body).not.toBeNull();

    const events = decodeSseEvents(await response.text());

    expect(events[0]).toMatchObject({ type: "status", status: "started" });
    expect(events.some((event) => event.type === "tool_start")).toBe(true);
    expect(events.filter((event) => event.type === "tool_result")).toHaveLength(4);
    expect(events.some((event) => event.type === "cart_update")).toBe(true);
    expect(events.some((event) => event.type === "handoff_ready")).toBe(true);

    const done = events.at(-1);
    expect(done).toMatchObject({
      type: "done",
      status: "handoff_ready",
      steps: 5,
    });
    if (done?.type !== "done") throw new Error("last event must be done");

    const messageText = events
      .filter((event) => event.type === "message_delta")
      .map((event) => event.delta)
      .join("");
    expect(messageText).toBe(FINAL_TEXT);

    const stored = await getChatSessionForUser(user, done.sessionId);
    expect(stored?.budgetPaise).toBe(6_000_000);
    expect(stored?.status).toBe("handoff_ready");
    const messages = await listMessagesForUser(user, done.sessionId);
    expect(messages.at(-1)).toMatchObject({ role: "assistant", content: FINAL_TEXT });
  });

  it("aborts cleanly when the client cancels the response body", async () => {
    const user = await makeUser("disconnect@example.com");
    await createSession(user);

    setLLMProvider(
      new MockProvider({
        sequence: [
          {
            steps: [
              {
                kind: "tool_call",
                id: "d1",
                name: "search_products",
                input: { query: "monitor" },
              },
            ],
          },
        ],
        delayMs: 20,
      }),
    );

    const response = await POST(
      streamRequest({ message: "I need a monitor under ₹60,000" }),
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error("missing response body");

    const first = await reader.read();
    expect(first.done).toBe(false);
    await expect(reader.cancel()).resolves.toBeUndefined();
    await expect(reader.read()).resolves.toMatchObject({ done: true });

    // Let the aborted generator finish its cleanup before inspecting the DB.
    await new Promise((resolve) => setTimeout(resolve, 30));

    const sessions = await ChatSessionModel.find({ userId: user });
    expect(sessions).toHaveLength(1);
    const messages = await listMessagesForUser(user, sessions[0]!._id.toString());
    // A cancelled stream may have persisted the user turn (and even a tool-call
    // turn), but it must never write a fabricated final answer.
    const finalAnswers = messages.filter(
      (message) => message.role === "assistant" && (message.toolCalls ?? []).length === 0,
    );
    expect(finalAnswers).toHaveLength(0);
  });

  it("rejects a malformed body with 400 and a typed error", async () => {
    const user = await makeUser("bad-body@example.com");
    await createSession(user);

    const response = await POST(streamRequest({ message: "" }));
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
  });

  it("rejects a cross-origin POST", async () => {
    const user = await makeUser("csrf@example.com");
    await createSession(user);

    const req = new NextRequest("http://localhost:3000/api/agent/stream", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://evil.example.com",
      },
      body: JSON.stringify({ message: "hello" }),
    });
    const response = await POST(req);
    expect(response.status).toBe(403);
    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });
});
