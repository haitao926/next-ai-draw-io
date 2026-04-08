export function parseEnvList(value: string | undefined): string[] {
    if (!value) return []
    return value
        .split(/[,;\n\r]+/g)
        .map((part) => part.trim())
        .filter(Boolean)
}

export function pickFromEnvList(value: string | undefined): string | undefined {
    const keys = parseEnvList(value)
    if (keys.length === 0) return undefined
    if (keys.length === 1) return keys[0]
    return keys[Math.floor(Math.random() * keys.length)]
}
