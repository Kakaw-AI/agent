import { createHmac, timingSafeEqual } from "node:crypto";
export function verifyIncomingSignature(timestamp, signature, rawBody) {
    const sharedSecret = process.env.AGENT_SHARED_SECRET?.trim();
    if (!sharedSecret) {
        throw new Error("AGENT_SHARED_SECRET is not configured.");
    }
    if (!timestamp || !signature) {
        throw new Error("Missing signature headers.");
    }
    const requestTime = Number(timestamp);
    if (!Number.isFinite(requestTime) || Math.abs(Date.now() - requestTime) > 5 * 60 * 1000) {
        throw new Error("Agent request timestamp is invalid or expired.");
    }
    const expected = createHmac("sha256", sharedSecret)
        .update(`${timestamp}.${rawBody}`)
        .digest("hex");
    const expectedBuffer = Buffer.from(expected, "hex");
    const providedBuffer = Buffer.from(signature, "hex");
    if (expectedBuffer.length !== providedBuffer.length ||
        !timingSafeEqual(expectedBuffer, providedBuffer)) {
        throw new Error("Agent request signature is invalid.");
    }
}
