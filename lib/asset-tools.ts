import { DOMParser, XMLSerializer } from "@xmldom/xmldom"
import { allowPrivateUrls, isPrivateUrl } from "@/lib/ssrf-protection"

export type AssetFormat = "svg" | "png"
export type AssetType = "icon" | "illustration" | "template" | "mixed"

export interface SearchAssetsInput {
    query: string
    assetType: AssetType
    formats: AssetFormat[]
    maxResults: number
}

export interface SearchAssetResult {
    title: string
    source: string
    pageUrl: string
    assetUrl: string
    format: AssetFormat | null
    license: string | null
    importable: boolean
    reason?: string
}

export interface ImportAssetInput {
    assetUrl: string
    pageUrl: string
    label?: string
    placementHint?: string
}

export interface ImportedAsset {
    dataUrl: string
    format: AssetFormat
    width: number
    height: number
    attribution: string
    license: string
    pageUrl: string
    assetUrl: string
    source: string
    label?: string
    placementHint?: string
}

interface SearchProviderResult {
    title: string
    url: string
    content?: string
}

type SearchProvider = "searxng" | "tavily" | "brave" | "bing"

interface SupportedAssetSite {
    label: string
    domains: string[]
}

const SEARCH_TIMEOUT_MS = 15000
const IMPORT_TIMEOUT_MS = 15000
const SEARCH_USER_AGENT =
    "Mozilla/5.0 (compatible; NextAIDrawioAssetSearch/1.0)"
const IMPORT_USER_AGENT =
    "Mozilla/5.0 (compatible; NextAIDrawioAssetImport/1.0)"
const DEFAULT_SVG_MAX_BYTES = 204800
const DEFAULT_PNG_MAX_BYTES = 512000
const MAX_SEARCH_CANDIDATES = 16
const MAX_IMPORTS_PER_REQUEST = 5
const FALLBACK_IMAGE_SIZE = 128
const DEFAULT_SEARCH_FALLBACK_PROVIDERS: SearchProvider[] = ["bing"]

const SUPPORTED_SITES: SupportedAssetSite[] = [
    { label: "Bioicons", domains: ["bioicons.com"] },
    { label: "SciDraw", domains: ["scidraw.io"] },
    { label: "PhyloPic", domains: ["phylopic.org"] },
    { label: "SMART", domains: ["smart.servier.com"] },
    { label: "SwissBioPics", domains: ["swissbiopics.org"] },
    { label: "Iconfinder", domains: ["iconfinder.com"] },
    { label: "Iconfont", domains: ["iconfont.cn"] },
]

const LICENSE_PATTERNS: Array<{ label: string; patterns: RegExp[] }> = [
    {
        label: "CC0",
        patterns: [/cc0/i, /creative commons zero/i],
    },
    {
        label: "Public Domain",
        patterns: [/public domain/i],
    },
    {
        label: "CC BY",
        patterns: [/cc by\b/i, /creative commons attribution/i],
    },
    {
        label: "MIT",
        patterns: [/\bmit license\b/i, /\bmit\b/i],
    },
    {
        label: "Apache",
        patterns: [/apache(?: license)?(?: version)? 2(?:\.0)?/i],
    },
    {
        label: "Free to Use",
        patterns: [
            /free to use/i,
            /free for commercial use/i,
            /\breusable\b/i,
            /free for personal and commercial use/i,
        ],
    },
]

function getSvgMaxBytes(): number {
    const value = Number(process.env.ASSET_IMPORT_MAX_SVG_BYTES)
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_SVG_MAX_BYTES
}

function getPngMaxBytes(): number {
    const value = Number(process.env.ASSET_IMPORT_MAX_PNG_BYTES)
    return Number.isFinite(value) && value > 0 ? value : DEFAULT_PNG_MAX_BYTES
}

