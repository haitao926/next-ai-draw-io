// Shared helper functions for chat route
// Exported for testing

// File upload limits (must match client-side)
export const MAX_FILE_SIZE = 2 * 1024 * 1024 // 2MB
export const MAX_FILES = 5

// Helper function to validate file parts in messages
export function validateFileParts(messages: any[]): {
    valid: boolean
    error?: string
} {
    const lastMessage = messages[messages.length - 1]
    const fileParts =
        lastMessage?.parts?.filter((p: any) => p.type === "file") || []

    if (fileParts.length > MAX_FILES) {
        return {
            valid: false,
            error: `Too many files. Maximum ${MAX_FILES} allowed.`,
        }
    }

    for (const filePart of fileParts) {
        // Data URLs format: data:image/png;base64,<data>
        // Base64 increases size by ~33%, so we check the decoded size
        if (filePart.url?.startsWith("data:")) {
            const base64Data = filePart.url.split(",")[1]
            if (base64Data) {
                const sizeInBytes = Math.ceil((base64Data.length * 3) / 4)
                if (sizeInBytes > MAX_FILE_SIZE) {
                    return {
                        valid: false,
                        error: `File exceeds ${MAX_FILE_SIZE / 1024 / 1024}MB limit.`,
                    }
                }
            }
        }
    }

    return { valid: true }
}

// Helper function to check if diagram is minimal/empty
export function isMinimalDiagram(xml: string): boolean {
    const stripped = xml.replace(/\s/g, "")
    return !stripped.includes('id="2"')
}

// Some providers attach provider-specific signatures to tool-call history.
// Rewriting those messages can invalidate subsequent tool calls.
export function canRewriteHistoricalToolMessages(
    provider?: string | null,
    modelId?: string | null,
): boolean {
    const normalizedProvider = provider?.toLowerCase() || ""
    const normalizedModelId = modelId?.toLowerCase() || ""

    if (normalizedProvider === "google") {
        return false
    }

    if (normalizedModelId.includes("gemini")) {
        return false
    }

    return true
}

// Helper function to replace historical tool call XML with placeholders
// This reduces token usage and forces LLM to rely on the current diagram XML (source of truth)
// Also fixes invalid/undefined inputs from interrupted streaming
export function replaceHistoricalToolInputs(messages: any[]): any[] {
    return messages.map((msg) => {
        if (msg.role !== "assistant" || !Array.isArray(msg.content)) {
            return msg
        }
        const replacedContent = msg.content
            .map((part: any) => {
                if (part.type === "tool-call") {
                    const toolName = part.toolName
                    // Fix invalid/undefined inputs from interrupted streaming
                    if (
                        !part.input ||
                        typeof part.input !== "object" ||
                        Object.keys(part.input).length === 0
                    ) {
                        // Skip tool calls with invalid inputs entirely
                        return null
                    }
                    if (
                        toolName === "display_diagram" ||
                        toolName === "edit_diagram"
                    ) {
                        return {
                            ...part,
                            input: {
                                placeholder:
                                    "[XML content replaced - see current diagram XML in system context]",
                            },
                        }
                    }
                }
                return part
            })
            .filter(Boolean) // Remove null entries (invalid tool calls)
        return { ...msg, content: replacedContent }
    })
}

function redactDataUrls(value: unknown): unknown {
    if (typeof value === "string") {
        return value.startsWith("data:image/")
            ? "[data image omitted from history]"
            : value
    }

    if (Array.isArray(value)) {
        return value.map((item) => redactDataUrls(item))
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, nestedValue]) => [
                key,
                key === "dataUrl"
                    ? "[data image omitted from history]"
                    : redactDataUrls(nestedValue),
            ]),
        )
    }

    return value
}

export function redactHistoricalToolResults(messages: any[]): any[] {
    return messages.map((msg) => {
        if (!Array.isArray(msg.content)) {
            return msg
        }

        const content = msg.content.map((part: any) => {
            if (
                part.type === "tool-result" &&
                part.toolName === "import_asset" &&
                part.output
            ) {
                return {
                    ...part,
                    output: redactDataUrls(part.output),
                }
            }

            return part
        })

        return { ...msg, content }
    })
}
