// agent-ts/src/utils/token.ts

import type { TokenUsage } from "../types.js";

export function mergeTokenUsage(
  left: TokenUsage | null | undefined,
  right: TokenUsage | null | undefined,
): TokenUsage | null {
  if (!left) {
    return right ?? null;
  }
  if (!right) {
    return left;
  }

  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
  };
}
