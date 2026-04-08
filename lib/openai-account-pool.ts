export interface NamedAccount {
    name: string
    apiKey: string
}

function splitList(value: string | undefined): string[] {
    if (!value) return []
    return value
        .split(/[,;\n\r]+/g)
        .map((part) => part.trim())
        .filter(Boolean)
}

function parseEntry(entry: string): NamedAccount | null {
    const match = entry.match(/^([^:=]+)\s*[:=]\s*(.+)$/)
    if (!match) return null
    const name = match[1].trim()
    const apiKey = match[2].trim()
    if (!name || !apiKey) return null
    return { name, apiKey }
}

export function getOpenAIAccountPoolFromEnv(): NamedAccount[] {
    const raw = process.env.OPENAI_ACCOUNT_POOL
    if (!raw) return []
    return splitList(raw)
        .map(parseEntry)
        .filter((v): v is NamedAccount => !!v)
}

export function pickOpenAIAccount(
    requestedName?: string | null,
): NamedAccount | null {
    const pool = getOpenAIAccountPoolFromEnv()
    if (pool.length === 0) return null
    if (requestedName) {
        const normalized = requestedName.trim()
        const found = pool.find((a) => a.name === normalized)
        if (found) return found
    }
    return pool[Math.floor(Math.random() * pool.length)]
}
