export function normalizeOpenAICompatibleBaseUrl(baseUrl: string): string {
    const trimmed = baseUrl.trim()
    // If it's not an absolute URL (e.g., a relative path), leave it unchanged.
    if (!/^[a-zA-Z][a-zA-Z\\d+.-]*:\/\//.test(trimmed)) {
        return trimmed
    }

    const url = new URL(trimmed)
    // Vercel AI SDK appends `/chat/completions` to baseURL, so OpenAI-compatible
    // endpoints typically need `/v1` when the input is just the domain.
    if (url.pathname === "" || url.pathname === "/") {
        url.pathname = "/v1"
    }
    return url.toString()
}
