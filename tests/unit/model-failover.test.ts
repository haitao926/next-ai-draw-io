import { describe, expect, it } from "vitest"
import {
    buildModelFailoverHeaders,
    sanitizeModelErrorMessage,
    shouldFailoverToNextModel,
} from "@/lib/model-failover"

describe("shouldFailoverToNextModel", () => {
    it("treats transient provider failures as retryable", () => {
        const error = Object.assign(new Error("Service unavailable"), {
            status: 503,
        })

        expect(shouldFailoverToNextModel(error)).toBe(true)
    })

    it("treats network failures as retryable", () => {
        expect(
            shouldFailoverToNextModel(
                new Error("fetch failed: socket hang up"),
            ),
        ).toBe(true)
    })

    it("does not retry on local validation errors", () => {
        expect(
            shouldFailoverToNextModel(
                new Error("The model does not support image input."),
            ),
        ).toBe(false)
    })

    it("treats auth-style streamed errors as retryable", () => {
        expect(
            shouldFailoverToNextModel(
                new Error(
                    "Authentication failed. Please check your credentials.",
                ),
            ),
        ).toBe(true)
    })

    it("treats Gemini thought_signature failures as retryable", () => {
        expect(
            shouldFailoverToNextModel(
                new Error(
                    "Function call is missing a thought_signature in functionCall parts.",
                ),
            ),
        ).toBe(true)
    })

    it("treats localized invalid token errors as retryable", () => {
        expect(
            shouldFailoverToNextModel(
                new Error("无效的令牌 (request id: test)"),
            ),
        ).toBe(true)
    })

    it("treats upstream provider request failures as retryable", () => {
        expect(
            shouldFailoverToNextModel(
                new Error(
                    "Failed after 3 attempts. Last error: upstream error: do request failed (request id: 20260410095442975315514T59qCF8k)",
                ),
            ),
        ).toBe(true)
    })
})

describe("buildModelFailoverHeaders", () => {
    it("marks fallback metadata when the selected model changes", () => {
        const headers = buildModelFailoverHeaders({
            actualModelId: "kimi-k2.5",
            actualProvider: "openai",
            requestedSelectedModelId: "server:vectorengine:gemini-primary",
            actualSelectedModelId: "server:packycode:kimi-k2.5",
            attemptedSelectedModelIds: [
                "server:vectorengine:gemini-primary",
                "server:packycode:kimi-k2.5",
            ],
        })

        expect(headers.get("x-ai-fallback-applied")).toBe("true")
        expect(headers.get("x-ai-actual-model-id")).toBe("kimi-k2.5")
        expect(headers.get("x-ai-actual-provider")).toBe("openai")
        expect(headers.get("x-ai-actual-selected-model-id")).toBe(
            "server:packycode:kimi-k2.5",
        )
    })
})

describe("sanitizeModelErrorMessage", () => {
    it("masks authentication-style provider errors", () => {
        expect(
            sanitizeModelErrorMessage(
                new Error("无效的令牌 (request id: test)"),
            ),
        ).toBe("Authentication failed. Please check your credentials.")
    })

    it("rewrites upstream request failures into a stable message", () => {
        expect(
            sanitizeModelErrorMessage(
                new Error(
                    "Failed after 3 attempts. Last error: upstream error: do request failed (request id: 20260410095442975315514T59qCF8k)",
                ),
            ),
        ).toBe(
            "The upstream AI provider request failed. Please retry or switch models. Request ID: 20260410095442975315514T59qCF8k.",
        )
    })
})
