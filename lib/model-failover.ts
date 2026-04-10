import { APICallError, LoadAPIKeyError } from "ai"

export interface ModelFailoverHeaderParams {
    actualModelId: string
    actualProvider: string
    actualSelectedModelId?: string | null
    requestedSelectedModelId?: string | null
    attemptedSelectedModelIds?: string[]
}

const RETRYABLE_MESSAGE_PATTERNS = [
    "authentication failed",
    "check your credentials",
    "invalid api key",
    "invalid authentication",
    "unauthorized",
    "forbidden",
    "invalid token",
    "无效的令牌",
    "令牌无效",
    "凭证无效",
    "missing a thought_signature",
    "thought_signature",
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
    "upstream error",
    "do request failed",
    "econnreset",
    "eai_again",
    "enotfound",
] as const

const AUTH_MESSAGE_PATTERNS = [
    "authentication failed",
    "check your credentials",
    "invalid api key",
    "invalid authentication",
    "unauthorized",
    "forbidden",
    "invalid token",
    "无效的令牌",
    "令牌无效",
    "凭证无效",
    "credential",
    "token",
    "secret",
    "password",
    "signature",
    "sig",
] as const

const UPSTREAM_PROVIDER_PATTERNS = [
    "upstream error",
    "do request failed",
    "service unavailable",
    "gateway timeout",
    "bad gateway",
    "temporarily unavailable",
    "overloaded",
    "provider unavailable",
    "timeout",
    "timed out",
    "rate limit",
] as const

function getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
        return error.message
    }

    if (typeof error === "string") {
        return error
    }

    return ""
}

function matchesPattern(message: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => message.includes(pattern))
}

function extractRequestId(message: string): string | null {
    const match = message.match(
        /\brequest id\b\s*[:=]?\s*([A-Za-z0-9_-]+)|\(request id:\s*([^)]+)\)/i,
    )

    return match?.[1] || match?.[2] || null
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

    const message = getErrorMessage(error).toLowerCase()

    if (!message) return false

    return matchesPattern(message, RETRYABLE_MESSAGE_PATTERNS)
}

export function sanitizeModelErrorMessage(error: unknown): string {
    const rawMessage = getErrorMessage(error)
    const message = rawMessage.toLowerCase()

    if (!message) {
        return "An unexpected error occurred"
    }

    if (matchesPattern(message, AUTH_MESSAGE_PATTERNS)) {
        return "Authentication failed. Please check your credentials."
    }

    if (matchesPattern(message, UPSTREAM_PROVIDER_PATTERNS)) {
        const requestId = extractRequestId(rawMessage)
        return requestId
            ? `The upstream AI provider request failed. Please retry or switch models. Request ID: ${requestId}.`
            : "The upstream AI provider request failed. Please retry or switch models."
    }

    return rawMessage
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