function getSupportedSite(urlString: string): SupportedAssetSite | null {
    try {
        const hostname = new URL(urlString).hostname.toLowerCase()
        return (
            SUPPORTED_SITES.find((site) =>
                site.domains.some(
                    (domain) =>
                        hostname === domain || hostname.endsWith(`.${domain}`),
                ),
            ) || null
        )
    } catch {
        return null
    }
}

function getSourceLabel(urlString: string): string {
    try {
        return getSupportedSite(urlString)?.label || new URL(urlString).hostname
    } catch {
        return getSupportedSite(urlString)?.label || "External Asset"
    }
}

function inferFormat(
    urlString: string,
    contentType?: string | null,
): AssetFormat | null {
    const normalizedContentType = contentType?.toLowerCase() || ""
    if (normalizedContentType.includes("image/svg+xml")) return "svg"
    if (normalizedContentType.includes("image/png")) return "png"

    try {
        const pathname = new URL(urlString).pathname.toLowerCase()
        if (pathname.endsWith(".svg")) return "svg"
        if (pathname.endsWith(".png")) return "png"
    } catch {
        return null
    }

    return null
}

function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, " ")
        .trim()
}

function extractTitleFromHtml(html: string): string | null {
    const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (titleMatch?.[1]) {
        return htmlToText(titleMatch[1]) || null
    }

    const ogTitleMatch = html.match(
        /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i,
    )
    if (ogTitleMatch?.[1]) {
        return htmlToText(ogTitleMatch[1]) || null
    }

    return null
}

export function detectLicense(text: string): string | null {
    for (const entry of LICENSE_PATTERNS) {
        if (entry.patterns.some((pattern) => pattern.test(text))) {
            return entry.label
        }
    }

    return null
}

function isAllowedLicense(license: string | null): boolean {
    if (!license) return false

    return [
        "CC0",
        "Public Domain",
        "CC BY",
        "MIT",
        "Apache",
        "Free to Use",
    ].includes(license)
}

function buildSearchQuery({
    query,
    assetType,
    formats,
}: Pick<SearchAssetsInput, "query" | "assetType" | "formats">): string {
    const typeHints =
        assetType === "icon"
            ? "icon"
            : assetType === "illustration"
              ? "illustration scientific figure"
              : assetType === "template"
                ? "template scientific diagram"
                : "icon illustration template"

    const formatHints = formats.join(" ")
    const siteHints = SUPPORTED_SITES.flatMap((site) =>
        site.domains.map((domain) => `site:${domain}`),
    ).join(" OR ")

    return `${query} ${typeHints} ${formatHints} free reusable scientific asset (${siteHints})`
}

function normalizeSearchProvider(value: string): SearchProvider | null {
    const provider = value.trim().toLowerCase()
    if (
        provider === "searxng" ||
        provider === "tavily" ||
        provider === "brave" ||
        provider === "bing"
    ) {
        return provider
    }

    return null
}

function splitEnvList(value?: string): string[] {
    return (value || "")
        .split(/[,\s]+/)
        .map((item) => item.trim())
        .filter(Boolean)
}

function getConfiguredSearchProviders(): SearchProvider[] {
    const configuredProviders = splitEnvList(
        process.env.ASSET_SEARCH_PROVIDERS || process.env.ASSET_SEARCH_PROVIDER,
    )
        .map((provider) => normalizeSearchProvider(provider))
        .filter((provider): provider is SearchProvider => !!provider)

    if (configuredProviders.length === 0) {
        throw new Error(
            "Asset search is not configured. Set ASSET_SEARCH_PROVIDER and the matching search endpoint settings.",
        )
    }

    return Array.from(
        new Set([...configuredProviders, ...DEFAULT_SEARCH_FALLBACK_PROVIDERS]),
    )
}

