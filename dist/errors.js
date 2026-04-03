export function toErrorInfo(error) {
    const message = error instanceof Error && error.message.trim()
        ? error.message.trim()
        : "Unexpected agent failure.";
    return {
        message,
        code: "AGENT_RUNTIME_ERROR",
        statusCode: 500,
        retryable: false,
    };
}
