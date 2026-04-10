import {
    APICallError,
    convertToModelMessages,
    createUIMessageStream,
    createUIMessageStreamResponse,
    InvalidToolInputError,
    LoadAPIKeyError,
    stepCountIs,
    streamText,
} from "ai"
import fs from "fs/promises"
import { jsonrepair } from "jsonrepair"
import path from "path"
import { z } from "zod"
import { isValidAccessCode, normalizeAccessCode } from "@/lib/access-code"
import {
    getAIModel,
    SINGLE_SYSTEM_PROVIDERS,
    supportsImageInput,
    supportsPromptCaching,
} from "@/lib/ai-providers"
import {
    getMaxImportsPerRequest,
    type ImportedAsset,
    importAsset,
    type SearchAssetResult,
    searchAssets,
} from "@/lib/asset-tools"
import { findCachedResponse } from "@/lib/cached-responses"
import {
    canRewriteHistoricalToolMessages,
    isMinimalDiagram,
    redactHistoricalToolResults,
    replaceHistoricalToolInputs,
    validateFileParts,
} from "@/lib/chat-helpers"
import {
    checkAndIncrementRequest,
    isQuotaEnabled,
    recordTokenUsage,
} from "@/lib/dynamo-quota-manager"
import {
    getTelemetryConfig,
    setTraceInput,
    setTraceOutput,
    wrapWithObserve,
} from "@/lib/langfuse"
import {
    buildModelFailoverHeaders,
    sanitizeModelErrorMessage,
    shouldFailoverToNextModel,
} from "@/lib/model-failover"
import {
    type FlattenedServerModel,
    getServerModelFailoverCandidates,
} from "@/lib/server-model-config"
import { getSystemPrompt } from "@/lib/system-prompts"
import { getUserIdFromRequest } from "@/lib/user-id"

export const maxDuration = 120

const GEMINI_MODEL_PATTERN = /gemini/i
const ASSET_ACTION_PATTERN =
    /(search|find|download|import|insert|add|搜|搜索|查找|下载|导入|插入|添加)/i
const ASSET_NOUN_PATTERN =
    /(asset|assets|icon|icons|illustration|template|svg|png|素材|图标|插图|模板|矢量)/i
const KNOWN_ASSET_SITE_PATTERN =
    /(bioicons|scidraw|phylopic|smart|swissbiopics|iconfinder|iconfont)/i

interface AssetPlacement {
    x: number
    y: number
}

function isGeminiLikeModel(modelId: string): boolean {
    return GEMINI_MODEL_PATTERN.test(modelId)
}

function isExplicitExternalAssetRequest(text: string): boolean {
    const normalized = text.trim()
    if (!normalized) return false

    return (
        (ASSET_ACTION_PATTERN.test(normalized) &&
            ASSET_NOUN_PATTERN.test(normalized)) ||
        KNOWN_ASSET_SITE_PATTERN.test(normalized)
    )
}

function inferAssetType(
    text: string,
): "icon" | "illustration" | "template" | "mixed" {
    if (/(template|模板)/i.test(text)) return "template"
    if (/(illustration|插图|示意图)/i.test(text)) return "illustration"
    if (/(icon|图标|素材|矢量)/i.test(text)) return "icon"
    return "mixed"
}

function inferAssetFormats(text: string): Array<"svg" | "png"> {
    const wantsSvg = /(svg|矢量)/i.test(text)
    const wantsPng = /(png)/i.test(text)

    if (wantsSvg && wantsPng) return ["svg", "png"]
    if (wantsPng && !wantsSvg) return ["png"]
    return ["svg", "png"]
}

function extractAssetSearchQuery(text: string): string {
    const cleaned = text
        .replace(
            /\b(?:please|search|find|download|import|insert|add|external|reusable|asset|assets|site|sites|for|and|into|canvas|available|result|results)\b/gi,
            " ",
        )
        .replace(
            /(?:请|帮我|搜索|查找|下载|导入|插入|添加|外部|素材网站|网站|可复用|免费的?|可用结果|结果|画布|并把|把)/g,
            " ",
        )
        .replace(/\s+/g, " ")
        .trim()

    return cleaned.length > 0 ? cleaned.slice(0, 500) : text.slice(0, 500)
}

function escapeXml(value: string): string {
    return value
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/'/g, "&apos;")
}

function sanitizeLabel(value: string | undefined, fallback: string): string {
    const candidate = (value || fallback).trim()
    return candidate.length > 0 ? candidate.slice(0, 80) : fallback
}

function getGeometryBounds(xml: string): { maxRight: number; minTop: number } {
    let maxRight = 0
    let minTop = Number.POSITIVE_INFINITY

    for (const match of xml.matchAll(/<mxGeometry\b[^>]*>/g)) {
        const tag = match[0]
        const x = Number(tag.match(/\bx="([^"]+)"/)?.[1] || "")
        const y = Number(tag.match(/\by="([^"]+)"/)?.[1] || "")
        const width = Number(tag.match(/\bwidth="([^"]+)"/)?.[1] || "")
        const height = Number(tag.match(/\bheight="([^"]+)"/)?.[1] || "")

        if (
            Number.isFinite(x) &&
            Number.isFinite(y) &&
            Number.isFinite(width) &&
            Number.isFinite(height)
        ) {
            maxRight = Math.max(maxRight, x + width)
            minTop = Math.min(minTop, y)
        }
    }

    return {
        maxRight,
        minTop: Number.isFinite(minTop) ? minTop : 40,
    }
}

function getAssetPlacement(
    index: number,
    total: number,
    xml: string,
): AssetPlacement {
    if (!xml || isMinimalDiagram(xml)) {
        const columns = total >= 3 ? 3 : 2
        const column = index % columns
        const row = Math.floor(index / columns)

        return {
            x: 40 + column * 240,
            y: 40 + row * 260,
        }
    }

    const bounds = getGeometryBounds(xml)
    return {
        x: bounds.maxRight + 80,
        y: bounds.minTop + index * 260,
    }
}

