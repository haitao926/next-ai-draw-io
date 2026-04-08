function splitList(value: string | undefined): string[] {
    if (!value) return []
    return value
        .split(/[,;\n\r，]+/g)
        .map((part) => part.trim())
        .filter(Boolean)
}

export function getModelAllowlistFromEnv(): string[] {
    return splitList(process.env.AI_MODEL_ALLOWLIST)
}

export function assertModelAllowed(modelId: string): void {
    const allowlist = getModelAllowlistFromEnv()
    if (allowlist.length === 0) return
    if (!allowlist.includes(modelId)) {
        throw new Error(
            `Model "${modelId}" is not allowed. Allowed models: ${allowlist.join(", ")}`,
        )
    }
}
