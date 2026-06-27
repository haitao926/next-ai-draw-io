"use client"

import {
    Download,
    History,
    Image as ImageIcon,
    Link,
    LoaderCircle,
    Send,
    Sparkles,
    Square,
} from "lucide-react"
import type React from "react"
import {
    forwardRef,
    useCallback,
    useEffect,
    useImperativeHandle,
    useRef,
    useState,
} from "react"
import { toast } from "sonner"
import { ButtonWithTooltip } from "@/components/button-with-tooltip"
import { ErrorToast } from "@/components/error-toast"
import { HistoryDialog } from "@/components/history-dialog"
import { ModelSelector } from "@/components/model-selector"
import { SaveDialog } from "@/components/save-dialog"

import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { UrlInputDialog } from "@/components/url-input-dialog"
import { useDiagram } from "@/contexts/diagram-context"
import { useDictionary } from "@/hooks/use-dictionary"
import { formatMessage } from "@/lib/i18n/utils"
import { isPdfFile, isTextFile } from "@/lib/pdf-utils"
import type { SessionMetadata } from "@/lib/session-storage"
import { STORAGE_KEYS } from "@/lib/storage"
import type { FlattenedModel } from "@/lib/types/model-config"
import { extractUrlContent, type UrlData } from "@/lib/url-utils"
import { cn, isRealDiagram } from "@/lib/utils"
import { FilePreviewList } from "./file-preview-list"

const MAX_IMAGE_SIZE = 2 * 1024 * 1024 // 2MB
const MAX_FILES = 5

function isValidFileType(file: File): boolean {
    return file.type.startsWith("image/") || isPdfFile(file) || isTextFile(file)
}

function formatFileSize(bytes: number): string {
    const mb = bytes / 1024 / 1024
    if (mb < 0.01) return `${(bytes / 1024).toFixed(0)}KB`
    return `${mb.toFixed(2)}MB`
}

function showErrorToast(message: React.ReactNode) {
    toast.custom(
        (t) => (
            <ErrorToast message={message} onDismiss={() => toast.dismiss(t)} />
        ),
        { duration: 5000 },
    )
}

interface ValidationResult {
    validFiles: File[]
    errors: string[]
}

function validateFiles(
    newFiles: File[],
    existingCount: number,
    dict: any,
): ValidationResult {
    const errors: string[] = []
    const validFiles: File[] = []

    const availableSlots = MAX_FILES - existingCount

    if (availableSlots <= 0) {
        errors.push(formatMessage(dict.errors.maxFiles, { max: MAX_FILES }))
        return { validFiles, errors }
    }

    for (const file of newFiles) {
        if (validFiles.length >= availableSlots) {
            errors.push(
                formatMessage(dict.errors.onlyMoreAllowed, {
                    slots: availableSlots,
                }),
            )
            break
        }
        if (!isValidFileType(file)) {
            errors.push(
                formatMessage(dict.errors.unsupportedType, { name: file.name }),
            )
            continue
        }
        // Only check size for images (PDFs/text files are extracted client-side, so file size doesn't matter)
        const isExtractedFile = isPdfFile(file) || isTextFile(file)
        if (!isExtractedFile && file.size > MAX_IMAGE_SIZE) {
            const maxSizeMB = MAX_IMAGE_SIZE / 1024 / 1024
            errors.push(
                formatMessage(dict.errors.fileExceeds, {
                    name: file.name,
                    size: formatFileSize(file.size),
                    max: maxSizeMB,
                }),
            )
        } else {
            validFiles.push(file)
        }
    }

    return { validFiles, errors }
}

function showValidationErrors(errors: string[], dict: any) {
    if (errors.length === 0) return

    if (errors.length === 1) {
        showErrorToast(
            <span className="text-muted-foreground">{errors[0]}</span>,
        )
    } else {
        showErrorToast(
            <div className="flex flex-col gap-1">
                <span className="font-medium">
                    {formatMessage(dict.errors.filesRejected, {
                        count: errors.length,
                    })}
                </span>
                <ul className="text-muted-foreground text-xs list-disc list-inside">
                    {errors.slice(0, 3).map((err) => (
                        <li key={err}>{err}</li>
                    ))}
                    {errors.length > 3 && (
                        <li>
                            {formatMessage(dict.errors.andMore, {
                                count: errors.length - 3,
                            })}
                        </li>
                    )}
                </ul>
            </div>,
        )
    }
}

export interface ChatInputRef {
    focus: () => void
}

export type WorkflowMode = "generate" | "convert" | "edit"
export type GenerateOutputMode = "image" | "diagram"

interface ChatInputProps {
    input: string
    status: "submitted" | "streaming" | "ready" | "error"
    onSubmit: (e: React.FormEvent<HTMLFormElement>) => void
    onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void
    onStop?: () => void
    files?: File[]
    onFileChange?: (files: File[]) => void
    pdfData?: Map<
        File,
        { text: string; charCount: number; isExtracting: boolean }
    >
    urlData?: Map<string, UrlData>
    onUrlChange?: (data: Map<string, UrlData>) => void

    sessionId?: string
    error?: Error | null
    // Model selector props
    models?: FlattenedModel[]
    selectedModelId?: string
    onModelSelect?: (modelId: string | undefined) => void
    onConfigureModels?: () => void
    showUnvalidatedModels?: boolean
    // Focus control props
    shouldFocus?: boolean
    onFocused?: () => void
    isReconstructing?: boolean
    isGeneratingImage?: boolean
    workflowMode?: WorkflowMode
    onWorkflowModeChange?: (mode: WorkflowMode) => void
    generateOutputMode?: GenerateOutputMode
    onGenerateOutputModeChange?: (mode: GenerateOutputMode) => void
    hasDiagram?: boolean
    onPresetSelect?: (text: string, mode?: WorkflowMode) => void
    needsPolish?: boolean
    isAutoPolishing?: boolean
    onAutoPolish?: () => void
    layout?: "compact" | "workspace"
    sessions?: SessionMetadata[]
    onSelectSession?: (sessionId: string) => void
    onDeleteSession?: (sessionId: string) => void | Promise<void>
    workspaceConversation?: React.ReactNode
}

