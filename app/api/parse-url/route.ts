import { NextResponse } from "next/server"
import { allowPrivateUrls, isPrivateUrl } from "@/lib/ssrf-protection"

const MAX_CONTENT_LENGTH = 150000
const EXTRACT_TIMEOUT_MS = 15000
const USER_AGENT = "Mozilla/5.0 (compatible; NextAIDrawio/1.0)"

function htmlToText(html: string): string {
    return html
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
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

function extractTitleFromHtml(html: string): string {
    const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
    if (!match?.[1]) return "Untitled"
    return htmlToText(match[1]) || "Untitled"
}

export async function POST(req: Request) {
    try {
        const { url } = await req.json()

        if (!url || typeof url !== "string") {
            return NextResponse.json(
                { error: "URL is required" },
                { status: 400 },
            )
        }

        try {
            new URL(url)
        } catch {
            return NextResponse.json(
                { error: "Invalid URL format" },
                { status: 400 },
            )
        }

        if (!allowPrivateUrls && isPrivateUrl(url)) {
            return NextResponse.json(
                { error: "Cannot access private/internal URLs" },
                { status: 400 },
            )
        }

        const controller = new AbortController()
        const timeoutId = setTimeout(
            () => controller.abort(),
            EXTRACT_TIMEOUT_MS,
        )

        try {
            const response = await fetch(url, {
                headers: { "User-Agent": USER_AGENT },
                signal: controller.signal,
            })

            if (!response.ok) {
                return NextResponse.json(
                    { error: `Failed to fetch URL (HTTP ${response.status})` },
                    { status: 400 },
                )
            }

            const contentType = response.headers.get("content-type") || ""
            if (contentType.includes("application/pdf")) {
                return NextResponse.json(
                    {
                        error: "PDF URLs are not supported. Please download and upload the PDF file directly",
                    },
                    { status: 422 },
                )
            }

            const html = await response.text()
            const content = htmlToText(html)

            if (!content) {
                return NextResponse.json(
                    { error: "Could not extract content from URL" },
                    { status: 400 },
                )
            }

            if (content.length > MAX_CONTENT_LENGTH) {
                return NextResponse.json(
                    {
                        error: `Content exceeds ${MAX_CONTENT_LENGTH / 1000}k character limit (${(content.length / 1000).toFixed(1)}k chars)`,
                    },
                    { status: 400 },
                )
            }

            return NextResponse.json({
                title: extractTitleFromHtml(html),
                content,
                charCount: content.length,
            })
        } finally {
            clearTimeout(timeoutId)
        }
    } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
            return NextResponse.json(
                { error: "Timed out while fetching URL content" },
                { status: 504 },
            )
        }
        console.error("URL extraction error:", error)
        return NextResponse.json(
            { error: "Failed to fetch or parse URL content" },
            { status: 500 },
        )
    }
}
