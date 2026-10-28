import { describe, it, expect } from "vitest";
import { z } from "zod";
import { parseBody, parseObject, parseQuery } from "@/lib/validate";
import { ValidationError } from "@/lib/errors";
import { NextRequest } from "next/server";

function makeRequest(body: unknown, url = "http://localhost/api"): NextRequest {
  return new NextRequest(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("parseBody", () => {
  it("parses a valid JSON body", async () => {
    const schema = z.object({ name: z.string(), age: z.number() });
    const req = makeRequest({ name: "Ada", age: 30 });
    await expect(parseBody(schema, req)).resolves.toEqual({ name: "Ada", age: 30 });
  });

  it("throws ValidationError on invalid fields", async () => {
    const schema = z.object({ email: z.email() });
    const req = makeRequest({ email: "nope" });
    await expect(parseBody(schema, req)).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ValidationError on malformed JSON", async () => {
    const schema = z.object({ a: z.string() });
    const req = new NextRequest("http://localhost/api", {
      method: "POST",
      body: "{ not json",
    });
    await expect(parseBody(schema, req)).rejects.toThrow(/valid JSON/);
  });

  it("applies defaults", async () => {
    const schema = z.object({ limit: z.number().default(10) });
    const req = makeRequest({});
    await expect(parseBody(schema, req)).resolves.toEqual({ limit: 10 });
  });
});

describe("parseObject", () => {
  it("validates a plain object", () => {
    const schema = z.object({ id: z.string() });
    expect(parseObject(schema, { id: "x" })).toEqual({ id: "x" });
  });

  it("throws ValidationError on mismatch", () => {
    const schema = z.object({ id: z.string() });
    expect(() => parseObject(schema, { id: 1 })).toThrow(ValidationError);
  });
});

describe("parseQuery", () => {
  it("validates query params", () => {
    const schema = z.object({ page: z.coerce.number() });
    const req = new NextRequest("http://localhost/api?page=3");
    expect(parseQuery(schema, req)).toEqual({ page: 3 });
  });

  it("throws ValidationError on bad query", () => {
    const schema = z.object({ page: z.coerce.number() });
    const req = new NextRequest("http://localhost/api?page=abc");
    expect(() => parseQuery(schema, req)).toThrow(ValidationError);
  });
});
