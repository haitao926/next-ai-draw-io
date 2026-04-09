import { APICallError, LoadAPIKeyError } from "ai"

export interface ModelFailoverHeaderParams {
    actualModelId: string
    actualProvider: string
    actualSelectedModelId?: string | null
    requestedSelectedModelId?: string | null
    attemptedSelectedModelIds?: string[]
}

export function shouldFailoverToNextModel(error: unknown): boolean {
    if (APICallError.isInstance(error) || LoadAPIKeyError.isInstance(error)) {
        return true
    }

    const status =
        typeof error === "object" && error !== null
            ? Number(
                  (error as { statusCode?: unknown; status?: unknown })
                      .statusCode ??
                      (error as { statusCode?: unknown; status?: unknown })
                          .status,
              )
            : Number.NaN

    if (
        Number.isFinite(status) &&
        (status === 401 ||
            status === 403 ||
            status === 404 ||
            status === 408 ||
            status === 409 ||
            status === 429 ||
            status >= 500)
    ) {
        return true
    }

    const message =
        error instanceof Error
            ? error.message.toLowerCase()
            : typeof error === "string"
              ? error.toLowerCase()
              : ""

    if (!message) return false

    return [
        "cannot connect to api",
        "fetch failed",
        "network error",
        "connection error",
        "connection refused",
        "connection reset",
        "socket hang up",
        "service unavailable",
        "gateway timeout",
        "bad gateway",
        "timeout",
        "timed out",
        "temporarily unavailable",
        "overloaded",
        "rate limit",
        "model not found",
        "provider unavailable",
        "econnreset",
        "eai_again",
        "enotfound",
    ].some((token) => message.includes(token))
}

export function buildModelFailoverHeaders(
    params: ModelFailoverHeaderParams,
): Headers {
    const headers = new Headers({
        "x-ai-actual-model-id": params.actualModelId,
        "x-ai-actual-provider": params.actualProvider,
    })

    if (params.actualSelectedModelId) {
        headers.set(
            "x-ai-actual-selected-model-id",
            params.actualSelectedModelId,
        )
    }

    if (
        params.requestedSelectedModelId &&
        params.actualSelectedModelId &&
        params.requestedSelectedModelId !== params.actualSelectedModelId
    ) {
        headers.set("x-ai-fallback-applied", "true")
        headers.set(
            "x-ai-fallback-from-selected-model-id",
            params.requestedSelectedModelId,
        )
    } else {
        headers.set("x-ai-fallback-applied", "false")
    }

    if (
        params.attemptedSelectedModelIds &&
        params.attemptedSelectedModelIds.length > 0
    ) {
        headers.set(
            "x-ai-attempted-selected-model-ids",
            params.attemptedSelectedModelIds.join(","),
        )
    }

    return headers
}