function getSearchEndpoint(provider: SearchProvider, baseUrl?: string): string {
    const normalizedProvider = provider.toLowerCase()
    const trimmedBaseUrl = baseUrl?.trim()

    if (normalizedProvider === "searxng") {
        if (!trimmedBaseUrl) {
            throw new Error(
                "Asset search is not configured. Set ASSET_SEARCH_BASE_URL for the searxng provider.",
            )
        }

        return trimmedBaseUrl.endsWith("/search")
            ? trimmedBaseUrl
            : `${trimmedBaseUrl.replace(/\/$/, "")}/search`
    }

    if (normalizedProvider === "tavily") {
        return (
            trimmedBaseUrl?.replace(/\/$/, "") ||
            "https://api.tavily.com/search"
        )
    }

    if (normalizedProvider === "brave") {
        return (
            trimmedBaseUrl?.replace(/\/$/, "") ||
            "https://api.search.brave.com/res/v1/web/search"
        )
    }

    if (normalizedProvider === "bing") {
        return (
            trimmedBaseUrl?.replace(/\/$/, "") || "https://www.bing.com/search"
        )
    }

    throw new Error(
        `Unsupported asset search provider "${provider}". Use "searxng", "tavily", "brave", or "bing".`,
    )
}

function getProviderBaseUrl(provider: SearchProvider): string | undefined {
    const providerSpecificKey = `ASSET_SEARCH_${provider.toUpperCase()}_BASE_URL`
    const providerSpecificBaseUrl = process.env[providerSpecificKey]
    if (providerSpecificBaseUrl) return providerSpecificBaseUrl

    const legacyProviders = splitEnvList(process.env.ASSET_SEARCH_PROVIDER)
        .map((value) => normalizeSearchProvider(value))
        .filter((value): value is SearchProvider => !!value)

    return legacyProviders.length === 1 && legacyProviders[0] === provider
        ? process.env.ASSET_SEARCH_BASE_URL
        : undefined
}

function assertPublicUrl(urlString: string, label: string) {
    if (!allowPrivateUrls && isPrivateUrl(urlString)) {
        throw new Error(`${label} points to a private or internal URL.`)
    }
}

async function fetchWithTimeout(
    urlString: string,
    init: RequestInit,
    timeoutMs: number,
): Promise<Response> {
    assertPublicUrl(urlString, "Remote URL")

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

    try {
        return await fetch(urlString, {
            ...init,
            signal: controller.signal,
        })
    } finally {
        clearTimeout(timeoutId)
    }
}

function decodeHtmlEntities(value: string): string {
    return value
        .replace(/&nbsp;/g, " ")
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x([0-9a-f]+);/gi, (_, hex) =>
            String.fromCodePoint(Number.parseInt(hex, 16)),
        )
        .replace(/&#(\d+);/g, (_, decimal) =>
            String.fromCodePoint(Number.parseInt(decimal, 10)),
        )
}

function normalizeBingResultUrl(rawUrl: string): string | null {
    const decoded = decodeHtmlEntities(rawUrl)
    const resolved = resolveUrl(decoded, "https://www.bing.com")
    if (!resolved) return null

    try {
        const url = new URL(resolved)
        const encodedTarget = url.searchParams.get("u")
        if (url.hostname.endsWith("bing.com") && encodedTarget) {
            const maybeBase64 = encodedTarget.replace(/^a1/, "")
            try {
                const decodedTarget = Buffer.from(maybeBase64, "base64url")
                    .toString("utf-8")
                    .trim()
                if (decodedTarget.startsWith("http")) {
                    return decodedTarget
                }
            } catch {
                // Fall through and keep the original URL.
            }
        }

        return url.toString()
    } catch {
        return null
    }
}

