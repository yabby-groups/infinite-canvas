import type { NavigateFunction } from "react-router-dom";

import i18n from "@/i18n";
import { fetchPrompts } from "@/services/api/prompts";
import { getImageBlob, uploadImage } from "@/services/image-storage";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { requestAudioGeneration, requestAudioTranscription, storeGeneratedAudio } from "@/services/api/audio";
import { saveAs } from "file-saver";
import { imageAspectOptions, imageQualityOptions } from "@/components/image-settings-panel";
import { videoResolutionOptions, videoSecondOptions, videoSizeOptions } from "@/components/video-settings-panel";
import type { CanvasAgentSnapshot } from "@/lib/canvas/canvas-agent-ops";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAssetStore } from "@/stores/use-asset-store";
import { modelOptionLabel, modelOptionName, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore } from "@/stores/use-config-store";
import { useWorkbenchAgentStore } from "@/stores/use-workbench-agent-store";

// Execute site-level Agent tools in the browser, including canvas lists, workbench generation, prompt search, and asset operations.
// Their data lives locally in the browser through localforage and Zustand, so this module accesses the relevant stores directly.

export const SITE_TOOL_NAMES = [
    "canvas_list_projects",
    "generation_get_status",
    "workbench_image_get_config",
    "workbench_image_generate",
    "workbench_video_get_config",
    "workbench_video_generate",
    "canvas_merge_videos",
    "canvas_inspect_media",
    "canvas_render_media",
    "canvas_generate_tts",
    "canvas_transcribe_media",
    "prompts_search",
    "assets_list",
    "assets_add",
] as const;

export type SiteToolName = (typeof SITE_TOOL_NAMES)[number];

export function isSiteTool(name: string): name is SiteToolName {
    return (SITE_TOOL_NAMES as readonly string[]).includes(name);
}

function siteText(key: string, options?: Record<string, unknown>) {
    return i18n.t(`agent.siteTools.${key}`, options);
}

export const SITE_TOOL_LABELS: Record<SiteToolName, string> = {
    get canvas_list_projects() { return siteText("canvasList"); },
    get generation_get_status() { return siteText("generationStatus"); },
    get workbench_image_get_config() { return siteText("imageConfig"); },
    get workbench_image_generate() { return siteText("imageGenerate"); },
    get workbench_video_get_config() { return siteText("videoConfig"); },
    get workbench_video_generate() { return siteText("videoGenerate"); },
    get canvas_merge_videos() { return siteText("videoMerge"); },
    get canvas_inspect_media() { return siteText("mediaInspect"); },
    get canvas_render_media() { return siteText("mediaRender"); },
    get canvas_generate_tts() { return siteText("mediaTts"); },
    get canvas_transcribe_media() { return siteText("mediaTranscribe"); },
    get prompts_search() { return siteText("promptSearch"); },
    get assets_list() { return siteText("assetList"); },
    get assets_add() { return siteText("assetAdd"); },
};

type SiteToolInput = Record<string, unknown>;
type SiteToolContext = { canvasSnapshot?: CanvasAgentSnapshot | null; importMedia?: (media: UploadedFile, sourceNodeIds: string[], title: string) => CanvasAgentSnapshot };
type SiteToolRequest = { endpoint: string; token: string; clientId: string; requestId: string };
type GenerationStatus = "idle" | "queued" | "running" | "succeeded" | "failed";
type GenerationStatusItem = { id: string; source: "canvas" | "image" | "video"; status: GenerationStatus; kind?: string; title?: string; prompt?: string; projectId?: string; createdAt?: string; updatedAt?: string; successCount?: number; failCount?: number; error?: string };