function buildAssetCells(
    asset: ImportedAsset,
    index: number,
    total: number,
    xml: string,
): { cellId: string; xml: string } {
    const placement = getAssetPlacement(index, total, xml)
    const maxImageWidth = 180
    const maxImageHeight = 160
    const width = Math.max(asset.width || 128, 1)
    const height = Math.max(asset.height || 128, 1)
    const scale = Math.min(maxImageWidth / width, maxImageHeight / height, 1)
    const imageWidth = Math.max(64, Math.round(width * scale))
    const imageHeight = Math.max(64, Math.round(height * scale))
    const label = sanitizeLabel(asset.label, asset.attribution)
    const baseId = `asset-${Date.now()}-${index}`

    const imageCell = `<mxCell id="${baseId}" value="" style="shape=image;aspect=fixed;html=1;image=${escapeXml(asset.dataUrl)};align=center;verticalAlign=top;" vertex="1" parent="1"><mxGeometry x="${placement.x}" y="${placement.y}" width="${imageWidth}" height="${imageHeight}" as="geometry"/></mxCell>`
    const labelCell = `<mxCell id="${baseId}-label" value="${escapeXml(label)}" style="text;html=1;strokeColor=none;fillColor=none;align=center;verticalAlign=top;whiteSpace=wrap;fontSize=12;" vertex="1" parent="1"><mxGeometry x="${placement.x - 20}" y="${placement.y + imageHeight + 12}" width="${imageWidth + 40}" height="34" as="geometry"/></mxCell>`

    return {
        cellId: baseId,
        xml: `${imageCell}\n${labelCell}`,
    }
}

function buildAssetSummary(params: {
    importedAssets: ImportedAsset[]
    searchResults: SearchAssetResult[]
    searchError?: string
    importErrors: string[]
}): string {
    const lines: string[] = []

    if (params.importedAssets.length > 0) {
        lines.push(`已导入 ${params.importedAssets.length} 个外部素材到画布。`)
        for (const asset of params.importedAssets) {
            lines.push(
                `- ${sanitizeLabel(asset.label, asset.attribution)} | ${asset.source} | ${asset.license} | ${asset.pageUrl}`,
            )
        }
    } else if (params.searchResults.length > 0) {
        lines.push("已完成素材搜索，但当前没有可自动导入的结果。")
        for (const result of params.searchResults.slice(0, 5)) {
            lines.push(
                `- ${result.title} | ${result.source} | ${result.license || "license unknown"} | ${result.pageUrl}`,
            )
        }
    }

    if (params.searchError) {
        lines.push(`搜索失败：${params.searchError}`)
    }

    for (const error of params.importErrors) {
        lines.push(`导入失败：${error}`)
    }

    return lines.join("\n")
}

function createDirectAssetResponse(params: {
    xml: string
    importedAssets: ImportedAsset[]
    searchResults: SearchAssetResult[]
    searchError?: string
    importErrors: string[]
}): Response {
    const toolCallId = `asset-fallback-${Date.now()}`
    const summary = buildAssetSummary(params)

    const stream = createUIMessageStream({
        execute: async ({ writer }) => {
            writer.write({ type: "start" })

            if (summary) {
                writer.write({ type: "text-start", id: "0" })
                writer.write({ type: "text-delta", id: "0", delta: summary })
                writer.write({ type: "text-end", id: "0" })
            }

            if (params.importedAssets.length > 0) {
                const toolName =
                    !params.xml || isMinimalDiagram(params.xml)
                        ? "display_diagram"
                        : "edit_diagram"

                if (toolName === "display_diagram") {
                    const diagramXml = params.importedAssets
                        .map(
                            (asset, index) =>
                                buildAssetCells(
                                    asset,
                                    index,
                                    params.importedAssets.length,
                                    params.xml,
                                ).xml,
                        )
                        .join("\n")

                    writer.write({
                        type: "tool-input-start",
                        toolCallId,
                        toolName,
                    })
                    writer.write({
                        type: "tool-input-delta",
                        toolCallId,
                        inputTextDelta: diagramXml,
                    })
                    writer.write({
                        type: "tool-input-available",
                        toolCallId,
                        toolName,
                        input: { xml: diagramXml },
                    })
                } else {
                    const operations = params.importedAssets.flatMap(
                        (asset, index) => {
                            const cell = buildAssetCells(
                                asset,
                                index,
                                params.importedAssets.length,
                                params.xml,
                            )

                            return cell.xml
                                .split("\n")
                                .map((newXml, xmlIndex) => ({
                                    operation: "add" as const,
                                    cell_id:
                                        xmlIndex === 0
                                            ? cell.cellId
                                            : `${cell.cellId}-label`,
                                    new_xml: newXml,
                                }))
                        },
                    )

                    writer.write({
                        type: "tool-input-start",
                        toolCallId,
                        toolName,
                    })
                    writer.write({
                        type: "tool-input-delta",
                        toolCallId,
                        inputTextDelta: JSON.stringify({ operations }),
                    })
                    writer.write({
                        type: "tool-input-available",
                        toolCallId,
                        toolName,
                        input: { operations },
                    })
                }
            }

            writer.write({ type: "finish" })
        },
    })

    return createUIMessageStreamResponse({ stream })
}

