import { describe, expect, it } from "vitest";
import { MockProvider, collectStream } from "@/modules/llm";

/**
 * The agent loop calls chat() once per turn, so MockProvider needs a per-call
 * sequence. The last script repeats, which is what drives the step-cap test.
 */

describe("MockProvider sequence", () => {
  it("advances one script per chat() call and repeats the last", async () => {
    const provider = new MockProvider({
      sequence: [
        { steps: [{ kind: "text", text: "one" }] },
        { steps: [{ kind: "text", text: "two" }] },
      ],
    });

    const first = await collectStream(provider.chat({ messages: [] }));
    const second = await collectStream(provider.chat({ messages: [] }));
    const third = await collectStream(provider.chat({ messages: [] }));

    expect(first.text).toBe("one");
    expect(second.text).toBe("two");
    expect(third.text).toBe("two");
    expect(provider.calls).toHaveLength(3);
  });

  it("resetSequence starts the sequence over", async () => {
    const provider = new MockProvider({
      sequence: [{ steps: [{ kind: "text", text: "again" }] }],
    });
    await collectStream(provider.chat({ messages: [] }));
    provider.resetSequence();
    const result = await collectStream(provider.chat({ messages: [] }));
    expect(result.text).toBe("again");
    expect(provider.calls).toHaveLength(2);
  });

  it("still selects scripts by last user message when no sequence is given", async () => {
    const provider = new MockProvider({
      scripts: {
        hello: { steps: [{ kind: "text", text: "hi there" }] },
        default: { steps: [{ kind: "text", text: "fallback" }] },
      },
    });

    const matched = await collectStream(
      provider.chat({ messages: [{ role: "user", content: "hello" }] }),
    );
    const fallback = await collectStream(
      provider.chat({ messages: [{ role: "user", content: "other" }] }),
    );

    expect(matched.text).toBe("hi there");
    expect(fallback.text).toBe("fallback");
  });
});
