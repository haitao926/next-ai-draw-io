// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest"
import {
    detectLicense,
    importAsset,
    parsePngDimensions,
    searchAssets,
} from "@/lib/asset-tools"

const originalFetch = global.fetch
const originalEnv = { ...process.env }

afterEach(() => {
    global.fetch = originalFetch
    process.env = { ...originalEnv }
    vi.restoreAllMocks()
})

describe("searchAssets", () => {
    it("fails clearly when the search provider is not configured", async () => {
        delete process.env.ASSET_SEARCH_PROVIDER
        delete process.env.ASSET_SEARCH_BASE_URL

        await expect(
            searchAssets({
                query: "cell icon",
                assetType: "icon",
                formats: ["svg"],
                maxResults: 3,
            }),
        ).rejects.toThrow("Asset search is not configured")
    })
})

describe("detectLicense", () => {
    it("detects allowed reusable licenses", () => {
        expect(detectLicense("Licensed under CC BY 4.0")).toBe("CC BY")
        expect(detectLicense("This icon is free to use")).toBe("Free to Use")
    })
})

describe("parsePngDimensions", () => {
    it("reads width and height from PNG bytes", () => {
        const bytes = new Uint8Array(24)
        bytes[0] = 0x89
        bytes[1] = 0x50
        bytes[2] = 0x4e
        bytes[3] = 0x47

        const view = new DataView(bytes.buffer)
        view.setUint32(16, 320)
        view.setUint32(20, 180)

        expect(parsePngDimensions(bytes)).toEqual({ width: 320, height: 180 })
    })
})

describe("importAsset", () => {
    it("sanitizes svg assets before converting them to data URLs", async () => {
        const pageUrl = "https://bioicons.com/icons/cell"
        const assetUrl = "https://bioicons.com/assets/cell.svg"
        const svg = `
            <svg width="80" height="40" xmlns="http://www.w3.org/2000/svg">
              <script>alert("x")</script>
              <foreignObject><div>bad</div></foreignObject>
              <image href="https://evil.example.com/tracker.png" />
              <rect width="80" height="40" onclick="alert('x')" />
            </svg>
        `

        global.fetch = vi.fn(async (input: RequestInfo | URL) => {
            const url =
                typeof input === "string"
                    ? input
                    : input instanceof URL
                      ? input.toString()
                      : input.url

            if (url === pageUrl) {
                return new Response(
                    "<html><title>Cell Icon</title><body>free to use</body></html>",
                    {
                        status: 200,
                        headers: { "content-type": "text/html; charset=utf-8" },
                    },
                )
            }

            if (url === assetUrl) {
                return new Response(svg, {
                    status: 200,
                    headers: { "content-type": "image/svg+xml" },
                })
            }

            return new Response("not found", { status: 404 })
        }) as typeof fetch

        const result = await importAsset({
            assetUrl,
            pageUrl,
            label: "Cell",
        })

        const decodedSvg = Buffer.from(
            result.dataUrl.split(",")[1] || "",
            "base64",
        ).toString("utf-8")

        expect(result.format).toBe("svg")
        expect(result.width).toBe(80)
        expect(result.height).toBe(40)
        expect(result.license).toBe("Free to Use")
        expect(decodedSvg).not.toContain("<script")
        expect(decodedSvg).not.toContain("foreignObject")
        expect(decodedSvg).not.toContain("onclick=")
        expect(decodedSvg).not.toContain("https://evil.example.com")
    })
})
