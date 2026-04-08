function splitList(value: string | undefined): string[] {
    if (!value) return []
    return value
        .split(/[,;\n\r，]+/g)
        .map((part) => part.trim())
        .filter(Boolean)
}

export function getModelPoolFromEnv(): string[] {
    return splitList(process.env.AI_MODEL_POOL)
}

export function pickModelFromPool(
    pool: string[],
    mode: "random" = "random",
): string | undefined {
    if (pool.length === 0) return undefined
    if (pool.length === 1) return pool[0]
    if (mode === "random") {
        return pool[Math.floor(Math.random() * pool.length)]
    }
    return pool[0]
}
