import { createHmac, timingSafeEqual } from "node:crypto";
import { EnvironmentConfigException } from "./exceptions/ConfigException.js";

/** A caller that is not the backend. Answered with 401, not logged as a failure. */
export class SignatureError extends Error {}

/**
 * The checks that need no body. They run before the body is read, so an
 * unsigned caller cannot make the agent buffer up to 64 MB first.
 */
export function checkSignatureHeaders(timestamp: string | null, signature: string | null) {
  if (!timestamp || !signature) {
    throw new SignatureError("Missing signature headers.");
  }

  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > 5 * 60 * 1000) {
    throw new SignatureError("Agent request timestamp is invalid or expired.");
  }
}

export function verifyIncomingSignature(
  timestamp: string | null,
  signature: string | null,
  rawBody: string,
) {
  const sharedSecret = process.env.AGENT_SHARED_SECRET?.trim();
  if (!sharedSecret) {
    throw new EnvironmentConfigException("AGENT_SHARED_SECRET is not configured.", "AGENT_SHARED_SECRET");
  }

  checkSignatureHeaders(timestamp, signature);

  const expected = createHmac("sha256", sharedSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(signature!, "hex");

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    throw new SignatureError("Agent request signature is invalid.");
  }
}
