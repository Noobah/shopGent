import { describe, it, expect } from "vitest";
import {
  AppError,
  ValidationError,
  AuthError,
  NotFoundError,
  RateLimitError,
  ExternalServiceError,
  handleApiError,
} from "@/lib/errors";

async function readBody(res: Response) {
  return (await res.json()) as { error: { code: string; message: string } };
}

describe("error classes", () => {
  it("sets status codes and codes correctly", () => {
    expect(new ValidationError().statusCode).toBe(400);
    expect(new ValidationError().code).toBe("VALIDATION_ERROR");
    expect(new AuthError().statusCode).toBe(401);
    expect(new NotFoundError().statusCode).toBe(404);
    expect(new RateLimitError().statusCode).toBe(429);
    expect(new ExternalServiceError().statusCode).toBe(502);
    expect(new ExternalServiceError(504).statusCode).toBe(504);
  });

  it("supports custom messages", () => {
    expect(new ValidationError("bad email").message).toBe("bad email");
  });
});

describe("handleApiError", () => {
  it("maps AppError to its status and standardized body", async () => {
    const res = handleApiError(new ValidationError("name is required"));
    expect(res.status).toBe(400);
    const body = await readBody(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toBe("name is required");
  });

  it("maps unknown errors to a generic 500 without leaking internals", async () => {
    const res = handleApiError(new Error("secret internal db password leaked"));
    expect(res.status).toBe(500);
    const body = await readBody(res);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(body.error.message).toBe("Internal server error");
    expect(body.error.message).not.toContain("secret");
  });

  it("does not expose non-exposable AppError messages", async () => {
    const err = new AppError(500, "INTERNAL_ERROR", "internal detail", {
      expose: false,
    });
    const res = handleApiError(err);
    expect(res.status).toBe(500);
    const body = await readBody(res);
    expect(body.error.message).toBe("Internal server error");
  });

  it("maps a ZodError to 400 with a field summary", async () => {
    const { z } = await import("zod");
    const schema = z.object({ email: z.email() });
    const result = schema.safeParse({ email: "nope" });
    expect(result.success).toBe(false);
    if (result.success) return;

    const res = handleApiError(result.error);
    expect(res.status).toBe(400);
    const body = await readBody(res);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(body.error.message).toContain("email");
  });

  it("handles non-Error thrown values", async () => {
    const res = handleApiError("a bare string");
    expect(res.status).toBe(500);
    const body = await readBody(res);
    expect(body.error.code).toBe("INTERNAL_ERROR");
  });
});