function extractDiagramXmlFromText(text: string): {
    planText: string
    xml: string
} | null {
    const firstCellIndex = text.indexOf("<mxCell")
    const lastCellEndIndex = text.lastIndexOf("</mxCell>")
    if (firstCellIndex < 0 || lastCellEndIndex < firstCellIndex) {
        return null
    }

    const xml = text
        .slice(firstCellIndex, lastCellEndIndex + "</mxCell>".length)
        .trim()
    if (!xml.includes("<mxGeometry")) return null

    const planText = text
        .slice(0, firstCellIndex)
        .replace(/```(?:xml)?/gi, "")
        .replace(/---+\s*$/g, "")
        .trim()

    return {
        planText,
        xml,
    }
}

function normalizeRawXmlTextChunks(chunks: any[]): any[] {
    const hasDiagramTool = chunks.some(
        (chunk) =>
            typeof chunk.type === "string" &&
            chunk.type.includes("display_diagram"),
    )
    if (hasDiagramTool) return chunks

    const textChunks = chunks.filter((chunk) => chunk.type === "text-delta")
    const text = textChunks.map((chunk) => chunk.delta || "").join("")
    const extracted = extractDiagramXmlFromText(text)
    if (!extracted) return chunks

    const textStart = chunks.find((chunk) => chunk.type === "text-start")
    const finishStepIndex = chunks.findIndex(
        (chunk) => chunk.type === "finish-step",
    )
    const insertIndex = finishStepIndex >= 0 ? finishStepIndex : chunks.length
    const toolCallId = `raw-xml-fallback-${Date.now()}`
    const transformed: any[] = []
    let insertedTool = false

    for (let index = 0; index < chunks.length; index++) {
        const chunk = chunks[index]

        if (
            chunk.type === "text-start" ||
            chunk.type === "text-delta" ||
            chunk.type === "text-end"
        ) {
            continue
        }

        if (!insertedTool && index >= insertIndex) {
            if (extracted.planText) {
                transformed.push({
                    type: "text-start",
                    id: textStart?.id || "0",
                })
                transformed.push({
                    type: "text-delta",
                    id: textStart?.id || "0",
                    delta: extracted.planText,
                })
                transformed.push({
                    type: "text-end",
                    id: textStart?.id || "0",
                })
            }
            transformed.push({
                type: "tool-input-start",
                toolCallId,
                toolName: "display_diagram",
            })
            transformed.push({
                type: "tool-input-delta",
                toolCallId,
                inputTextDelta: extracted.xml,
            })
            transformed.push({
                type: "tool-input-available",
                toolCallId,
                toolName: "display_diagram",
                input: { xml: extracted.xml },
            })
            insertedTool = true
        }

        transformed.push(chunk)
    }

    if (!insertedTool) {
        if (extracted.planText) {
            transformed.push({
                type: "text-start",
                id: textStart?.id || "0",
            })
            transformed.push({
                type: "text-delta",
                id: textStart?.id || "0",
                delta: extracted.planText,
            })
            transformed.push({
                type: "text-end",
                id: textStart?.id || "0",
            })
        }
        transformed.push({
            type: "tool-input-start",
            toolCallId,
            toolName: "display_diagram",
        })
        transformed.push({
            type: "tool-input-delta",
            toolCallId,
            inputTextDelta: extracted.xml,
        })
        transformed.push({
            type: "tool-input-available",
            toolCallId,
            toolName: "display_diagram",
            input: { xml: extracted.xml },
        })
    }

    return transformed
}

async function maybeHandleGeminiAssetRequest(params: {
    modelId: string
    userInputText: string
    xml: string
}): Promise<Response | null> {
    if (!isGeminiLikeModel(params.modelId)) {
        return null
    }

    if (!isExplicitExternalAssetRequest(params.userInputText)) {
        return null
    }

    const maxImports = getMaxImportsPerRequest()
    const importErrors: string[] = []
    let searchResults: SearchAssetResult[] = []
    let searchError: string | undefined

    try {
        searchResults = await searchAssets({
            query: extractAssetSearchQuery(params.userInputText),
            assetType: inferAssetType(params.userInputText),
            formats: inferAssetFormats(params.userInputText),
            maxResults: maxImports,
        })
    } catch (error) {
        searchError =
            error instanceof Error ? error.message : "Asset search failed."
    }

    const importedAssets: ImportedAsset[] = []

    for (const result of searchResults) {
        if (!result.importable) continue
        if (importedAssets.length >= maxImports) break

        try {
            importedAssets.push(
                await importAsset({
                    assetUrl: result.assetUrl,
                    pageUrl: result.pageUrl,
                    label: sanitizeLabel(undefined, result.title),
                }),
            )
        } catch (error) {
            importErrors.push(
                error instanceof Error ? error.message : "Asset import failed.",
            )
        }
    }

    return createDirectAssetResponse({
        xml: params.xml,
        importedAssets,
        searchResults,
        searchError,
        importErrors,
    })
}

// Helper function to create cached stream response
function createCachedStreamResponse(xml: string): Response {
    const toolCallId = `cached-${Date.now()}`

    const stream = createUIMessageStream({
        execute: async ({ writer }) => {
            writer.write({ type: "start" })
            writer.write({
                type: "tool-input-start",
                toolCallId,
                toolName: "display_diagram",
            })
            writer.write({
                type: "tool-input-delta",
                toolCallId,
                inputTextDelta: xml,
            })
            writer.write({
                type: "tool-input-available",
                toolCallId,
                toolName: "display_diagram",
                input: { xml },
            })
            writer.write({ type: "finish" })
        },
    })

    return createUIMessageStreamResponse({ stream })
}

// Inner handler function
async function handleChatRequest(req: Request): Promise<Response> {
    // Check for access code
    const accessCodeHeader = normalizeAccessCode(
        req.headers.get("x-access-code"),
    )
    if (!isValidAccessCode(accessCodeHeader)) {
        return Response.json(
            {
                error: "Invalid or missing access code. Please configure it in Settings.",
            },
            { status: 401 },
        )
    }

    const body = await req.json()
    const { messages, xml, previousXml, sessionId } = body
    const customSystemMessage =
        typeof body.customSystemMessage === "string"
            ? body.customSystemMessage.slice(0, 5000)
            : ""

    // Get user ID for Langfuse tracking and quota
    const userId = getUserIdFromRequest(req)

    // Validate sessionId for Langfuse (must be string, max 200 chars)
    const validSessionId =
        sessionId && typeof sessionId === "string" && sessionId.length <= 200
            ? sessionId
            : undefined

    // Extract user input text for Langfuse trace
    // Find the last USER message, not just the last message (which could be assistant in multi-step tool flows)
    const lastUserMessage = [...messages]
        .reverse()
        .find((m: any) => m.role === "user")
    const userInputText =
        lastUserMessage?.parts?.find((p: any) => p.type === "text")?.text || ""

    // Update Langfuse trace with input, session, and user
    setTraceInput({
        input: userInputText,
        sessionId: validSessionId,
        userId: userId,
    })

    // === SERVER-SIDE QUOTA CHECK START ===
    // Quota is opt-in: only enabled when DYNAMODB_QUOTA_TABLE env var is set
    const hasOwnApiKey = !!(
        req.headers.get("x-ai-provider") &&
        (req.headers.get("x-ai-api-key") ||
            req.headers.get("x-aws-access-key-id") ||
            req.headers.get("x-vertex-api-key"))
    )

    // Skip quota check if: quota disabled, user has own API key, or is anonymous
    if (isQuotaEnabled() && !hasOwnApiKey && userId !== "anonymous") {
        const quotaCheck = await checkAndIncrementRequest(userId, {
            requests: Number(process.env.DAILY_REQUEST_LIMIT) || 10,
            tokens: Number(process.env.DAILY_TOKEN_LIMIT) || 200000,
            tpm: Number(process.env.TPM_LIMIT) || 20000,
        })
        if (!quotaCheck.allowed) {
            return Response.json(
                {
                    error: quotaCheck.error,
                    type: quotaCheck.type,
                    used: quotaCheck.used,
                    limit: quotaCheck.limit,
                },
                { status: 429 },
            )
        }
    }
    // === SERVER-SIDE QUOTA CHECK END ===

    // === FILE VALIDATION START ===
    const fileValidation = validateFileParts(messages)
    if (!fileValidation.valid) {
        return Response.json({ error: fileValidation.error }, { status: 400 })
    }
    // === FILE VALIDATION END ===

    // === CACHE CHECK START ===
    const isFirstMessage = messages.length === 1
    const isEmptyDiagram = !xml || xml.trim() === "" || isMinimalDiagram(xml)

    if (isFirstMessage && isEmptyDiagram) {
        const lastMessage = messages[0]
        const textPart = lastMessage.parts?.find((p: any) => p.type === "text")
        const filePart = lastMessage.parts?.find((p: any) => p.type === "file")

        const cached = findCachedResponse(textPart?.text || "", !!filePart)

        if (cached) {
            return createCachedStreamResponse(cached.xml)
        }
    }
    // === CACHE CHECK END ===

    // Read client AI provider overrides from headers
    const provider = req.headers.get("x-ai-provider")
    let baseUrl = req.headers.get("x-ai-base-url")
    const selectedModelId = req.headers.get("x-selected-model-id")

    // For EdgeOne provider, construct full URL from request origin
    // because createOpenAI needs absolute URL, not relative path
    if (provider === "edgeone" && !baseUrl) {
        const origin = req.headers.get("origin") || new URL(req.url).origin
        baseUrl = `${origin}/api/edgeai`
    }

    // Get cookie header for EdgeOne authentication (eo_token, eo_time)
    const cookieHeader = req.headers.get("cookie")

    const serverModelCandidates = selectedModelId?.startsWith("server:")
        ? await getServerModelFailoverCandidates(selectedModelId)
        : []

    const baseClientOverrides = {
        provider,
        baseUrl,
        apiKey: req.headers.get("x-ai-api-key"),
        modelId: req.headers.get("x-ai-model"),
        account: req.headers.get("x-ai-account"),
        // AWS Bedrock credentials
        awsAccessKeyId: req.headers.get("x-aws-access-key-id"),
        awsSecretAccessKey: req.headers.get("x-aws-secret-access-key"),
        awsRegion: req.headers.get("x-aws-region"),
        awsSessionToken: req.headers.get("x-aws-session-token"),
        // Vertex AI credentials (Express Mode)
        vertexApiKey: req.headers.get("x-vertex-api-key"),
        // Pass cookies for EdgeOne Pages authentication
        ...(provider === "edgeone" &&
            cookieHeader && {
                headers: { cookie: cookieHeader },
            }),
    }

    // Read minimal style preference from header
    const minimalStyle = req.headers.get("x-minimal-style") === "true"

    const fileParts =
        lastUserMessage?.parts?.filter((part: any) => part.type === "file") ||
        []
    const formattedUserInput = `User input:
"""md
${userInputText}
"""`
    const telemetryConfig = getTelemetryConfig({
        sessionId: validSessionId,
        userId,
    })
    const uiMessageStreamOptions = {
        sendReasoning: true,
        messageMetadata: ({ part }: { part: any }) => {
            if (part.type === "finish") {
                const usage = (part as any).totalUsage
                return {
                    totalTokens: usage?.totalTokens ?? 0,
                    finishReason: (part as any).finishReason,
                }
            }
            return undefined
        },
    }

    function withResponseHeaders(
        response: Response,
        headers: Headers,
    ): Response {
        const mergedHeaders = new Headers(response.headers)
        headers.forEach((value, key) => {
            mergedHeaders.set(key, value)
        })

        return new Response(response.body, {
            status: response.status,
            statusText: response.statusText,
            headers: mergedHeaders,
        })
    }

    function createAttemptHeaders(params: {
        actualModelId: string
        actualProvider: string
        actualSelectedModelId?: string | null
        attemptedSelectedModelIds: string[]
    }): Headers {
        return buildModelFailoverHeaders({
            actualModelId: params.actualModelId,
            actualProvider: params.actualProvider,
            actualSelectedModelId: params.actualSelectedModelId,
            requestedSelectedModelId: selectedModelId,
            attemptedSelectedModelIds: params.attemptedSelectedModelIds,
        })
    }

    async function createAttemptResult(
        candidate?: FlattenedServerModel | null,
    ): Promise<{
        actualModelId: string
        actualProvider: string
        actualSelectedModelId?: string | null
        response?: Response
        result?: ReturnType<typeof streamText>
    }> {
        const clientOverrides = candidate
            ? {
                  ...baseClientOverrides,
                  provider: candidate.provider,
                  modelId: candidate.modelId,
                  apiKeyEnv: candidate.apiKeyEnv,
                  baseUrlEnv: candidate.baseUrlEnv,
              }
            : {
                  ...baseClientOverrides,
                  provider: selectedModelId?.startsWith("server:")
                      ? undefined
                      : baseClientOverrides.provider,
                  modelId: selectedModelId?.startsWith("server:")
                      ? undefined
                      : baseClientOverrides.modelId,
              }

        console.log(
            `[Client Overrides] provider: ${clientOverrides.provider}, modelId: ${clientOverrides.modelId}`,
        )

        const {
            model,
            providerOptions,
            headers,
            modelId,
            provider: resolvedProvider,
        } = getAIModel(clientOverrides)

        const shouldCache = supportsPromptCaching(modelId)
        console.log(
            `[Prompt Caching] ${shouldCache ? "ENABLED" : "DISABLED"} for model: ${modelId}`,
        )

        const systemMessage = getSystemPrompt(modelId, minimalStyle)
        const finalSystemMessage = customSystemMessage
            ? `${systemMessage}\n\n## Custom Instructions\n${customSystemMessage}`
            : systemMessage

        if (fileParts.length > 0 && !supportsImageInput(modelId)) {
            return {
                actualModelId: modelId,
                actualProvider: resolvedProvider,
                actualSelectedModelId: candidate?.id ?? selectedModelId,
                response: Response.json(
                    {
                        error: `The model "${modelId}" does not support image input. Please use a vision-capable model (e.g., GPT-4o, Claude, Gemini) or remove the image.`,
                    },
                    { status: 400 },
                ),
            }
        }

        const geminiAssetFallbackResponse = await maybeHandleGeminiAssetRequest(
            {
                modelId,
                userInputText,
                xml,
            },
        )
        if (geminiAssetFallbackResponse) {
            return {
                actualModelId: modelId,
                actualProvider: resolvedProvider,
                actualSelectedModelId: candidate?.id ?? selectedModelId,
                response: geminiAssetFallbackResponse,
            }
        }

        const modelMessages = await convertToModelMessages(messages)

        console.log("[route.ts] Incoming messages count:", messages.length)
        messages.forEach((msg: any, idx: number) => {
            console.log(
                `[route.ts] Message ${idx} role:`,
                msg.role,
                "parts count:",
                msg.parts?.length,
            )
            if (msg.parts) {
                msg.parts.forEach((part: any, partIdx: number) => {
                    if (
                        part.type === "tool-invocation" ||
                        part.type === "tool-result"
                    ) {
                        console.log(`[route.ts]   Part ${partIdx}:`, {
                            type: part.type,
                            toolName: part.toolName,
                            hasInput: !!part.input,
                            inputType: typeof part.input,
                            inputKeys:
                                part.input && typeof part.input === "object"
                                    ? Object.keys(part.input)
                                    : null,
                        })
                    }
                })
            }
        })

        const canRewriteHistory = canRewriteHistoricalToolMessages(
            resolvedProvider,
            modelId,
        )

        const enableHistoryReplace =
            process.env.ENABLE_HISTORY_XML_REPLACE === "true"
        const placeholderMessages =
            enableHistoryReplace && canRewriteHistory
                ? replaceHistoricalToolInputs(modelMessages)
                : modelMessages
        const redactedMessages = canRewriteHistory
            ? redactHistoricalToolResults(placeholderMessages)
            : placeholderMessages

        let enhancedMessages = redactedMessages.filter(
            (msg: any) =>
                msg.content &&
                Array.isArray(msg.content) &&
                msg.content.length > 0,
        )

        if (canRewriteHistory) {
            enhancedMessages = enhancedMessages
                .map((msg: any) => {
                    if (
                        msg.role !== "assistant" ||
                        !Array.isArray(msg.content)
                    ) {
                        return msg
                    }
                    const filteredContent = msg.content.filter((part: any) => {
                        if (part.type === "tool-call") {
                            if (
                                !part.input ||
                                typeof part.input !== "object" ||
                                Object.keys(part.input).length === 0
                            ) {
                                console.warn(
                                    `[route.ts] Filtering out tool-call with invalid input:`,
                                    {
                                        toolName: part.toolName,
                                        input: part.input,
                                    },
                                )
                                return false
                            }
                        }
                        return true
                    })
                    return { ...msg, content: filteredContent }
                })
                .filter((msg: any) => msg.content && msg.content.length > 0)
        }

        console.log("[route.ts] Model messages count:", enhancedMessages.length)
        enhancedMessages.forEach((msg: any, idx: number) => {
            console.log(
                `[route.ts] ModelMsg ${idx} role:`,
                msg.role,
                "content count:",
                msg.content?.length,
            )
            if (msg.content) {
                msg.content.forEach((part: any, partIdx: number) => {
                    if (
                        part.type === "tool-call" ||
                        part.type === "tool-result"
                    ) {
                        console.log(`[route.ts]   Content ${partIdx}:`, {
                            type: part.type,
                            toolName: part.toolName,
                            hasInput: !!part.input,
                            inputType: typeof part.input,
                            inputValue:
                                part.input === undefined
                                    ? "undefined"
                                    : part.input === null
                                      ? "null"
                                      : "object",
                        })
                    }
                })
            }
        })

        if (enhancedMessages.length >= 1) {
            const lastModelMessage =
                enhancedMessages[enhancedMessages.length - 1]
            if (lastModelMessage.role === "user") {
                const contentParts: any[] = [
                    { type: "text", text: formattedUserInput },
                ]

                for (const filePart of fileParts) {
                    contentParts.push({
                        type: "image",
                        image: filePart.url,
                        mimeType: filePart.mediaType,
                    })
                }

                enhancedMessages = [
                    ...enhancedMessages.slice(0, -1),
                    { ...lastModelMessage, content: contentParts },
                ]
            }
        }

        if (shouldCache && enhancedMessages.length >= 2) {
            for (let i = enhancedMessages.length - 2; i >= 0; i--) {
                if (enhancedMessages[i].role === "assistant") {
                    enhancedMessages[i] = {
                        ...enhancedMessages[i],
                        providerOptions: {
                            bedrock: { cachePoint: { type: "default" } },
                        },
                    }
                    break
                }
            }
        }

        const isSingleSystemProvider =
            SINGLE_SYSTEM_PROVIDERS.has(resolvedProvider)

        const xmlContext = `${
            previousXml
                ? `Previous diagram XML (before user's last message):
"""xml
${previousXml}
"""

`
                : ""
        }Current diagram XML (AUTHORITATIVE - the source of truth):
"""xml
${xml || ""}
"""

IMPORTANT: The "Current diagram XML" is the SINGLE SOURCE OF TRUTH for what's on the canvas right now. The user can manually add, delete, or modify shapes directly in draw.io. Always count and describe elements based on the CURRENT XML, not on what you previously generated. If both previous and current XML are shown, compare them to understand what the user changed. When using edit_diagram, COPY search patterns exactly from the CURRENT XML - attribute order matters!`

        const systemMessages = isSingleSystemProvider
            ? [
                  {
                      role: "system" as const,
                      content: `${finalSystemMessage}\n\n${xmlContext}`,
                  },
              ]
            : [
                  {
                      role: "system" as const,
                      content: finalSystemMessage,
                      ...(shouldCache && {
                          providerOptions: {
                              bedrock: { cachePoint: { type: "default" } },
                          },
                      }),
                  },
                  {
                      role: "system" as const,
                      content: xmlContext,
                      ...(shouldCache && {
                          providerOptions: {
                              bedrock: { cachePoint: { type: "default" } },
                          },
                      }),
                  },
              ]

        const allMessages = [...systemMessages, ...enhancedMessages]
        const maxToolSteps = Math.max(5, getMaxImportsPerRequest() + 5)

        const result = streamText({
            model,
            abortSignal: req.signal,
            ...(process.env.MAX_OUTPUT_TOKENS && {
                maxOutputTokens: parseInt(process.env.MAX_OUTPUT_TOKENS, 10),
            }),
            stopWhen: stepCountIs(maxToolSteps),
            experimental_repairToolCall: async ({ toolCall, error }) => {
                console.log(`[repairToolCall] Tool: ${toolCall.toolName}`)
                console.log(
                    `[repairToolCall] Error: ${error.name} - ${error.message}`,
                )
                console.log(
                    `[repairToolCall] Input type: ${typeof toolCall.input}`,
                )
                console.log(`[repairToolCall] Input value:`, toolCall.input)

                if (
                    error instanceof InvalidToolInputError ||
                    error.name === "AI_InvalidToolInputError"
                ) {
                    try {
                        let inputToRepair = toolCall.input
                        if (typeof inputToRepair === "string") {
                            inputToRepair = inputToRepair.replace(/:=/g, ": ")
                            inputToRepair = inputToRepair.replace(
                                /=\s*"/g,
                                ': "',
                            )
                            inputToRepair = inputToRepair.replace(
                                /(\w+)="([^"]*?)\\"/g,
                                '$1=\\"$2\\"',
                            )
                        }
                        const repairedInput = jsonrepair(inputToRepair)
                        console.log(
                            `[repairToolCall] Repaired truncated JSON for tool: ${toolCall.toolName}`,
                        )
                        return { ...toolCall, input: repairedInput }
                    } catch (repairError) {
                        console.warn(
                            `[repairToolCall] Failed to repair JSON for tool: ${toolCall.toolName}`,
                            repairError,
                        )
                        if (toolCall.toolName === "edit_diagram") {
                            return {
                                ...toolCall,
                                input: {
                                    operations: [],
                                    _error: "JSON repair failed - no operations to apply",
                                },
                            }
                        }
                        if (toolCall.toolName === "display_diagram") {
                            return {
                                ...toolCall,
                                input: {
                                    xml: "",
                                    _error: "JSON repair failed - empty diagram",
                                },
                            }
                        }
                        return null
                    }
                }
                return null
            },
            messages: allMessages,
            ...(providerOptions && { providerOptions }),
            ...(headers && { headers }),
            ...(telemetryConfig && {
                experimental_telemetry: telemetryConfig,
            }),
            onFinish: ({ text, totalUsage }) => {
                setTraceOutput(text)

                if (
                    isQuotaEnabled() &&
                    !hasOwnApiKey &&
                    userId !== "anonymous" &&
                    totalUsage
                ) {
                    const totalTokens =
                        (totalUsage.inputTokens || 0) +
                        (totalUsage.outputTokens || 0) +
                        (totalUsage.cachedInputTokens || 0) +
                        (totalUsage.inputTokenDetails?.cacheWriteTokens || 0)
                    recordTokenUsage(userId, totalTokens)
                }
            },
            tools: {
                // Client-side tool that will be executed on the client
                display_diagram: {
                    description: `Display a diagram on draw.io. Pass ONLY the mxCell elements - wrapper tags and root cells are added automatically.

VALIDATION RULES (XML will be rejected if violated):
1. Generate ONLY mxCell elements - NO wrapper tags (<mxfile>, <mxGraphModel>, <root>)
2. Do NOT include root cells (id="0" or id="1") - they are added automatically
3. All mxCell elements must be siblings - never nested
4. Every mxCell needs a unique id (start from "2")
5. Every mxCell needs a valid parent attribute (use "1" for top-level)
6. Escape special chars in values: &lt; &gt; &amp; &quot;

Example (generate ONLY this - no wrapper tags):
<mxCell id="lane1" value="Frontend" style="swimlane;" vertex="1" parent="1">
  <mxGeometry x="40" y="40" width="200" height="200" as="geometry"/>
</mxCell>
<mxCell id="step1" value="Step 1" style="rounded=1;" vertex="1" parent="lane1">
  <mxGeometry x="20" y="60" width="160" height="40" as="geometry"/>
</mxCell>
<mxCell id="lane2" value="Backend" style="swimlane;" vertex="1" parent="1">
  <mxGeometry x="280" y="40" width="200" height="200" as="geometry"/>
</mxCell>
<mxCell id="step2" value="Step 2" style="rounded=1;" vertex="1" parent="lane2">
  <mxGeometry x="20" y="60" width="160" height="40" as="geometry"/>
</mxCell>
<mxCell id="edge1" style="edgeStyle=orthogonalEdgeStyle;endArrow=classic;" edge="1" parent="1" source="step1" target="step2">
  <mxGeometry relative="1" as="geometry"/>
</mxCell>

Notes:
- For AWS diagrams, use **AWS 2025 icons**.
- For animated connectors, add "flowAnimation=1" to edge style.
`,
                    inputSchema: z.object({
                        xml: z
                            .string()
                            .describe("XML string to be displayed on draw.io"),
                    }),
                },
                edit_diagram: {
                    description: `Edit the current diagram by ID-based operations (update/add/delete cells).

Operations:
- update: Replace an existing cell by its id. Provide cell_id and complete new_xml.
- add: Add a new cell. Provide cell_id (new unique id) and new_xml.
- delete: Remove a cell. Cascade is automatic: children AND edges (source/target) are auto-deleted. Only specify ONE cell_id.

For update/add, new_xml must be a complete mxCell element including mxGeometry.

⚠️ JSON ESCAPING: Every " inside new_xml MUST be escaped as \\". Example: id=\\"5\\" value=\\"Label\\"

Example - Add a rectangle:
{"operations": [{"operation": "add", "cell_id": "rect-1", "new_xml": "<mxCell id=\\"rect-1\\" value=\\"Hello\\" style=\\"rounded=0;\\" vertex=\\"1\\" parent=\\"1\\"><mxGeometry x=\\"100\\" y=\\"100\\" width=\\"120\\" height=\\"60\\" as=\\"geometry\\"/></mxCell>"}]}

Example - Delete container (children & edges auto-deleted):
{"operations": [{"operation": "delete", "cell_id": "2"}]}`,
                    inputSchema: z.object({
                        operations: z
                            .array(
                                z.object({
                                    operation: z
                                        .enum(["update", "add", "delete"])
                                        .describe(
                                            "Operation to perform: add, update, or delete",
                                        ),
                                    cell_id: z
                                        .string()
                                        .describe(
                                            "The id of the mxCell. Must match the id attribute in new_xml.",
                                        ),
                                    new_xml: z
                                        .string()
                                        .optional()
                                        .describe(
                                            "Complete mxCell XML element (required for update/add)",
                                        ),
                                }),
                            )
                            .describe("Array of operations to apply"),
                    }),
                },
                append_diagram: {
                    description: `Continue generating diagram XML when previous display_diagram output was truncated due to length limits.

WHEN TO USE: Only call this tool after display_diagram was truncated (you'll see an error message about truncation).

CRITICAL INSTRUCTIONS:
1. Do NOT include any wrapper tags - just continue the mxCell elements
2. Continue from EXACTLY where your previous output stopped
3. Complete the remaining mxCell elements
4. If still truncated, call append_diagram again with the next fragment

Example: If previous output ended with '<mxCell id="x" style="rounded=1', continue with ';" vertex="1">...' and complete the remaining elements.`,
                    inputSchema: z.object({
                        xml: z
                            .string()
                            .describe(
                                "Continuation XML fragment to append (NO wrapper tags)",
                            ),
                    }),
                },
                get_shape_library: {
                    description: `Get draw.io shape/icon library documentation with style syntax and shape names.

Available libraries:
- Cloud: aws4, azure2, gcp2, alibaba_cloud, openstack, salesforce
- Networking: cisco19, network, kubernetes, vvd, rack
- Business: bpmn, lean_mapping
- General: flowchart, basic, arrows2, infographic, sitemap
- UI/Mockups: android, material_design
- Enterprise: citrix, sap, mscae, atlassian
- Engineering: fluidpower, electrical, pid, cabinets, floorplan
- Icons: webicons

Call this tool to get shape names and usage syntax for a specific library.`,
                    inputSchema: z.object({
                        library: z
                            .string()
                            .describe(
                                "Library name (e.g., 'aws4', 'kubernetes', 'flowchart')",
                            ),
                    }),
                    execute: async ({ library }) => {
                        // Sanitize input - prevent path traversal attacks
                        const sanitizedLibrary = library
                            .toLowerCase()
                            .replace(/[^a-z0-9_-]/g, "")

                        if (sanitizedLibrary !== library.toLowerCase()) {
                            return `Invalid library name "${library}". Use only letters, numbers, underscores, and hyphens.`
                        }

                        const baseDir = path.join(
                            process.cwd(),
                            "docs/shape-libraries",
                        )
                        const filePath = path.join(
                            baseDir,
                            `${sanitizedLibrary}.md`,
                        )

                        // Verify path stays within expected directory
                        const resolvedPath = path.resolve(filePath)
                        if (!resolvedPath.startsWith(path.resolve(baseDir))) {
                            return `Invalid library path.`
                        }

                        try {
                            const content = await fs.readFile(filePath, "utf-8")
                            return content
                        } catch (error) {
                            if (
                                (error as NodeJS.ErrnoException).code ===
                                "ENOENT"
                            ) {
                                return `Library "${library}" not found. Available: aws4, azure2, gcp2, alibaba_cloud, cisco19, kubernetes, network, bpmn, flowchart, basic, arrows2, vvd, salesforce, citrix, sap, mscae, atlassian, fluidpower, electrical, pid, cabinets, floorplan, webicons, infographic, sitemap, android, material_design, lean_mapping, openstack, rack`
                            }
                            console.error(
                                `[get_shape_library] Error loading "${library}":`,
                                error,
                            )
                            return `Error loading library "${library}". Please try again.`
                        }
                    },
                },
                search_assets: {
                    description: `Search approved external asset sites for reusable SVG/PNG icons, illustrations, or templates. Only use when the user explicitly asks for external materials or downloads.`,
                    inputSchema: z.object({
                        query: z
                            .string()
                            .min(1)
                            .max(500)
                            .describe(
                                "What kind of external asset to search for",
                            ),
                        assetType: z
                            .enum(["icon", "illustration", "template", "mixed"])
                            .describe("Preferred asset category"),
                        formats: z
                            .array(z.enum(["svg", "png"]))
                            .min(1)
                            .max(2)
                            .describe("Allowed downloadable formats"),
                        maxResults: z
                            .number()
                            .int()
                            .min(1)
                            .max(8)
                            .describe(
                                "Maximum number of search results to return",
                            ),
                    }),
                    execute: async ({
                        query,
                        assetType,
                        formats,
                        maxResults,
                    }) => {
                        try {
                            const results = await searchAssets({
                                query,
                                assetType,
                                formats,
                                maxResults,
                            })

                            return {
                                query,
                                assetType,
                                formats,
                                maxResults: Math.min(maxResults, 8),
                                maxAutoImports: getMaxImportsPerRequest(),
                                results,
                            }
                        } catch (error) {
                            return {
                                query,
                                assetType,
                                formats,
                                maxResults: Math.min(maxResults, 8),
                                error:
                                    error instanceof Error
                                        ? error.message
                                        : "Asset search failed.",
                            }
                        }
                    },
                },
                import_asset: {
                    description: `Download, validate, sanitize, and convert a reusable SVG/PNG asset into a draw.io-ready data URL. Only use this after search_assets returns an importable result.`,
                    inputSchema: z.object({
                        assetUrl: z
                            .string()
                            .url()
                            .describe(
                                "Direct SVG or PNG asset URL returned by search_assets",
                            ),
                        pageUrl: z
                            .string()
                            .url()
                            .describe(
                                "Original source page URL for license verification",
                            ),
                        label: z
                            .string()
                            .max(120)
                            .optional()
                            .describe("Short label to show under the image"),
                        placementHint: z
                            .string()
                            .max(200)
                            .optional()
                            .describe(
                                "Optional placement note for later diagram insertion",
                            ),
                    }),
                    execute: async ({
                        assetUrl,
                        pageUrl,
                        label,
                        placementHint,
                    }) => {
                        try {
                            return await importAsset({
                                assetUrl,
                                pageUrl,
                                label,
                                placementHint,
                            })
                        } catch (error) {
                            return {
                                assetUrl,
                                pageUrl,
                                label,
                                placementHint,
                                error:
                                    error instanceof Error
                                        ? error.message
                                        : "Asset import failed.",
                            }
                        }
                    },
                },
            },
            ...(process.env.TEMPERATURE !== undefined && {
                temperature: parseFloat(process.env.TEMPERATURE),
            }),
        })

        return {
            actualModelId: modelId,
            actualProvider: resolvedProvider,
            actualSelectedModelId: candidate?.id ?? selectedModelId,
            result,
        }
    }

    async function createBufferedAttemptResponse(params: {
        actualModelId: string
        actualProvider: string
        actualSelectedModelId?: string | null
        attemptedSelectedModelIds: string[]
        result: ReturnType<typeof streamText>
    }): Promise<Response> {
        const stream = params.result.toUIMessageStream(uiMessageStreamOptions)
        const chunks: any[] = []

        for await (const chunk of stream) {
            if (chunk.type === "error") {
                throw new Error(
                    chunk.errorText || "Model stream failed before completion.",
                )
            }
            chunks.push(chunk)
        }
        const normalizedChunks = normalizeRawXmlTextChunks(chunks)

        return createUIMessageStreamResponse({
            headers: createAttemptHeaders({
                actualModelId: params.actualModelId,
                actualProvider: params.actualProvider,
                actualSelectedModelId: params.actualSelectedModelId,
                attemptedSelectedModelIds: params.attemptedSelectedModelIds,
            }),
            stream: createUIMessageStream({
                execute: ({ writer }) => {
                    for (const chunk of normalizedChunks) {
                        writer.write(chunk)
                    }
                },
            }),
        })
    }

    if (serverModelCandidates.length > 0) {
        const attemptedSelectedModelIds: string[] = []

        for (const candidate of serverModelCandidates) {
            attemptedSelectedModelIds.push(candidate.id)

            try {
                const attempt = await createAttemptResult(candidate)
                const headers = createAttemptHeaders({
                    actualModelId: attempt.actualModelId,
                    actualProvider: attempt.actualProvider,
                    actualSelectedModelId: attempt.actualSelectedModelId,
                    attemptedSelectedModelIds,
                })

                if (attempt.response) {
                    return withResponseHeaders(attempt.response, headers)
                }

                if (!attempt.result) {
                    throw new Error(
                        "Model attempt finished without a response stream.",
                    )
                }

                return await createBufferedAttemptResponse({
                    actualModelId: attempt.actualModelId,
                    actualProvider: attempt.actualProvider,
                    actualSelectedModelId: attempt.actualSelectedModelId,
                    attemptedSelectedModelIds,
                    result: attempt.result,
                })
            } catch (error) {
                const canFailover =
                    attemptedSelectedModelIds.length <
                        serverModelCandidates.length &&
                    shouldFailoverToNextModel(error)

                console.warn(
                    `[Model Failover] Attempt failed for ${candidate.id}:`,
                    error,
                )

                if (!canFailover) {
                    throw error
                }
            }
        }
    }

    const attempt = await createAttemptResult()
    const headers = createAttemptHeaders({
        actualModelId: attempt.actualModelId,
        actualProvider: attempt.actualProvider,
        actualSelectedModelId: attempt.actualSelectedModelId,
        attemptedSelectedModelIds: selectedModelId?.startsWith("server:")
            ? [selectedModelId]
            : [],
    })

    if (attempt.response) {
        return withResponseHeaders(attempt.response, headers)
    }

    if (!attempt.result) {
        throw new Error("Chat route completed without a response stream.")
    }

    return attempt.result.toUIMessageStreamResponse({
        ...uiMessageStreamOptions,
        headers,
    })
}

