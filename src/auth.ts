import { createHmac, timingSafeEqual } from "node:crypto";
import { EnvironmentConfigException } from "./exceptions/ConfigException.js";

export function verifyIncomingSignature(
  timestamp: string | null,
  signature: string | null,
  rawBody: string,
) {
  const sharedSecret = process.env.AGENT_SHARED_SECRET?.trim();
  if (!sharedSecret) {
    throw new EnvironmentConfigException("AGENT_SHARED_SECRET is not configured.", "AGENT_SHARED_SECRET");
  }

  if (!timestamp || !signature) {
    throw new EnvironmentConfigException("Missing signature headers.", "AGENT_SIGNATURE");
  }

  const requestTime = Number(timestamp);
  if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > 5 * 60 * 1000) {
    throw new EnvironmentConfigException("Agent request timestamp is invalid or expired.", "AGENT_TIMESTAMP");
  }

  const expected = createHmac("sha256", sharedSecret)
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");

  const expectedBuffer = Buffer.from(expected, "hex");
  const providedBuffer = Buffer.from(signature, "hex");

  if (
    expectedBuffer.length !== providedBuffer.length ||
    !timingSafeEqual(expectedBuffer, providedBuffer)
  ) {
    throw new EnvironmentConfigException("Agent request signature is invalid.", "AGENT_SIGNATURE");
  }
}