function parseBingResults(html: string): SearchProviderResult[] {
    const results: SearchProviderResult[] = []
    const seenUrls = new Set<string>()
    const itemPattern =
        /<li[^>]+class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi

    let itemMatch: RegExpExecArray | null
    while ((itemMatch = itemPattern.exec(html)) !== null) {
        const itemHtml = itemMatch[1] || ""
        const linkMatch = itemHtml.match(
            /<h2[^>]*>\s*<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i,
        )
        if (!linkMatch) continue

        const url = normalizeBingResultUrl(linkMatch[1])
        if (!url || seenUrls.has(url)) continue

        const hostname = new URL(url).hostname.toLowerCase()
        if (hostname === "bing.com" || hostname.endsWith(".bing.com")) {
            continue
        }

        const snippetMatch = itemHtml.match(/<p[^>]*>([\s\S]*?)<\/p>/i)
        seenUrls.add(url)
        results.push({
            title: htmlToText(decodeHtmlEntities(linkMatch[2])) || "Untitled",
            url,
            content: snippetMatch
                ? htmlToText(decodeHtmlEntities(snippetMatch[1]))
                : "",
        })
    }

    return results.slice(0, MAX_SEARCH_CANDIDATES)
}

async function searchWithSingleProvider(
    query: string,
    maxResults: number,
    provider: SearchProvider,
): Promise<SearchProviderResult[]> {
    const endpoint = getSearchEndpoint(provider, getProviderBaseUrl(provider))

    if (provider === "searxng") {
        const url = new URL(endpoint)
        url.searchParams.set("q", query)
        url.searchParams.set("format", "json")
        url.searchParams.set("safesearch", "1")
        url.searchParams.set("language", "zh-CN")

        const response = await fetchWithTimeout(
            url.toString(),
            {
                headers: { "User-Agent": SEARCH_USER_AGENT },
            },
            SEARCH_TIMEOUT_MS,
        )

        if (!response.ok) {
            throw new Error(
                `Asset search failed (HTTP ${response.status}) via SearXNG.`,
            )
        }

        const data = (await response.json()) as {
            results?: Array<{ title?: string; url?: string; content?: string }>
        }

        return (data.results || [])
            .filter((result) => result.url && result.title)
            .slice(0, MAX_SEARCH_CANDIDATES)
            .map((result) => ({
                title: result.title || "Untitled",
                url: result.url || "",
                content: result.content || "",
            }))
    }

    if (provider === "brave") {
        const apiKey = process.env.ASSET_SEARCH_API_KEY?.trim()
        if (!apiKey) {
            throw new Error(
                "Asset search is not configured. Set ASSET_SEARCH_API_KEY for the brave provider.",
            )
        }

        const url = new URL(endpoint)
        url.searchParams.set("q", query)
        url.searchParams.set(
            "count",
            String(Math.min(maxResults, MAX_SEARCH_CANDIDATES)),
        )
        url.searchParams.set("safesearch", "moderate")
        url.searchParams.set("country", "US")
        url.searchParams.set("search_lang", "zh-hans")

        const response = await fetchWithTimeout(
            url.toString(),
            {
                headers: {
                    Accept: "application/json",
                    "User-Agent": SEARCH_USER_AGENT,
                    "X-Subscription-Token": apiKey,
                },
            },
            SEARCH_TIMEOUT_MS,
        )

        if (!response.ok) {
            throw new Error(
                `Asset search failed (HTTP ${response.status}) via Brave Search.`,
            )
        }

        const data = (await response.json()) as {
            web?: {
                results?: Array<{
                    title?: string
                    url?: string
                    description?: string
                }>
            }
        }

        return (data.web?.results || [])
            .filter((result) => result.url && result.title)
            .slice(0, MAX_SEARCH_CANDIDATES)
            .map((result) => ({
                title: result.title || "Untitled",
                url: result.url || "",
                content: result.description || "",
            }))
    }

    if (provider === "bing") {
        const url = new URL(endpoint)
        url.searchParams.set("q", query)
        url.searchParams.set("setlang", "zh-cn")

        const response = await fetchWithTimeout(
            url.toString(),
            {
                headers: {
                    Accept: "text/html,application/xhtml+xml",
                    "User-Agent": SEARCH_USER_AGENT,
                },
            },
            SEARCH_TIMEOUT_MS,
        )

        if (!response.ok) {
            throw new Error(
                `Asset search failed (HTTP ${response.status}) via Bing fallback.`,
            )
        }

        const html = await response.text()
        return parseBingResults(html)
    }

    const apiKey = process.env.ASSET_SEARCH_API_KEY?.trim()
    if (!apiKey) {
        throw new Error(
            "Asset search is not configured. Set ASSET_SEARCH_API_KEY for the tavily provider.",
        )
    }

    const response = await fetchWithTimeout(
        endpoint,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "User-Agent": SEARCH_USER_AGENT,
            },
            body: JSON.stringify({
                api_key: apiKey,
                query,
                max_results: Math.min(maxResults, MAX_SEARCH_CANDIDATES),
                search_depth: "advanced",
                include_answer: false,
                include_images: false,
                include_raw_content: false,
            }),
        },
        SEARCH_TIMEOUT_MS,
    )

    if (!response.ok) {
        throw new Error(
            `Asset search failed (HTTP ${response.status}) via Tavily.`,
        )
    }

    const data = (await response.json()) as {
        results?: Array<{ title?: string; url?: string; content?: string }>
    }

    return (data.results || [])
        .filter((result) => result.url && result.title)
        .slice(0, MAX_SEARCH_CANDIDATES)
        .map((result) => ({
            title: result.title || "Untitled",
            url: result.url || "",
            content: result.content || "",
        }))
}