// Helper to categorize errors and return appropriate response
function handleError(error: unknown): Response {
    console.error("Error in chat route:", error)

    const isDev = process.env.NODE_ENV === "development"

    // Check for specific AI SDK error types
    if (APICallError.isInstance(error)) {
        return Response.json(
            {
                error: error.message,
                ...(isDev && {
                    details: error.responseBody,
                    stack: error.stack,
                }),
            },
            { status: error.statusCode || 500 },
        )
    }

    if (LoadAPIKeyError.isInstance(error)) {
        return Response.json(
            {
                error: "Authentication failed. Please check your API key.",
                ...(isDev && {
                    stack: error.stack,
                }),
            },
            { status: 401 },
        )
    }

    // Fallback for other errors with safety filter
    const message =
        error instanceof Error ? error.message : "An unexpected error occurred"
    const status = (error as any)?.statusCode || (error as any)?.status || 500

    return Response.json(
        {
            error: sanitizeModelErrorMessage(error),
            ...(isDev && {
                details: message,
                stack: error instanceof Error ? error.stack : undefined,
            }),
        },
        { status },
    )
}

// Wrap handler with error handling
async function safeHandler(req: Request): Promise<Response> {
    try {
        return await handleChatRequest(req)
    } catch (error) {
        return handleError(error)
    }
}

// Wrap with Langfuse observe (if configured)
const observedHandler = wrapWithObserve(safeHandler)

export async function POST(req: Request) {
    return observedHandler(req)
}