export async function runSiteTool(name: SiteToolName, input: SiteToolInput, navigate: NavigateFunction, context: SiteToolContext = {}, request?: SiteToolRequest): Promise<unknown> {
    switch (name) {
        case "canvas_list_projects":
            return listCanvasProjects(input);
        case "generation_get_status":
            return getGenerationStatus(input, context.canvasSnapshot);
        case "workbench_image_get_config":
            return getImageConfig();
        case "workbench_image_generate":
            return runImageWorkbench(input, navigate);
        case "workbench_video_get_config":
            return getVideoConfig();
        case "workbench_video_generate":
            return runVideoWorkbench(input, navigate);
        case "canvas_merge_videos":
            return mergeCanvasVideos(input, context, request);
        case "canvas_inspect_media":
            return inspectCanvasMedia(input, context, request);
        case "canvas_render_media":
            return renderCanvasMedia(input, context, request);
        case "canvas_generate_tts":
            return generateCanvasTts(input, context);
        case "canvas_transcribe_media":
            return transcribeCanvasMedia(input, context, request);
        case "prompts_search":
            return searchPrompts(input);
        case "assets_list":
            return listAssets(input);
        case "assets_add":
            return addAsset(input);
        default:
            throw new Error(siteText("unknownTool", { name }));
    }
}