async function searchWithProvider(
    query: string,
    maxResults: number,
): Promise<SearchProviderResult[]> {
    const providers = getConfiguredSearchProviders()
    const failures: string[] = []

    for (const provider of providers) {
        try {
            const results = await searchWithSingleProvider(
                query,
                maxResults,
                provider,
            )

            if (results.length > 0) {
                return results
            }

            failures.push(`${provider}: no results`)
        } catch (error) {
            failures.push(
                `${provider}: ${
                    error instanceof Error ? error.message : "search failed"
                }`,
            )
        }
    }

    throw new Error(
        `Asset search failed after trying ${providers.join(", ")}. ${failures.join("; ")}`,
    )
}

function resolveUrl(candidate: string, pageUrl: string): string | null {
    try {
        return new URL(candidate, pageUrl).toString()
    } catch {
        return null
    }
}

function collectAssetCandidates(
    html: string,
    pageUrl: string,
    formats: AssetFormat[],
): string[] {
    const candidates = new Set<string>()
    const patterns = [
        /\b(?:href|src|content|data-src|data-url|data-download-url)=["']([^"']+)["']/gi,
        /https?:\/\/[^\s"'<>]+/gi,
        /\/\/[^\s"'<>]+/gi,
    ]

    for (const pattern of patterns) {
        let match: RegExpExecArray | null
        while ((match = pattern.exec(html)) !== null) {
            const rawValue = match[1] || match[0]
            if (!rawValue) continue

            const resolved = resolveUrl(rawValue, pageUrl)
            if (!resolved) continue

            const format = inferFormat(resolved)
            if (!format || !formats.includes(format)) continue

            candidates.add(resolved)
        }
    }

    return Array.from(candidates)
}

function rankAssetCandidate(candidateUrl: string, pageUrl: string): number {
    let score = 0
    const page = new URL(pageUrl)
    const candidate = new URL(candidateUrl)
    const pathname = candidate.pathname.toLowerCase()

    if (candidate.hostname === page.hostname) score += 40
    if (pathname.endsWith(".svg")) score += 20
    if (/download|export|asset|icon|image|illustration/.test(pathname)) {
        score += 10
    }
    if (/logo|avatar|sprite/.test(pathname)) {
        score -= 10
    }

    return score
}

function selectBestAssetUrl(
    html: string,
    pageUrl: string,
    formats: AssetFormat[],
): string | null {
    const candidates = collectAssetCandidates(html, pageUrl, formats)
    if (candidates.length === 0) return null

    return candidates.sort(
        (left, right) =>
            rankAssetCandidate(right, pageUrl) -
            rankAssetCandidate(left, pageUrl),
    )[0]
}

async function resolveSupportedResult(
    result: SearchProviderResult,
    formats: AssetFormat[],
): Promise<SearchAssetResult> {
    const source = getSourceLabel(result.url)
    const site = getSupportedSite(result.url)
    const directFormat = inferFormat(result.url)
    const directLicense = detectLicense(result.content || "")

    if (!site) {
        return {
            title: result.title,
            source,
            pageUrl: result.url,
            assetUrl: result.url,
            format: directFormat,
            license: directLicense,
            importable: false,
            reason: "Automatic import is limited to supported asset sites.",
        }
    }

    if (directFormat && isAllowedLicense(directLicense)) {
        return {
            title: result.title,
            source,
            pageUrl: result.url,
            assetUrl: result.url,
            format: directFormat,
            license: directLicense,
            importable: true,
        }
    }

    try {
        const response = await fetchWithTimeout(
            result.url,
            {
                headers: { "User-Agent": SEARCH_USER_AGENT },
            },
            SEARCH_TIMEOUT_MS,
        )

        if (!response.ok) {
            return {
                title: result.title,
                source,
                pageUrl: result.url,
                assetUrl: result.url,
                format: directFormat,
                license: directLicense,
                importable: false,
                reason: `Could not inspect asset page (HTTP ${response.status}).`,
            }
        }

        const contentType = response.headers.get("content-type") || ""
        if (!contentType.includes("text/html")) {
            return {
                title: result.title,
                source,
                pageUrl: result.url,
                assetUrl: result.url,
                format: directFormat || inferFormat(result.url, contentType),
                license: directLicense,
                importable:
                    !!directFormat && isAllowedLicense(directLicense || null),
                reason:
                    directFormat && isAllowedLicense(directLicense || null)
                        ? undefined
                        : "License information could not be verified from the source page.",
            }
        }

        const html = await response.text()
        const title = extractTitleFromHtml(html) || result.title
        const pageText = `${htmlToText(html)} ${result.content || ""}`
        const license = detectLicense(pageText)
        const assetUrl = selectBestAssetUrl(html, result.url, formats)

        return {
            title,
            source,
            pageUrl: result.url,
            assetUrl: assetUrl || result.url,
            format: assetUrl ? inferFormat(assetUrl) : directFormat,
            license,
            importable: !!assetUrl && isAllowedLicense(license),
            reason: !assetUrl
                ? "Could not find a downloadable SVG or PNG on the source page."
                : !license
                  ? "License is missing or unclear, so automatic import is disabled."
                  : !isAllowedLicense(license)
                    ? `License "${license}" is not in the auto-import allowlist.`
                    : undefined,
        }
    } catch (error) {
        return {
            title: result.title,
            source,
            pageUrl: result.url,
            assetUrl: result.url,
            format: directFormat,
            license: directLicense,
            importable: false,
            reason:
                error instanceof Error
                    ? error.message
                    : "Failed to inspect the source page.",
        }
    }
}

export async function searchAssets(
    input: SearchAssetsInput,
): Promise<SearchAssetResult[]> {
    const searchQuery = buildSearchQuery(input)
    const providerResults = await searchWithProvider(
        searchQuery,
        Math.min(input.maxResults * 2, MAX_SEARCH_CANDIDATES),
    )

    const dedupedResults = providerResults.filter((result, index, array) => {
        return (
            array.findIndex((candidate) => candidate.url === result.url) ===
            index
        )
    })

    const resolved = await Promise.all(
        dedupedResults
            .slice(0, MAX_SEARCH_CANDIDATES)
            .map((result) => resolveSupportedResult(result, input.formats)),
    )

    return resolved.slice(0, Math.min(input.maxResults, 8))
}

function parseNumericDimension(value: string | null): number | null {
    if (!value) return null
    const match = value.match(/(\d+(?:\.\d+)?)/)
    if (!match) return null
    const parsed = Number(match[1])
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null
}

function parseSvgDimensions(svgText: string): {
    width: number
    height: number
} {
    const parser = new DOMParser()
    const doc = parser.parseFromString(svgText, "image/svg+xml")
    const svg = doc.getElementsByTagName("svg")[0]

    if (!svg) {
        return { width: FALLBACK_IMAGE_SIZE, height: FALLBACK_IMAGE_SIZE }
    }

    const widthAttr = parseNumericDimension(svg.getAttribute("width"))
    const heightAttr = parseNumericDimension(svg.getAttribute("height"))
    if (widthAttr && heightAttr) {
        return { width: widthAttr, height: heightAttr }
    }

    const viewBox = svg.getAttribute("viewBox")
    if (viewBox) {
        const parts = viewBox
            .split(/[\s,]+/)
            .map((part) => Number(part))
            .filter((part) => Number.isFinite(part))
        if (parts.length === 4 && parts[2] > 0 && parts[3] > 0) {
            return { width: parts[2], height: parts[3] }
        }
    }

    return { width: FALLBACK_IMAGE_SIZE, height: FALLBACK_IMAGE_SIZE }
}

function removeNode(node: any) {
    const parent = node.parentNode
    if (parent) {
        parent.removeChild(node)
    }
}

export function sanitizeSvg(svgText: string): {
    sanitizedSvg: string
    width: number
    height: number
} {
    const parser = new DOMParser()
    const doc = parser.parseFromString(svgText, "image/svg+xml")
    const serializer = new XMLSerializer()

    const forbiddenNodes = [
        ...Array.from(doc.getElementsByTagName("script")),
        ...Array.from(doc.getElementsByTagName("foreignObject")),
    ]

    for (const node of forbiddenNodes) {
        removeNode(node)
    }

    const allElements = Array.from(doc.getElementsByTagName("*"))
    for (const element of allElements) {
        const attrsToRemove: string[] = []
        for (let i = 0; i < element.attributes.length; i++) {
            const attribute = element.attributes.item(i)
            if (!attribute) continue

            const attrName = attribute.name.toLowerCase()
            const attrValue = attribute.value.trim()
            if (attrName.startsWith("on")) {
                attrsToRemove.push(attribute.name)
                continue
            }

            if (["href", "xlink:href", "src"].includes(attrName)) {
                if (
                    /^(?:https?:|\/\/|javascript:)/i.test(attrValue) &&
                    !attrValue.startsWith("data:image/")
                ) {
                    attrsToRemove.push(attribute.name)
                }
            }

            if (
                attrName === "style" &&
                /url\((?:https?:|\/\/|javascript:)/i.test(attrValue)
            ) {
                attrsToRemove.push(attribute.name)
            }
        }

        for (const attrName of attrsToRemove) {
            element.removeAttribute(attrName)
        }
    }

    const sanitizedSvg = serializer.serializeToString(doc)
    const { width, height } = parseSvgDimensions(sanitizedSvg)

    return { sanitizedSvg, width, height }
}

export function parsePngDimensions(bytes: Uint8Array): {
    width: number
    height: number
} {
    if (bytes.length < 24) {
        return { width: FALLBACK_IMAGE_SIZE, height: FALLBACK_IMAGE_SIZE }
    }

    const isPng =
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47

    if (!isPng) {
        return { width: FALLBACK_IMAGE_SIZE, height: FALLBACK_IMAGE_SIZE }
    }

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return {
        width: view.getUint32(16),
        height: view.getUint32(20),
    }
}

function toDataUrl(bytes: Uint8Array, mimeType: string): string {
    return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`
}

function sanitizeImportOutputValue(value: unknown): unknown {
    if (typeof value === "string") {
        if (value.startsWith("data:image/")) {
            return "[data image omitted]"
        }
        return value
    }

    if (Array.isArray(value)) {
        return value.map((item) => sanitizeImportOutputValue(item))
    }

    if (value && typeof value === "object") {
        return Object.fromEntries(
            Object.entries(value).map(([key, nestedValue]) => [
                key,
                key === "dataUrl"
                    ? "[data image omitted]"
                    : sanitizeImportOutputValue(nestedValue),
            ]),
        )
    }

    return value
}

export function redactImportedAssetOutput<T>(value: T): T {
    return sanitizeImportOutputValue(value) as T
}

export async function importAsset(
    input: ImportAssetInput,
): Promise<ImportedAsset> {
    if (!input.assetUrl || !input.pageUrl) {
        throw new Error("assetUrl and pageUrl are required for asset import.")
    }

    assertPublicUrl(input.assetUrl, "Asset URL")
    assertPublicUrl(input.pageUrl, "Source page URL")

    const site = getSupportedSite(input.pageUrl)
    if (!site) {
        throw new Error(
            "Automatic import is only supported for approved asset websites.",
        )
    }

    const pageResponse = await fetchWithTimeout(
        input.pageUrl,
        {
            headers: { "User-Agent": IMPORT_USER_AGENT },
        },
        IMPORT_TIMEOUT_MS,
    )

    if (!pageResponse.ok) {
        throw new Error(
            `Could not verify the source page (HTTP ${pageResponse.status}).`,
        )
    }

    const pageHtml = await pageResponse.text()
    const pageText = htmlToText(pageHtml)
    const license = detectLicense(pageText)
    if (!isAllowedLicense(license)) {
        throw new Error(
            license
                ? `License "${license}" is not allowed for automatic import.`
                : "License is missing or unclear, so automatic import is disabled.",
        )
    }

    const assetResponse = await fetchWithTimeout(
        input.assetUrl,
        {
            headers: { "User-Agent": IMPORT_USER_AGENT },
        },
        IMPORT_TIMEOUT_MS,
    )

    if (!assetResponse.ok) {
        throw new Error(
            `Failed to download asset (HTTP ${assetResponse.status}).`,
        )
    }

    const contentType = assetResponse.headers.get("content-type")
    const format = inferFormat(input.assetUrl, contentType)
    if (!format) {
        throw new Error(
            "Only SVG and PNG assets can be imported automatically.",
        )
    }

    const bytes = new Uint8Array(await assetResponse.arrayBuffer())
    if (format === "svg" && bytes.byteLength > getSvgMaxBytes()) {
        throw new Error(
            `SVG asset exceeds ${Math.round(getSvgMaxBytes() / 1024)} KB and will not be auto-imported.`,
        )
    }
    if (format === "png" && bytes.byteLength > getPngMaxBytes()) {
        throw new Error(
            `PNG asset exceeds ${Math.round(getPngMaxBytes() / 1024)} KB and will not be auto-imported.`,
        )
    }

    let dataUrl: string
    let width: number
    let height: number

    if (format === "svg") {
        const svgText = new TextDecoder("utf-8").decode(bytes)
        const sanitized = sanitizeSvg(svgText)
        dataUrl = `data:image/svg+xml;base64,${Buffer.from(
            sanitized.sanitizedSvg,
            "utf-8",
        ).toString("base64")}`
        width = sanitized.width
        height = sanitized.height
    } else {
        const dimensions = parsePngDimensions(bytes)
        dataUrl = toDataUrl(bytes, "image/png")
        width = dimensions.width
        height = dimensions.height
    }

    const title = extractTitleFromHtml(pageHtml) || site.label

    return {
        dataUrl,
        format,
        width,
        height,
        attribution: title,
        license: license || "Free to Use",
        pageUrl: input.pageUrl,
        assetUrl: input.assetUrl,
        source: site.label,
        label: input.label,
        placementHint: input.placementHint,
    }
}

export function getMaxImportsPerRequest(): number {
    return MAX_IMPORTS_PER_REQUEST
}
