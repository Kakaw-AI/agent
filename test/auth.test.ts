import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SignatureError, verifyIncomingSignature } from "../src/auth.js";

const sign = (timestamp: string, body: string) =>
  createHmac("sha256", "test-secret").update(`${timestamp}.${body}`).digest("hex");

describe("verifyIncomingSignature", () => {
  process.env.AGENT_SHARED_SECRET = "test-secret";
  afterEach(() => {
    process.env.AGENT_SHARED_SECRET = "test-secret";
  });

  it("accepts a fresh signed body", () => {
    const now = String(Date.now());
    expect(() => verifyIncomingSignature(now, sign(now, "{}"), "{}")).not.toThrow();
  });

  it("rejects missing headers, stale timestamps and bad signatures as SignatureError", () => {
    const now = String(Date.now());
    const stale = String(Date.now() - 10 * 60 * 1000);
    expect(() => verifyIncomingSignature(null, null, "{}")).toThrow(SignatureError);
    expect(() => verifyIncomingSignature(stale, sign(stale, "{}"), "{}")).toThrow(SignatureError);
    expect(() => verifyIncomingSignature(now, sign(now, "{}"), "{\"x\":1}")).toThrow(SignatureError);
  });

  it("treats a missing secret as a server fault, not a bad caller", () => {
    delete process.env.AGENT_SHARED_SECRET;
    const now = String(Date.now());
    const call = () => verifyIncomingSignature(now, "ab", "{}");
    expect(call).toThrow();
    expect(call).not.toThrow(SignatureError);
  });
});