export const ChatInput = forwardRef<ChatInputRef, ChatInputProps>(
    function ChatInput(
        {
            input,
            status,
            onSubmit,
            onChange,
            onStop,
            files = [],
            onFileChange = () => {},
            pdfData = new Map(),
            urlData,
            onUrlChange,
            sessionId,
            error = null,
            models = [],
            selectedModelId,
            onModelSelect = () => {},
            onConfigureModels,
            showUnvalidatedModels = false,
            shouldFocus = false,
            onFocused,
            isReconstructing = false,
            isGeneratingImage = false,
            workflowMode = "generate",
            onWorkflowModeChange = () => {},
            generateOutputMode = "image",
            onGenerateOutputModeChange = () => {},
            hasDiagram = false,
            onPresetSelect = () => {},
            needsPolish = false,
            isAutoPolishing = false,
            onAutoPolish = () => {},
            layout = "compact",
            workspaceConversation,
        },
        ref,
    ) {
        const dict = useDictionary()
        const {
            chartXML,
            diagramHistory,
            saveDiagramToFile,
            showSaveDialog,
            setShowSaveDialog,
        } = useDiagram()

        const textareaRef = useRef<HTMLTextAreaElement>(null)
        const fileInputRef = useRef<HTMLInputElement>(null)
        const [isDragging, setIsDragging] = useState(false)

        // Expose focus method via ref
        useImperativeHandle(ref, () => ({
            focus: () => {
                textareaRef.current?.focus()
            },
        }))

        // Focus the textarea when shouldFocus becomes true
        // Use setTimeout to ensure focus happens after drawio iframe settles
        useEffect(() => {
            if (shouldFocus) {
                const timer = setTimeout(() => {
                    textareaRef.current?.focus()
                    onFocused?.()
                }, 150)
                return () => clearTimeout(timer)
            }
        }, [shouldFocus, onFocused])

        const [showHistory, setShowHistory] = useState(false)
        const [showUrlDialog, setShowUrlDialog] = useState(false)
        const [isExtractingUrl, setIsExtractingUrl] = useState(false)
        const [sendShortcut, setSendShortcut] = useState("ctrl-enter")
        // Allow retry when there's an error (even if status is still "streaming" or "submitted")
        const isDisabled =
            ((status === "streaming" || status === "submitted") && !error) ||
            isGeneratingImage ||
            isReconstructing
        const imageFileCount = files.filter((file) =>
            file.type.startsWith("image/"),
        ).length
        const docFileCount = files.filter(
            (file) => !file.type.startsWith("image/"),
        ).length
        const urlCount = urlData?.size || 0

        const modeMeta: Record<
            WorkflowMode,
            {
                title: string
                description: string
                action: string
                placeholder: string
            }
        > = {
            generate: {
                title: dict.chat.generateMode,
                description:
                    generateOutputMode === "image"
                        ? dict.chat.generateImageModeHint
                        : dict.chat.generateDiagramModeHint,
                action:
                    generateOutputMode === "image"
                        ? isGeneratingImage
                            ? dict.chat.generateImageActionRunning
                            : isReconstructing
                              ? dict.chat.generateImageConnectingAction
                              : dict.chat.generateImageAction
                        : dict.chat.generateDiagramAction,
                placeholder:
                    generateOutputMode === "image"
                        ? dict.chat.generateImagePlaceholder
                        : dict.chat.generateDiagramPlaceholder,
            },
            convert: {
                title: dict.chat.convertMode,
                description: dict.chat.convertModeHint,
                action: isReconstructing
                    ? dict.chat.convertActionRunning
                    : dict.chat.convertAction,
                placeholder: dict.chat.convertPlaceholder,
            },
            edit: {
                title: dict.chat.editMode,
                description: dict.chat.editModeHint,
                action: dict.chat.editAction,
                placeholder: dict.chat.editPlaceholder,
            },
        }

        const canSubmit =
            workflowMode === "convert"
                ? imageFileCount > 0 && !isReconstructing
                : Boolean(input.trim())

        const showPolishAction = hasDiagram && needsPolish
        const showReferenceShortcuts =
            workflowMode === "generate" && !hasDiagram
        const referenceQuickActions =
            generateOutputMode === "image"
                ? [
                      {
                          label: dict.chat.generatePresetPoster,
                          text: "生成一张简洁高级的科技产品海报，主体明确，留白充足，偏真实质感。",
                      },
                      {
                          label: dict.chat.generatePresetIllustration,
                          text: "生成一张扁平但精致的产品功能插画，包含多人协作与数据流动场景。",
                      },
                      {
                          label: dict.chat.generatePresetConceptArt,
                          text: "生成一张未来感界面概念图，强调光感、层次和空间透视。",
                      },
                  ]
                : [
                      {
                          label: dict.chat.generatePresetArchitecture,
                          text: "生成一个包含用户、API 网关、服务层、数据库、缓存和监控告警的系统架构图。",
                      },
                      {
                          label: dict.chat.generatePresetFlowchart,
                          text: "生成一个从需求提交、评审、开发、测试到上线的产品流程图。",
                      },
                      {
                          label: dict.chat.generatePresetDashboard,
                          text: "生成一个包含指标卡、趋势图、告警区和数据表的运营看板草图。",
                      },
                  ]
        const showWorkspaceLayout = layout === "workspace"
        const primaryActionLabel = showPolishAction
            ? dict.chat.polishAction
            : modeMeta[workflowMode].action
        const primaryActionDisabled = showPolishAction
            ? isDisabled || isAutoPolishing
            : isDisabled || !canSubmit
        const primaryActionIcon =
            workflowMode === "generate" ? (
                <Sparkles className="h-4 w-4 mr-1.5" />
            ) : workflowMode === "convert" ? (
                <ImageIcon className="h-4 w-4 mr-1.5" />
            ) : (
                <Send className="h-4 w-4 mr-1.5" />
            )

        const modeBadges: WorkflowMode[] = ["generate", "convert", "edit"]
        const nextStep =
            workflowMode === "generate"
                ? generateOutputMode === "image"
                    ? dict.chat.generateImageNextStep
                    : dict.chat.generateDiagramNextStep
                : workflowMode === "convert"
                  ? imageFileCount > 0
                      ? dict.chat.convertNextStepReady
                      : dict.chat.convertNextStepUpload
                  : hasDiagram
                    ? dict.chat.editNextStepReady
                    : dict.chat.editNextStepMissing
        const workflowSteps = [
            {
                key: "upload",
                label: dict.chat.stepUpload,
                status:
                    imageFileCount > 0 || docFileCount + urlCount > 0
                        ? "done"
                        : workflowMode === "generate"
                          ? "active"
                          : "idle",
            },
            {
                key: "convert",
                label: dict.chat.stepConvert,
                status: isReconstructing
                    ? "active"
                    : workflowMode === "convert"
                      ? imageFileCount > 0
                          ? "ready"
                          : "idle"
                      : hasDiagram
                        ? "done"
                        : "idle",
            },
            {
                key: "edit",
                label: dict.chat.stepEdit,
                status:
                    workflowMode === "edit"
                        ? "active"
                        : hasDiagram
                          ? "ready"
                          : "idle",
            },
            {
                key: "export",
                label: dict.chat.stepExport,
                status: hasDiagram ? "ready" : "idle",
            },
        ] as const

        const adjustTextareaHeight = useCallback(() => {
            const textarea = textareaRef.current
            if (textarea) {
                textarea.style.height = "auto"
                textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`
            }
        }, [])
        // Handle programmatic input changes (e.g., setInput("") after form submission)
        useEffect(() => {
            adjustTextareaHeight()
        }, [input, adjustTextareaHeight])

        // Load send shortcut preference from localStorage and listen for changes
        useEffect(() => {
            const stored = localStorage.getItem(STORAGE_KEYS.sendShortcut)
            if (stored) setSendShortcut(stored)

            const handleChange = (e: CustomEvent<string>) =>
                setSendShortcut(e.detail)
            window.addEventListener(
                "sendShortcutChange",
                handleChange as EventListener,
            )
            return () =>
                window.removeEventListener(
                    "sendShortcutChange",
                    handleChange as EventListener,
                )
        }, [])

        const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
            onChange(e)
            adjustTextareaHeight()
        }

        const handleKeyDown = (e: React.KeyboardEvent) => {
            const shouldSend =
                sendShortcut === "enter"
                    ? e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.ctrlKey &&
                      !e.metaKey
                    : (e.metaKey || e.ctrlKey) && e.key === "Enter"

            if (shouldSend) {
                e.preventDefault()
                const form = e.currentTarget.closest("form")
                if (form && canSubmit && !isDisabled) {
                    form.requestSubmit()
                }
            }
        }

        const handlePaste = async (e: React.ClipboardEvent) => {
            if (isDisabled) return

            const items = e.clipboardData.items
            const imageItems = Array.from(items).filter((item) =>
                item.type.startsWith("image/"),
            )

            if (imageItems.length > 0) {
                const imageFiles = (
                    await Promise.all(
                        imageItems.map(async (item, index) => {
                            const file = item.getAsFile()
                            if (!file) return null
                            return new File(
                                [file],
                                `pasted-image-${Date.now()}-${index}.${file.type.split("/")[1]}`,
                                { type: file.type },
                            )
                        }),
                    )
                ).filter((f): f is File => f !== null)

                const { validFiles, errors } = validateFiles(
                    imageFiles,
                    files.length,
                    dict,
                )
                showValidationErrors(errors, dict)
                if (validFiles.length > 0) {
                    onFileChange([...files, ...validFiles])
                }
            }
        }

        const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
            const newFiles = Array.from(e.target.files || [])
            const { validFiles, errors } = validateFiles(
                newFiles,
                files.length,
                dict,
            )
            showValidationErrors(errors, dict)
            if (validFiles.length > 0) {
                onFileChange([...files, ...validFiles])
            }

            if (fileInputRef.current) {
                fileInputRef.current.value = ""
            }
        }

        const handleRemoveFile = (fileToRemove: File) => {
            onFileChange(files.filter((file) => file !== fileToRemove))
            if (fileInputRef.current) {
                fileInputRef.current.value = ""
            }
        }

        const triggerFileInput = () => {
            fileInputRef.current?.click()
        }

        const handleDragOver = (e: React.DragEvent<HTMLFormElement>) => {
            e.preventDefault()
            e.stopPropagation()
            setIsDragging(true)
        }

        const handleDragLeave = (e: React.DragEvent<HTMLFormElement>) => {
            e.preventDefault()
            e.stopPropagation()
            setIsDragging(false)
        }

        const handleDrop = (e: React.DragEvent<HTMLFormElement>) => {
            e.preventDefault()
            e.stopPropagation()
            setIsDragging(false)

            if (isDisabled) return

            const droppedFiles = e.dataTransfer.files
            const supportedFiles = Array.from(droppedFiles).filter((file) =>
                isValidFileType(file),
            )

            const { validFiles, errors } = validateFiles(
                supportedFiles,
                files.length,
                dict,
            )
            showValidationErrors(errors, dict)
            if (validFiles.length > 0) {
                onFileChange([...files, ...validFiles])
            }
        }

        const handleUrlExtract = async (url: string) => {
            if (!onUrlChange) return

            setIsExtractingUrl(true)

            try {
                const existing = urlData
                    ? new Map(urlData)
                    : new Map<string, UrlData>()
                existing.set(url, {
                    url,
                    title: url,
                    content: "",
                    charCount: 0,
                    isExtracting: true,
                })
                onUrlChange(existing)

                const data = await extractUrlContent(url)

                const newUrlData = new Map(existing)
                newUrlData.set(url, data)
                onUrlChange(newUrlData)

                setShowUrlDialog(false)
            } catch (error) {
                // Remove the URL from the data map on error
                const newUrlData = urlData
                    ? new Map(urlData)
                    : new Map<string, UrlData>()
                newUrlData.delete(url)
                onUrlChange(newUrlData)
                showErrorToast(
                    <span className="text-muted-foreground">
                        {error instanceof Error
                            ? error.message
                            : "Failed to extract URL content"}
                    </span>,
                )
            } finally {
                setIsExtractingUrl(false)
            }
        }

        const showSourceStrip =
            files.length > 0 || Boolean(urlData && urlData.size > 0)
        const workspaceFlow = [
            {
                mode: "generate" as const,
                label: dict.chat.generateMode,
                hint: "",
                available: true,
            },
            {
                mode: "convert" as const,
                label: dict.chat.convertMode,
                hint: "",
                available: true,
            },
            {
                mode: "edit" as const,
                label: dict.chat.editMode,
                hint: "",
                available: hasDiagram,
            },
        ]
        const workspaceFlowState = (mode: WorkflowMode) => {
            if (workflowMode === mode) return "active"
            if (mode === "generate") {
                return hasDiagram || imageFileCount > 0 ? "done" : "idle"
            }
            if (mode === "convert") {
                if (hasDiagram && workflowMode === "edit") return "done"
                return imageFileCount > 0 ? "ready" : "idle"
            }
            return hasDiagram ? "ready" : "idle"
        }
        const workspaceStageMeta: Record<
            WorkflowMode,
            {
                surfaceTone: string
                ringTone: string
            }
        > = {
            generate: {
                surfaceTone: "from-amber-100/70 via-background to-background",
                ringTone: "from-amber-300/45 via-transparent to-transparent",
            },
            convert: {
                surfaceTone: "from-sky-100/70 via-background to-background",
                ringTone: "from-sky-300/45 via-transparent to-transparent",
            },
            edit: {
                surfaceTone: "from-emerald-100/70 via-background to-background",
                ringTone: "from-emerald-300/45 via-transparent to-transparent",
            },
        }
        const activeStageMeta = workspaceStageMeta[workflowMode]
        const showHistoryAction = diagramHistory.length > 0
        const showSaveAction = isRealDiagram(chartXML)
        const showEditReadyState =
            workflowMode === "edit" && hasDiagram && !workspaceConversation
        const showConvertEmptyState =
            workflowMode === "convert" && imageFileCount === 0 && !hasDiagram
        const showEditEmptyState = workflowMode === "edit" && !hasDiagram
        const unifiedTextareaDisabled = isDisabled || showEditEmptyState
        const unifiedTextareaHeightClass =
            workflowMode === "edit" && hasDiagram
                ? "min-h-[84px] max-h-[132px]"
                : workflowMode === "convert"
                  ? "min-h-[96px] max-h-[144px]"
                  : "min-h-[152px] max-h-[220px]"
        const showUnifiedSaveAction = workflowMode === "edit" && showSaveAction
        const workspaceEmptyHeadline =
            workflowMode === "generate"
                ? hasDiagram
                    ? generateOutputMode === "image"
                        ? "继续生成图片"
                        : "继续生成图表"
                    : generateOutputMode === "image"
                      ? "生成第一张图"
                      : "生成第一版图表"
                : workflowMode === "edit"
                  ? hasDiagram
                      ? "继续调整当前画布"
                      : "还没有可调整的画布"
                  : imageFileCount > 0
                    ? "开始转图"
                    : "上传原图"
        const showConvertReadyState =
            workflowMode === "convert" &&
            imageFileCount > 0 &&
            !workspaceConversation &&
            !isReconstructing
        const showConvertWithDiagramState =
            workflowMode === "convert" &&
            hasDiagram &&
            !workspaceConversation &&
            !isReconstructing
        const workspaceGuideIconSurface =
            workflowMode === "generate"
                ? "border-amber-200 bg-background text-amber-700"
                : workflowMode === "convert"
                  ? "border-sky-200 bg-background text-sky-700"
                  : "border-emerald-200 bg-background text-emerald-700"
        const workspaceGuideTitle = showConvertReadyState
            ? "开始转图"
            : showEditReadyState
              ? "调整当前画布"
              : showConvertWithDiagramState
                ? "把新图片接入当前画布"
                : workspaceEmptyHeadline
        const showGenerateOutputSwitcher = workflowMode === "generate"
        const workspaceComposer = (
            <div className="relative h-full overflow-hidden rounded-[32px] border border-slate-200/70 bg-[linear-gradient(180deg,rgba(255,252,244,0.96),rgba(255,255,255,0.94))] shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
                <div
                    className={cn(
                        "pointer-events-none absolute inset-0 bg-gradient-to-br opacity-85",
                        activeStageMeta.surfaceTone,
                    )}
                />
                <div
                    className={cn(
                        "pointer-events-none absolute inset-x-0 top-0 h-28 bg-gradient-to-b",
                        activeStageMeta.ringTone,
                    )}
                />
                <div className="pointer-events-none absolute inset-x-0 top-0 h-px bg-white/80" />

                <div className="relative flex h-full min-h-0 flex-col">
                    <div className="border-b border-slate-200/55 px-5 py-5">
                        <div className="flex flex-col gap-4">
                            <div className="grid grid-cols-1 gap-2 rounded-[24px] border border-white/80 bg-white/58 p-1.5 shadow-[inset_0_1px_0_rgba(255,255,255,0.8)] min-[520px]:grid-cols-3">
                                {workspaceFlow.map((item, index) => {
                                    const phaseState = workspaceFlowState(
                                        item.mode,
                                    )
                                    const isActive = phaseState === "active"
                                    const isDone = phaseState === "done"
                                    const isReady = phaseState === "ready"

                                    return (
                                        <button
                                            key={item.mode}
                                            type="button"
                                            onClick={() =>
                                                item.available &&
                                                onWorkflowModeChange(item.mode)
                                            }
                                            disabled={!item.available}
                                            className={cn(
                                                "relative rounded-[18px] border px-3 py-3 text-left transition-all",
                                                "disabled:cursor-not-allowed disabled:opacity-45",
                                                isActive
                                                    ? "border-slate-900 bg-slate-900 text-white shadow-[0_10px_24px_rgba(15,23,42,0.16)]"
                                                    : isDone
                                                      ? "border-slate-200 bg-white/92 text-slate-900 shadow-sm"
                                                      : isReady
                                                        ? "border-sky-200/80 bg-sky-50/90 text-slate-900 shadow-sm"
                                                        : "border-transparent bg-white/55 text-slate-900 shadow-sm hover:border-slate-200 hover:bg-white/88",
                                            )}
                                        >
                                            <div className="flex items-center gap-2.5">
                                                <span
                                                    className={cn(
                                                        "flex h-6 w-6 shrink-0 items-center justify-center rounded-full border text-[10px] font-semibold",
                                                        isActive
                                                            ? "border-white/20 bg-white/12 text-white"
                                                            : isDone
                                                              ? "border-slate-200 bg-slate-900 text-white"
                                                              : isReady
                                                                ? "border-sky-300/70 bg-sky-100 text-sky-700"
                                                                : "border-slate-200 bg-white text-slate-500",
                                                    )}
                                                >
                                                    {index + 1}
                                                </span>
                                                <div className="min-w-0">
                                                    <p className="text-[13px] font-semibold">
                                                        {item.label}
                                                    </p>
                                                </div>
                                            </div>
                                        </button>
                                    )
                                })}
                            </div>

                            {showGenerateOutputSwitcher && (
                                <div className="flex justify-end">
                                    <div className="inline-flex rounded-full border border-white/90 bg-white/78 p-1 shadow-sm">
                                        <button
                                            type="button"
                                            onClick={() =>
                                                onGenerateOutputModeChange(
                                                    "image",
                                                )
                                            }
                                            className={cn(
                                                "rounded-full px-3 py-1.5 text-[12px] font-medium transition-all",
                                                generateOutputMode === "image"
                                                    ? "bg-slate-900 text-white"
                                                    : "text-slate-600 hover:text-slate-900",
                                            )}
                                        >
                                            {dict.chat.generateOutputImage}
                                        </button>
                                        <button
                                            type="button"
                                            onClick={() =>
                                                onGenerateOutputModeChange(
                                                    "diagram",
                                                )
                                            }
                                            className={cn(
                                                "rounded-full px-3 py-1.5 text-[12px] font-medium transition-all",
                                                generateOutputMode === "diagram"
                                                    ? "bg-slate-900 text-white"
                                                    : "text-slate-600 hover:text-slate-900",
                                            )}
                                        >
                                            {dict.chat.generateOutputDiagram}
                                        </button>
                                    </div>
                                </div>
                            )}
                        </div>
                    </div>

                    <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden">
                        <div className="pointer-events-none absolute inset-0 bg-[linear-gradient(to_right,rgba(15,23,42,0.04)_1px,transparent_1px),linear-gradient(to_bottom,rgba(15,23,42,0.04)_1px,transparent_1px)] bg-[size:24px_24px] opacity-25" />
                        <div className="pointer-events-none absolute inset-x-0 top-0 h-16 bg-gradient-to-b from-white/50 to-transparent" />
                        <div className="relative flex min-h-0 flex-1 flex-col overflow-hidden px-4 pb-4 pt-4">
                            <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
                                {showSourceStrip && (
                                    <div className="border-b border-slate-200/60 px-4 py-3">
                                        <div className="mb-2 flex items-center justify-between gap-2">
                                            <p className="text-[11px] font-medium tracking-[0.14em] text-slate-500">
                                                {workflowMode === "convert"
                                                    ? dict.chat.workspaceImages
                                                    : dict.chat
                                                          .workspaceSources}
                                            </p>
                                        </div>
                                        <FilePreviewList
                                            files={files}
                                            onRemoveFile={handleRemoveFile}
                                            pdfData={pdfData}
                                            urlData={urlData}
                                            onRemoveUrl={
                                                onUrlChange
                                                    ? (url) => {
                                                          const next = new Map(
                                                              urlData,
                                                          )
                                                          next.delete(url)
                                                          onUrlChange(next)
                                                      }
                                                    : undefined
                                            }
                                        />
                                    </div>
                                )}

                                <div className="min-h-0 flex-1 overflow-y-auto">
                                    {isGeneratingImage ? (
                                        <div className="mx-auto mt-4 flex w-full max-w-[720px] items-start gap-3 rounded-[24px] border border-amber-200/70 bg-white/88 px-4 py-4 shadow-sm backdrop-blur">
                                            <div className="mt-0.5 rounded-full border border-amber-200/70 bg-amber-100/80 p-2 text-amber-700">
                                                <LoaderCircle className="h-4 w-4 animate-spin" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium text-foreground">
                                                    正在调用 gpt-image-2 生图
                                                </p>
                                            </div>
                                        </div>
                                    ) : isReconstructing ? (
                                        <div className="mx-auto mt-4 flex w-full max-w-[720px] items-start gap-3 rounded-[24px] border border-sky-200/70 bg-white/88 px-4 py-4 shadow-sm backdrop-blur">
                                            <div className="mt-0.5 rounded-full border border-sky-200/70 bg-sky-100/80 p-2 text-sky-700">
                                                <LoaderCircle className="h-4 w-4 animate-spin" />
                                            </div>
                                            <div className="min-w-0">
                                                <p className="text-sm font-medium text-foreground">
                                                    正在调用 Edit Banana 转图
                                                </p>
                                            </div>
                                        </div>
                                    ) : workspaceConversation ? (
                                        <div className="h-full min-h-0 px-2 py-2">
                                            {workspaceConversation}
                                        </div>
                                    ) : (
                                        <div className="flex h-full flex-col px-4 py-5">
                                            {(showConvertEmptyState ||
                                                showEditEmptyState) && (
                                                <div className="mx-auto flex w-full max-w-[720px] flex-col gap-4">
                                                    <div className="flex items-start gap-3">
                                                        <div
                                                            className={cn(
                                                                "rounded-[16px] border p-2.5 shadow-sm",
                                                                workspaceGuideIconSurface,
                                                            )}
                                                        >
                                                            {workflowMode ===
                                                            "convert" ? (
                                                                <ImageIcon className="h-4 w-4" />
                                                            ) : (
                                                                <Send className="h-4 w-4" />
                                                            )}
                                                        </div>
                                                        <div className="min-w-0 flex-1">
                                                            <p className="text-[17px] font-semibold text-slate-950">
                                                                {
                                                                    workspaceGuideTitle
                                                                }
                                                            </p>
                                                        </div>
                                                    </div>
                                                    <div className="flex flex-wrap gap-2">
                                                        {showConvertEmptyState && (
                                                            <Button
                                                                type="button"
                                                                size="sm"
                                                                onClick={
                                                                    triggerFileInput
                                                                }
                                                                disabled={
                                                                    isDisabled
                                                                }
                                                                className="rounded-full"
                                                            >
                                                                <ImageIcon className="mr-1.5 h-4 w-4" />
                                                                上传原图
                                                            </Button>
                                                        )}
                                                        {showEditEmptyState && (
                                                            <>
                                                                <Button
                                                                    type="button"
                                                                    size="sm"
                                                                    className="rounded-full"
                                                                    onClick={() =>
                                                                        onWorkflowModeChange(
                                                                            "generate",
                                                                        )
                                                                    }
                                                                >
                                                                    <Sparkles className="mr-1.5 h-4 w-4" />
                                                                    先生图
                                                                </Button>
                                                                <Button
                                                                    type="button"
                                                                    variant="outline"
                                                                    size="sm"
                                                                    className="rounded-full"
                                                                    onClick={() =>
                                                                        onWorkflowModeChange(
                                                                            "convert",
                                                                        )
                                                                    }
                                                                >
                                                                    <ImageIcon className="mr-1.5 h-4 w-4" />
                                                                    先转图
                                                                </Button>
                                                            </>
                                                        )}
                                                    </div>
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>

                                <div className="border-t border-slate-200/60 bg-[linear-gradient(180deg,rgba(255,255,255,0.62),rgba(248,250,252,0.96))] px-4 pb-4 pt-3">
                                    <div className="rounded-[28px] border border-white/85 bg-white/90 shadow-[0_16px_40px_rgba(15,23,42,0.06)]">
                                        <Textarea
                                            ref={textareaRef}
                                            value={input}
                                            onChange={handleChange}
                                            onKeyDown={handleKeyDown}
                                            onPaste={handlePaste}
                                            placeholder={
                                                modeMeta[workflowMode]
                                                    .placeholder
                                            }
                                            disabled={unifiedTextareaDisabled}
                                            aria-label="Chat input"
                                            className={cn(
                                                "w-full resize-none border-0 bg-transparent px-4 pb-3 pt-4 text-[14px] leading-6 text-slate-900 shadow-none focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-slate-400 scrollbar-thin",
                                                unifiedTextareaHeightClass,
                                                unifiedTextareaDisabled &&
                                                    "opacity-60",
                                            )}
                                        />

                                        <div className="flex flex-col gap-3 border-t border-slate-200/60 px-3 py-3 xl:flex-row xl:items-center xl:justify-between">
                                            <div className="flex min-w-0 flex-wrap items-center gap-2">
                                                <ButtonWithTooltip
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={triggerFileInput}
                                                    disabled={isDisabled}
                                                    tooltipContent={
                                                        dict.chat.uploadFile
                                                    }
                                                    className="h-8 w-8 rounded-full p-0 text-muted-foreground hover:text-foreground"
                                                >
                                                    <ImageIcon className="h-4 w-4" />
                                                </ButtonWithTooltip>
                                                {onUrlChange &&
                                                    workflowMode ===
                                                        "generate" && (
                                                        <ButtonWithTooltip
                                                            type="button"
                                                            variant="ghost"
                                                            size="sm"
                                                            onClick={() =>
                                                                setShowUrlDialog(
                                                                    true,
                                                                )
                                                            }
                                                            disabled={
                                                                isDisabled
                                                            }
                                                            tooltipContent={
                                                                dict.chat
                                                                    .ExtractURL
                                                            }
                                                            className="h-8 w-8 rounded-full p-0 text-muted-foreground hover:text-foreground"
                                                        >
                                                            <Link className="h-4 w-4" />
                                                        </ButtonWithTooltip>
                                                    )}
                                                <ButtonWithTooltip
                                                    type="button"
                                                    variant="ghost"
                                                    size="sm"
                                                    onClick={() =>
                                                        setShowHistory(true)
                                                    }
                                                    disabled={
                                                        isDisabled ||
                                                        !showHistoryAction
                                                    }
                                                    tooltipContent={
                                                        dict.chat.diagramHistory
                                                    }
                                                    className="h-8 w-8 rounded-full p-0 text-muted-foreground hover:text-foreground"
                                                >
                                                    <History className="h-4 w-4" />
                                                </ButtonWithTooltip>
                                                {showUnifiedSaveAction && (
                                                    <ButtonWithTooltip
                                                        type="button"
                                                        variant="ghost"
                                                        size="sm"
                                                        onClick={() =>
                                                            setShowSaveDialog(
                                                                true,
                                                            )
                                                        }
                                                        disabled={
                                                            isDisabled ||
                                                            !showSaveAction
                                                        }
                                                        tooltipContent={
                                                            dict.chat
                                                                .saveDiagram
                                                        }
                                                        className="h-8 w-8 rounded-full p-0 text-muted-foreground hover:text-foreground"
                                                    >
                                                        <Download className="h-4 w-4" />
                                                    </ButtonWithTooltip>
                                                )}

                                                <input
                                                    type="file"
                                                    ref={fileInputRef}
                                                    className="hidden"
                                                    onChange={handleFileChange}
                                                    accept="image/*,.pdf,application/pdf,text/*,.md,.markdown,.json,.csv,.xml,.yaml,.yml,.toml"
                                                    multiple
                                                    disabled={isDisabled}
                                                />
                                            </div>

                                            <div className="flex flex-wrap items-center gap-2">
                                                <ModelSelector
                                                    models={models}
                                                    selectedModelId={
                                                        selectedModelId
                                                    }
                                                    onSelect={onModelSelect}
                                                    onConfigure={
                                                        onConfigureModels
                                                    }
                                                    disabled={isDisabled}
                                                    showUnvalidatedModels={
                                                        showUnvalidatedModels
                                                    }
                                                />
                                                {(status === "streaming" ||
                                                    status === "submitted") &&
                                                onStop ? (
                                                    <Button
                                                        type="button"
                                                        onClick={onStop}
                                                        size="sm"
                                                        variant="destructive"
                                                        className="h-9 w-9 rounded-full p-0 shadow-sm"
                                                        aria-label={
                                                            dict.chat
                                                                .stopGeneration
                                                        }
                                                    >
                                                        <Square className="h-4 w-4" />
                                                    </Button>
                                                ) : (
                                                    <Button
                                                        type={
                                                            showPolishAction
                                                                ? "button"
                                                                : "submit"
                                                        }
                                                        onClick={
                                                            showPolishAction
                                                                ? onAutoPolish
                                                                : undefined
                                                        }
                                                        disabled={
                                                            primaryActionDisabled
                                                        }
                                                        size="sm"
                                                        className={cn(
                                                            "h-10 rounded-full px-5 font-medium shadow-sm",
                                                            workflowMode ===
                                                                "convert"
                                                                ? "min-w-[164px]"
                                                                : "min-w-[136px]",
                                                        )}
                                                        aria-label={
                                                            primaryActionLabel
                                                        }
                                                    >
                                                        {showPolishAction ? (
                                                            <Sparkles className="mr-1.5 h-4 w-4" />
                                                        ) : (
                                                            primaryActionIcon
                                                        )}
                                                        {showPolishAction &&
                                                        isAutoPolishing
                                                            ? dict.chat
                                                                  .polishActionRunning
                                                            : primaryActionLabel}
                                                    </Button>
                                                )}
                                            </div>
                                        </div>
                                    </div>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        )

        const workflowCard = (
            <div
                className={cn(
                    "rounded-2xl border border-border/60 bg-card/70 p-2 shadow-sm",
                    showWorkspaceLayout && "bg-card shadow-md",
                )}
            >
                <div className="mb-2 flex items-center justify-between gap-3 px-2 pt-1">
                    <div>
                        <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                            {dict.chat.workflowLabel}
                        </p>
                        <p className="text-sm font-medium text-foreground">
                            {modeMeta[workflowMode].title}
                        </p>
                    </div>
                    <div className="flex gap-1">
                        {modeBadges.map((mode) => {
                            const isActive = workflowMode === mode
                            const isModeDisabled =
                                mode === "edit" ? !hasDiagram : false

                            return (
                                <button
                                    key={mode}
                                    type="button"
                                    onClick={() => onWorkflowModeChange(mode)}
                                    disabled={isModeDisabled}
                                    className={cn(
                                        "rounded-full border px-3 py-1.5 text-xs font-medium transition-colors",
                                        "disabled:cursor-not-allowed disabled:opacity-45",
                                        isActive
                                            ? "border-foreground bg-foreground text-background"
                                            : "border-border bg-background text-muted-foreground hover:border-foreground/30 hover:text-foreground",
                                    )}
                                >
                                    {modeMeta[mode].title}
                                </button>
                            )
                        })}
                    </div>
                </div>
                <div className="rounded-2xl border border-border/60 bg-background/80 p-3">
                    <div
                        className={cn(
                            "flex items-center justify-between gap-3",
                            showWorkspaceLayout && "grid grid-cols-2 gap-2",
                        )}
                    >
                        {workflowSteps.map((step, index) => {
                            const isDone = step.status === "done"
                            const isActive = step.status === "active"
                            const isReady = step.status === "ready"

                            return (
                                <div
                                    key={step.key}
                                    className={cn(
                                        "flex min-w-0 flex-1 items-center gap-2",
                                        showWorkspaceLayout &&
                                            "rounded-xl border border-border/50 bg-background px-2 py-2",
                                    )}
                                >
                                    <div
                                        className={cn(
                                            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold",
                                            isDone
                                                ? "border-foreground bg-foreground text-background"
                                                : isActive
                                                  ? "border-primary bg-primary text-primary-foreground"
                                                  : isReady
                                                    ? "border-foreground/40 bg-accent text-foreground"
                                                    : "border-border bg-background text-muted-foreground",
                                        )}
                                    >
                                        {index + 1}
                                    </div>
                                    <div className="min-w-0">
                                        <p className="truncate text-xs font-medium text-foreground">
                                            {step.label}
                                        </p>
                                    </div>
                                </div>
                            )
                        })}
                    </div>
                    {showReferenceShortcuts && (
                        <div className="mt-3 flex flex-wrap gap-2">
                            {referenceQuickActions.map((action) => (
                                <button
                                    key={`${workflowMode}-${action.label}`}
                                    type="button"
                                    onClick={() =>
                                        onPresetSelect(
                                            action.text,
                                            workflowMode,
                                        )
                                    }
                                    className="rounded-full border border-border bg-background px-3 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-accent/50"
                                >
                                    {action.label}
                                </button>
                            ))}
                        </div>
                    )}
                </div>
            </div>
        )

        return (
            <form
                onSubmit={onSubmit}
                className={`h-full w-full transition-all duration-200 ${
                    isDragging
                        ? "ring-2 ring-primary ring-offset-2 rounded-2xl"
                        : ""
                }`}
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
            >
                {showWorkspaceLayout && (
                    <>
                        {workspaceComposer}
                        <HistoryDialog
                            showHistory={showHistory}
                            onToggleHistory={setShowHistory}
                        />
                        <SaveDialog
                            open={showSaveDialog}
                            onOpenChange={setShowSaveDialog}
                            onSave={(filename, format) =>
                                saveDiagramToFile(
                                    filename,
                                    format,
                                    sessionId,
                                    dict.save.savedSuccessfully,
                                )
                            }
                            defaultFilename={`diagram-${new Date()
                                .toISOString()
                                .slice(0, 10)}`}
                        />
                        {onUrlChange && (
                            <UrlInputDialog
                                open={showUrlDialog}
                                onOpenChange={setShowUrlDialog}
                                onSubmit={handleUrlExtract}
                                isExtracting={isExtractingUrl}
                            />
                        )}
                    </>
                )}
                {!showWorkspaceLayout && (
                    <>
                        {/* File & URL previews */}
                        {(files.length > 0 ||
                            (urlData && urlData.size > 0)) && (
                            <div className="mb-3">
                                <div className="mb-2 flex items-center justify-between px-1">
                                    <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">
                                        {workflowMode === "convert"
                                            ? dict.chat.workspaceImages
                                            : dict.chat.workspaceSources}
                                    </p>
                                    <p className="text-xs text-muted-foreground">
                                        {workflowMode === "convert"
                                            ? nextStep
                                            : modeMeta[workflowMode]
                                                  .description}
                                    </p>
                                </div>
                                <FilePreviewList
                                    files={files}
                                    onRemoveFile={handleRemoveFile}
                                    pdfData={pdfData}
                                    urlData={urlData}
                                    onRemoveUrl={
                                        onUrlChange
                                            ? (url) => {
                                                  const next = new Map(urlData)
                                                  next.delete(url)
                                                  onUrlChange(next)
                                              }
                                            : undefined
                                    }
                                />
                            </div>
                        )}
                        <div className="mb-3">{workflowCard}</div>
                        <div className="relative rounded-2xl border border-border bg-background shadow-sm transition-all duration-200 focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/20">
                            <Textarea
                                ref={textareaRef}
                                value={input}
                                onChange={handleChange}
                                onKeyDown={handleKeyDown}
                                onPaste={handlePaste}
                                placeholder={modeMeta[workflowMode].placeholder}
                                disabled={isDisabled}
                                aria-label="Chat input"
                                className="min-h-[60px] max-h-[200px] resize-none border-0 bg-transparent px-4 py-3 text-sm focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground/60 scrollbar-thin"
                            />

                            <div className="flex items-center justify-end gap-1 border-t border-border/50 px-3 py-2">
                                <div className="flex items-center gap-1 overflow-x-hidden">
                                    <ButtonWithTooltip
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setShowHistory(true)}
                                        disabled={
                                            isDisabled ||
                                            diagramHistory.length === 0
                                        }
                                        tooltipContent={
                                            dict.chat.diagramHistory
                                        }
                                        className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                    >
                                        <History className="h-4 w-4" />
                                    </ButtonWithTooltip>

                                    <ButtonWithTooltip
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setShowSaveDialog(true)}
                                        disabled={
                                            isDisabled ||
                                            !isRealDiagram(chartXML)
                                        }
                                        tooltipContent={dict.chat.saveDiagram}
                                        className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                    >
                                        <Download className="h-4 w-4" />
                                    </ButtonWithTooltip>

                                    <ButtonWithTooltip
                                        type="button"
                                        variant="ghost"
                                        size="sm"
                                        onClick={triggerFileInput}
                                        disabled={isDisabled}
                                        tooltipContent={dict.chat.uploadFile}
                                        className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                    >
                                        <ImageIcon className="h-4 w-4" />
                                    </ButtonWithTooltip>

                                    {onUrlChange && (
                                        <ButtonWithTooltip
                                            type="button"
                                            variant="ghost"
                                            size="sm"
                                            onClick={() =>
                                                setShowUrlDialog(true)
                                            }
                                            disabled={isDisabled}
                                            tooltipContent={
                                                dict.chat.ExtractURL
                                            }
                                            className="h-8 w-8 p-0 text-muted-foreground hover:text-foreground"
                                        >
                                            <Link className="h-4 w-4" />
                                        </ButtonWithTooltip>
                                    )}

                                    <input
                                        type="file"
                                        ref={fileInputRef}
                                        className="hidden"
                                        onChange={handleFileChange}
                                        accept="image/*,.pdf,application/pdf,text/*,.md,.markdown,.json,.csv,.xml,.yaml,.yml,.toml"
                                        multiple
                                        disabled={isDisabled}
                                    />
                                </div>
                                <ModelSelector
                                    models={models}
                                    selectedModelId={selectedModelId}
                                    onSelect={onModelSelect}
                                    onConfigure={onConfigureModels}
                                    disabled={isDisabled}
                                    showUnvalidatedModels={
                                        showUnvalidatedModels
                                    }
                                />
                                <div className="mx-1 h-5 w-px bg-border" />
                                {(status === "streaming" ||
                                    status === "submitted") &&
                                onStop ? (
                                    <Button
                                        type="button"
                                        onClick={onStop}
                                        size="sm"
                                        variant="destructive"
                                        className="h-8 w-8 rounded-xl p-0 shadow-sm"
                                        aria-label={dict.chat.stopGeneration}
                                    >
                                        <Square className="h-4 w-4" />
                                    </Button>
                                ) : (
                                    <Button
                                        type={
                                            showPolishAction
                                                ? "button"
                                                : "submit"
                                        }
                                        onClick={
                                            showPolishAction
                                                ? onAutoPolish
                                                : undefined
                                        }
                                        disabled={primaryActionDisabled}
                                        size="sm"
                                        className="h-8 min-w-[112px] rounded-xl px-4 font-medium shadow-sm"
                                        aria-label={primaryActionLabel}
                                    >
                                        {showPolishAction ? (
                                            <Sparkles className="mr-1.5 h-4 w-4" />
                                        ) : (
                                            primaryActionIcon
                                        )}
                                        {showPolishAction && isAutoPolishing
                                            ? dict.chat.polishActionRunning
                                            : primaryActionLabel}
                                    </Button>
                                )}
                            </div>
                        </div>
                        <HistoryDialog
                            showHistory={showHistory}
                            onToggleHistory={setShowHistory}
                        />
                        <SaveDialog
                            open={showSaveDialog}
                            onOpenChange={setShowSaveDialog}
                            onSave={(filename, format) =>
                                saveDiagramToFile(
                                    filename,
                                    format,
                                    sessionId,
                                    dict.save.savedSuccessfully,
                                )
                            }
                            defaultFilename={`diagram-${new Date()
                                .toISOString()
                                .slice(0, 10)}`}
                        />
                        {onUrlChange && (
                            <UrlInputDialog
                                open={showUrlDialog}
                                onOpenChange={setShowUrlDialog}
                                onSubmit={handleUrlExtract}
                                isExtracting={isExtractingUrl}
                            />
                        )}
                    </>
                )}
            </form>
        )
    },
)