async function mergeCanvasVideos(input: SiteToolInput, context: SiteToolContext, request?: SiteToolRequest) {
    if (!request || !context.canvasSnapshot || !context.importMedia) throw new Error(siteText("videoMergeCanvasRequired"));
    const nodeIds = Array.isArray(input.nodeIds) ? input.nodeIds.filter((value): value is string => typeof value === "string") : [];
    if (nodeIds.length < 2) throw new Error(siteText("videoMergeCount"));
    const nodes = nodeIds.map((id) => context.canvasSnapshot?.nodes.find((node) => node.id === id));
    if (nodes.some((node) => node?.type !== "video" || !node.metadata?.storageKey)) throw new Error(siteText("videoMergeUnavailable"));
    const transition = input.transition === "fade" ? "fade" : "cut";
    const transitionDurationMs = Number(input.transitionDurationMs);
    const base = `${request.endpoint.replace(/\/$/, "")}/agent/video-merge/${encodeURIComponent(request.requestId)}`;
    const query = `?token=${encodeURIComponent(request.token)}&clientId=${encodeURIComponent(request.clientId)}`;
    let started = false;
    try {
        const start = await fetch(`${base}/start${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ nodeIds, transition, ...(Number.isFinite(transitionDurationMs) ? { transitionDurationMs } : {}) }) });
        if (!start.ok) throw new Error(await agentError(start));
        started = true;
        const blobs = await Promise.all(nodes.map(async (node) => getMediaBlob(node!.metadata!.storageKey!)));
        if (!blobs.every((blob): blob is Blob => Boolean(blob))) throw new Error(siteText("videoMergeUnavailable"));
        for (const [index, blob] of blobs.entries()) {
            const response = await fetch(`${base}/input/${index}${query}`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: blob });
            if (!response.ok) throw new Error(await agentError(response));
        }
        const complete = await fetch(`${base}/complete${query}`, { method: "POST" });
        if (!complete.ok) throw new Error(await agentError(complete));
        started = false;
        const video = await uploadMediaFile(await complete.blob(), "video");
        const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : "合并视频";
        const snapshot = context.importMedia(video, nodeIds, title);
        const filename = `${title.replace(/[\\/:*?\"<>|]/g, "-")}.mp4`;
        saveAs(video.url, filename);
        return { ok: true, nodeId: snapshot.selectedNodeIds.at(-1), title, durationMs: video.durationMs, width: video.width, height: video.height, downloaded: true };
    } finally {
        if (started) void fetch(`${base}/abort${query}`, { method: "POST" });
    }
}

async function inspectCanvasMedia(input: SiteToolInput, context: SiteToolContext, request?: SiteToolRequest) {
    const nodes = mediaNodes(input, context);
    const result = await transferMedia("inspect", nodes, request);
    return result as { items: unknown[] };
}

async function renderCanvasMedia(input: SiteToolInput, context: SiteToolContext, request?: SiteToolRequest) {
    if (!context.importMedia) throw new Error(siteText("mediaCanvasRequired"));
    const nodeIds = Array.isArray(input.nodeIds) ? input.nodeIds.filter((value): value is string => typeof value === "string") : [];
    const nodes = mediaNodes({ nodeIds }, context);
    const videoNodeId = typeof input.videoNodeId === "string" ? input.videoNodeId : "";
    const videoIndex = nodes.findIndex((node) => node.id === videoNodeId);
    if (videoIndex < 0 || nodes[videoIndex].type !== "video") throw new Error(siteText("mediaVideoRequired"));
    const audioIds = new Set(Array.isArray(input.audioNodeIds) ? input.audioNodeIds.filter((value): value is string => typeof value === "string") : []);
    const audioIndexes = nodes.flatMap((node, index) => audioIds.has(node.id) && node.type === "audio" ? [index] : []);
    const response = await transferMedia("render", nodes, request, { videoIndex, audioIndexes, trimStartMs: numberValue(input.trimStartMs), trimEndMs: numberValue(input.trimEndMs), speed: numberValue(input.speed), volume: numberValue(input.volume), mute: input.mute === true, filter: ["grayscale", "sepia", "contrast"].includes(String(input.filter)) ? input.filter : "none", subtitleText: typeof input.subtitleText === "string" ? input.subtitleText : undefined });
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : "剪辑视频";
    const blob = response as Blob;
    const video = await uploadMediaFile(blob, "video");
    const snapshot = context.importMedia(video, nodes.map((node) => node.id), title);
    return { ok: true, nodeId: snapshot.selectedNodeIds.at(-1), title, durationMs: video.durationMs, width: video.width, height: video.height };
}

async function generateCanvasTts(input: SiteToolInput, context: SiteToolContext) {
    if (!context.importMedia) throw new Error(siteText("mediaCanvasRequired"));
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text) throw new Error(siteText("mediaTextRequired"));
    const config = useConfigStore.getState().config;
    const audio = await storeGeneratedAudio(await requestAudioGeneration(config, text), config.audioFormat);
    const title = typeof input.title === "string" && input.title.trim() ? input.title.trim() : "配音";
    const snapshot = context.importMedia(audio, [], title);
    return { ok: true, nodeId: snapshot.selectedNodeIds.at(-1), title, durationMs: audio.durationMs };
}

async function transcribeCanvasMedia(input: SiteToolInput, context: SiteToolContext, request?: SiteToolRequest) {
    const nodeId = typeof input.nodeId === "string" ? input.nodeId : "";
    const node = mediaNodes({ nodeIds: [nodeId] }, context)[0];
    if (node.type !== "audio" && node.type !== "video") throw new Error(siteText("mediaAudioRequired"));
    const audio = await transferMedia("transcribe", [node], request) as Blob;
    const text = await requestAudioTranscription(useConfigStore.getState().config, audio, `${node.title || "media"}.m4a`);
    return { nodeId, text };
}

function mediaNodes(input: SiteToolInput, context: SiteToolContext) {
    if (!context.canvasSnapshot) throw new Error(siteText("mediaCanvasRequired"));
    const ids = Array.isArray(input.nodeIds) ? input.nodeIds.filter((value): value is string => typeof value === "string") : [];
    const nodes = context.canvasSnapshot.nodes.filter((node) => (!ids.length || ids.includes(node.id)) && ["image", "video", "audio"].includes(node.type) && node.metadata?.storageKey);
    if (!nodes.length || (ids.length && nodes.length !== ids.length)) throw new Error(siteText("mediaUnavailable"));
    return nodes;
}

async function transferMedia(operation: "inspect" | "render" | "transcribe", nodes: CanvasAgentSnapshot["nodes"], request: SiteToolRequest | undefined, options?: Record<string, unknown>) {
    if (!request) throw new Error(siteText("mediaCanvasRequired"));
    const base = `${request.endpoint.replace(/\/$/, "")}/agent/media/${encodeURIComponent(request.requestId)}`;
    const query = `?token=${encodeURIComponent(request.token)}&clientId=${encodeURIComponent(request.clientId)}`;
    const start = await fetch(`${base}/start${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, nodeIds: nodes.map((node) => node.id) }) });
    if (!start.ok) throw new Error(await agentError(start));
    const blobs = await Promise.all(nodes.map(async (node) => node.metadata?.storageKey?.startsWith("image:") ? getImageBlob(node.metadata.storageKey) : getMediaBlob(node.metadata!.storageKey!)));
    if (!blobs.every((blob): blob is Blob => Boolean(blob))) throw new Error(siteText("mediaUnavailable"));
    for (const [index, blob] of blobs.entries()) {
        const node = nodes[index];
        const response = await fetch(`${base}/input/${index}${query}`, { method: "PUT", headers: { "content-type": "application/octet-stream", "x-media-name": encodeURIComponent(node.title || `${node.type}-${index + 1}`), "x-media-type": blob.type || node.metadata?.mimeType || "application/octet-stream" }, body: blob });
        if (!response.ok) throw new Error(await agentError(response));
    }
    const complete = await fetch(`${base}/complete${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operation, options }) });
    if (!complete.ok) throw new Error(await agentError(complete));
    return operation === "inspect" ? await complete.json() : await complete.blob();
}

function numberValue(value: unknown) {
    const result = Number(value);
    return Number.isFinite(result) ? result : undefined;
}

async function agentError(response: Response) {
    const data = await response.json().catch(() => null) as { error?: string } | null;
    return data?.error || siteText("videoMergeFailed");
}

function getGenerationStatus(input: SiteToolInput, canvasSnapshot?: CanvasAgentSnapshot | null) {
    const scope = input.scope === "canvas" || input.scope === "image" || input.scope === "video" ? input.scope : "all";
    const taskId = typeof input.taskId === "string" ? input.taskId : "";
    const nodeIds = new Set(Array.isArray(input.nodeIds) ? input.nodeIds.filter((id): id is string => typeof id === "string") : []);
    const limit = Math.max(1, Math.min(100, Math.floor(Number(input.limit)) || 20));
    const tasks: GenerationStatusItem[] = [];
    const includeCanvas = (scope === "all" || scope === "canvas") && (!taskId || nodeIds.size > 0);
    const includeWorkbench = !nodeIds.size || Boolean(taskId);

    if (includeCanvas && canvasSnapshot) {
        canvasSnapshot.nodes.forEach((node) => {
            const status = normalizeCanvasGenerationStatus(node.metadata?.status);
            if (!status || (nodeIds.size && !nodeIds.has(node.id))) return;
            const metadata = node.metadata || {};
            if (!nodeIds.size && node.type !== "config" && status !== "running" && status !== "failed" && !metadata.generationMode && !metadata.generationType && !metadata.model) return;
            tasks.push({ id: node.id, source: "canvas", status, kind: metadata.generationMode || node.type, title: node.title, prompt: compactPrompt(metadata.prompt || metadata.composerContent), projectId: canvasSnapshot.projectId, error: metadata.errorDetails });
        });
    }

    if (includeWorkbench) {
        useWorkbenchAgentStore.getState().tasks.forEach((task) => {
            if ((scope === "image" || scope === "video") && task.kind !== scope) return;
            if (scope === "canvas" || (taskId && task.id !== taskId)) return;
            tasks.push({ ...task, source: task.kind, prompt: compactPrompt(task.prompt) });
        });
    }

    tasks.sort((a, b) => generationStatusOrder(a.status) - generationStatusOrder(b.status) || (b.updatedAt || "").localeCompare(a.updatedAt || ""));
    const summary: Record<GenerationStatus, number> = { idle: 0, queued: 0, running: 0, succeeded: 0, failed: 0 };
    tasks.forEach((task) => (summary[task.status] += 1));
    return { total: tasks.length, summary, tasks: tasks.slice(0, limit) };
}

function generationStatusOrder(status: GenerationStatus) {
    return status === "running" ? 0 : status === "queued" ? 1 : 2;
}

function normalizeCanvasGenerationStatus(status: unknown): GenerationStatus | null {
    if (status === "idle") return "idle";
    if (status === "loading") return "running";
    if (status === "success") return "succeeded";
    if (status === "error") return "failed";
    return null;
}

function compactPrompt(prompt: unknown) {
    const value = typeof prompt === "string" ? prompt.trim() : "";
    return value ? `${value.slice(0, 200)}${value.length > 200 ? "..." : ""}` : undefined;
}

function listCanvasProjects(input: SiteToolInput) {
    const { projects, hydrated } = useCanvasStore.getState();
    if (!hydrated) throw new Error(siteText("canvasLoading"));
    const keyword = String(input.keyword || "").trim().toLowerCase();
    const filtered = keyword ? projects.filter((project) => project.title.toLowerCase().includes(keyword)) : projects;
    const { page, pageSize, start, end } = paginate(input, filtered.length, 20);
    const items = filtered.slice(start, end).map((project) => ({
        id: project.id,
        title: project.title,
        createdAt: project.createdAt,
        updatedAt: project.updatedAt,
        nodeCount: project.nodes.length,
        connectionCount: project.connections.length,
    }));
    return { total: filtered.length, page, pageSize, items, hint: siteText("canvasHint") };
}

function getImageConfig() {
    const { config } = useConfigStore.getState();
    const model = config.imageModel || config.model;
    return {
        current: { model, modelName: modelOptionName(model), quality: config.quality || "auto", size: config.size || "1:1", count: config.count || "1" },
        models: selectableModelsByCapability(config, "image").map((value) => ({ value, label: modelOptionLabel(config, value) })),
        qualityOptions: imageQualityOptions,
        sizeOptions: imageAspectOptions,
        countRange: { min: 1, max: 15 },
    };
}

function runImageWorkbench(input: SiteToolInput, navigate: NavigateFunction) {
    const configStore = useConfigStore.getState();
    const applied: Record<string, unknown> = {};
    if (typeof input.model === "string" && input.model.trim()) {
        const value = normalizeModelOptionValue(input.model, configStore.config.channels) || input.model;
        configStore.updateConfig("imageModel", value);
        applied.model = value;
    }
    if (typeof input.quality === "string" && input.quality.trim()) {
        configStore.updateConfig("quality", input.quality);
        applied.quality = input.quality;
    }
    if (typeof input.size === "string" && input.size.trim()) {
        configStore.updateConfig("size", input.size);
        applied.size = input.size;
    }
    if (input.count != null) {
        const count = String(Math.max(1, Math.min(15, Math.floor(Number(input.count)) || 1)));
        configStore.updateConfig("count", count);
        applied.count = count;
    }
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const run = input.run !== false;
    navigate("/image");
    const taskId = useWorkbenchAgentStore.getState().dispatchImage({ prompt, run });
    return { ok: true, navigated: "/image", prompt, run, taskId, applied, note: siteText(run ? "imageGenerationStarted" : "imageConfigApplied") };
}

function getVideoConfig() {
    const { config } = useConfigStore.getState();
    const model = config.videoModel || config.model;
    return {
        current: {
            model,
            modelName: modelOptionName(model),
            size: config.size || "1280x720",
            seconds: config.videoSeconds || "6",
            resolution: config.vquality || "720",
            generateAudio: config.videoGenerateAudio !== "false",
            watermark: config.videoWatermark === "true",
        },
        models: selectableModelsByCapability(config, "video").map((value) => ({ value, label: modelOptionLabel(config, value) })),
        sizeOptions: videoSizeOptions,
        secondsOptions: videoSecondOptions,
        resolutionOptions: videoResolutionOptions,
    };
}

function runVideoWorkbench(input: SiteToolInput, navigate: NavigateFunction) {
    const configStore = useConfigStore.getState();
    const applied: Record<string, unknown> = {};
    if (typeof input.model === "string" && input.model.trim()) {
        const value = normalizeModelOptionValue(input.model, configStore.config.channels) || input.model;
        configStore.updateConfig("videoModel", value);
        applied.model = value;
    }
    if (typeof input.size === "string" && input.size.trim()) {
        configStore.updateConfig("size", input.size);
        applied.size = input.size;
    }
    if (typeof input.seconds === "string" && input.seconds.trim()) {
        configStore.updateConfig("videoSeconds", input.seconds);
        applied.seconds = input.seconds;
    }
    if (typeof input.resolution === "string" && input.resolution.trim()) {
        configStore.updateConfig("vquality", input.resolution);
        applied.resolution = input.resolution;
    }
    if (typeof input.generateAudio === "boolean") {
        configStore.updateConfig("videoGenerateAudio", String(input.generateAudio));
        applied.generateAudio = input.generateAudio;
    }
    if (typeof input.watermark === "boolean") {
        configStore.updateConfig("videoWatermark", String(input.watermark));
        applied.watermark = input.watermark;
    }
    const prompt = typeof input.prompt === "string" ? input.prompt : undefined;
    const run = input.run !== false;
    navigate("/video");
    const taskId = useWorkbenchAgentStore.getState().dispatchVideo({ prompt, run });
    return { ok: true, navigated: "/video", prompt, run, taskId, applied, note: siteText(run ? "videoGenerationStarted" : "videoConfigApplied") };
}

async function searchPrompts(input: SiteToolInput) {
    const page = Math.max(1, Math.floor(Number(input.page)) || 1);
    const pageSize = Math.max(1, Math.min(50, Math.floor(Number(input.pageSize)) || 20));
    const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const result = await fetchPrompts({ keyword: String(input.keyword || ""), category: String(input.category || i18n.t("common.all")), tag: tags, page, pageSize });
    return {
        total: result.total,
        page,
        pageSize,
        categories: result.categories,
        tags: result.tags.slice(0, 60),
        items: result.items.map((prompt) => ({ id: prompt.id, title: prompt.title, prompt: prompt.prompt, category: prompt.category, tags: prompt.tags, coverUrl: prompt.coverUrl, githubUrl: prompt.githubUrl })),
    };
}

function listAssets(input: SiteToolInput) {
    const { assets, hydrated } = useAssetStore.getState();
    if (!hydrated) throw new Error(siteText("assetsLoading"));
    const kind = input.kind === "text" || input.kind === "image" || input.kind === "video" ? input.kind : "all";
    const keyword = String(input.keyword || "").trim().toLowerCase();
    const filtered = assets.filter((asset) => {
        if (kind !== "all" && asset.kind !== kind) return false;
        if (!keyword) return true;
        return [asset.title, asset.note, asset.source, ...asset.tags].filter(Boolean).join(" ").toLowerCase().includes(keyword);
    });
    const { page, pageSize, start, end } = paginate(input, filtered.length, 20);
    const items = filtered.slice(start, end).map((asset) => ({
        id: asset.id,
        kind: asset.kind,
        title: asset.title,
        tags: asset.tags,
        source: asset.source,
        note: asset.note,
        createdAt: asset.createdAt,
        updatedAt: asset.updatedAt,
        coverUrl: asset.coverUrl || undefined,
        content: asset.kind === "text" ? asset.data.content : undefined,
    }));
    return { total: filtered.length, page, pageSize, items };
}

async function addAsset(input: SiteToolInput) {
    const kind = input.kind;
    const title = String(input.title || "").trim();
    if (!title) throw new Error(siteText("assetTitleRequired"));
    const tags = Array.isArray(input.tags) ? input.tags.filter((tag): tag is string => typeof tag === "string") : [];
    const source = typeof input.source === "string" ? input.source : "Agent";
    const note = typeof input.note === "string" ? input.note : undefined;
    const store = useAssetStore.getState();
    if (kind === "text") {
        const content = String(input.content || "").trim();
        if (!content) throw new Error(siteText("textContentRequired"));
        const id = store.addAsset({ kind: "text", title, coverUrl: "", tags, source, note, data: { content } });
        return { ok: true, id, kind: "text" };
    }
    if (kind === "image") {
        const imageUrl = String(input.imageUrl || "").trim();
        if (!imageUrl) throw new Error(siteText("imageUrlRequired"));
        let stored;
        try {
            stored = await uploadImage(imageUrl);
        } catch {
            throw new Error(siteText("imageReadFailed"));
        }
        const id = store.addAsset({ kind: "image", title, coverUrl: stored.url, tags, source, note, data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType } });
        return { ok: true, id, kind: "image" };
    }
    throw new Error(siteText("assetKindUnsupported"));
}

function paginate(input: SiteToolInput, total: number, defaultSize: number) {
    const pageSize = Math.max(1, Math.min(100, Math.floor(Number(input.pageSize)) || defaultSize));
    const maxPage = Math.max(1, Math.ceil(total / pageSize));
    const page = Math.min(maxPage, Math.max(1, Math.floor(Number(input.page)) || 1));
    const start = (page - 1) * pageSize;
    return { page, pageSize, start, end: start + pageSize };
}
