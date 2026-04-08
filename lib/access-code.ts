function splitList(value: string | undefined): string[] {
    if (!value) return []
    return value
        .split(/[,;\n\r，]+/g)
        .map((part) => part.trim())
        .filter(Boolean)
}

export function getAccessCodesFromEnv(): string[] {
    return splitList(process.env.ACCESS_CODE_LIST)
}

export function isAccessCodeRequired(): boolean {
    return getAccessCodesFromEnv().length > 0
}

export function normalizeAccessCode(input: string | null | undefined): string {
    return (input ?? "").trim()
}

export function isValidAccessCode(input: string | null | undefined): boolean {
    const accessCodes = getAccessCodesFromEnv()
    if (accessCodes.length === 0) return true
    const normalized = normalizeAccessCode(input)
    return normalized.length > 0 && accessCodes.includes(normalized)
}
