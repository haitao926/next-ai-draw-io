import { describe, expect, it } from "vitest"
import {
    buildModelFailoverHeaders,
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
