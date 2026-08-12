import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type MediaInput = { name: string; type: string; data: Buffer };
export type MediaInfo = { name: string; type: string; bytes: number; durationMs?: number; width?: number; height?: number; streams: string[] };
export type MediaRenderOptions = { videoIndex: number; audioIndexes?: number[]; trimStartMs?: number; trimEndMs?: number; speed?: number; volume?: number; mute?: boolean; filter?: "none" | "grayscale" | "sepia" | "contrast"; subtitleText?: string; title?: string };
export type MediaRenderResult = { data: Buffer; width: number; height: number; durationMs: number };

export async function inspectMedia(input: MediaInput): Promise<MediaInfo> {
    const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-media-inspect-"));
    try {
        const file = path.join(directory, safeName(input.name, input.type));
        await writeFile(file, input.data);
        return { name: input.name, type: input.type, bytes: input.data.length, ...(await probe(file)) };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

/** Materialize user-authorized browser media inside the active Codex workspace. */
export async function materializeMedia(inputs: MediaInput[], directory: string) {
    await mkdir(directory, { recursive: true });
    return await Promise.all(inputs.map(async (input, index) => {
        const file = path.join(directory, `${index + 1}-${safeName(input.name, input.type)}`);
        await writeFile(file, input.data);
        return { path: file, info: await inspectMedia(input) };
    }));
}

export async function renderMedia(inputs: MediaInput[], options: MediaRenderOptions): Promise<MediaRenderResult> {
    if (!inputs.length || !Number.isInteger(options.videoIndex) || options.videoIndex < 0 || options.videoIndex >= inputs.length) throw new Error("视频素材无效");
    const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-media-render-"));
    try {
        const files = await Promise.all(inputs.map(async (input, index) => {
            const file = path.join(directory, `${index}-${safeName(input.name, input.type)}`);
            await writeFile(file, input.data);
            return file;
        }));
        const video = await probe(files[options.videoIndex]);
        const width = video.width;
        const height = video.height;
        if (!width || !height) throw new Error("所选素材不包含视频流");
        const output = path.join(directory, "result.mp4");
        const start = Math.max(0, Number(options.trimStartMs || 0) / 1000);
        const end = Number(options.trimEndMs || 0) / 1000;
        const speed = Math.max(0.25, Math.min(4, Number(options.speed || 1)));
        const videoFilters = [`trim=start=${start}${end > start ? `:end=${end}` : ""}`, "setpts=PTS-STARTPTS", `setpts=PTS/${speed}`];
        if (options.filter === "grayscale") videoFilters.push("hue=s=0");
        if (options.filter === "sepia") videoFilters.push("colorchannelmixer=.393:.769:.189:.349:.686:.168:.272:.534:.131");
        if (options.filter === "contrast") videoFilters.push("eq=contrast=1.25:saturation=1.1");
        const subtitle = options.subtitleText?.trim();
        if (subtitle) {
            const subtitleFile = path.join(directory, "subtitle.srt");
            await writeFile(subtitleFile, `1\n00:00:00,000 --> 23:59:59,000\n${subtitle.replace(/\r?\n/g, " ")}\n`);
            videoFilters.push(`subtitles=${subtitleFile.replace(/\\/g, "\\\\").replace(/:/g, "\\:")}`);
        }
        const audioIndexes = (options.audioIndexes || []).filter((index) => Number.isInteger(index) && index >= 0 && index < files.length);
        const args = files.flatMap((file) => ["-i", file]);
        const filter = [`[${options.videoIndex}:v]${videoFilters.join(",")}[v]`];
        const maps = ["-map", "[v]"];
        const videoHasAudio = video.streams.some((stream) => stream.startsWith("audio:"));
        const useAudio = !options.mute && (audioIndexes.length > 0 || videoHasAudio);
        if (useAudio) {
            const audioInputs = videoHasAudio ? [options.videoIndex, ...audioIndexes] : audioIndexes;
            const audioFilters = audioInputs.map((index, item) => `[${index}:a]atrim=start=${start}${end > start ? `:end=${end}` : ""},asetpts=PTS-STARTPTS,${audioTempo(speed)}${options.volume ? `,volume=${Math.max(0, Math.min(4, options.volume))}` : ""}[a${item}]`);
            filter.push(...audioFilters, audioInputs.length === 1 ? "[a0]anull[a]" : `${audioInputs.map((_, item) => `[a${item}]`).join("")}amix=inputs=${audioInputs.length}:duration=longest[a]`);
            maps.push("-map", "[a]");
        }
        await run("ffmpeg", ["-y", ...args, "-filter_complex", filter.join(";"), ...maps, "-c:v", "libx264", "-pix_fmt", "yuv420p", ...(!useAudio ? ["-an"] : ["-c:a", "aac"]), "-movflags", "+faststart", output]);
        const result = await probe(output);
        return { data: await readFile(output), width: result.width || width, height: result.height || height, durationMs: result.durationMs || 0 };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

function audioTempo(speed: number) {
    const filters: string[] = [];
    let value = speed;
    while (value < 0.5) (filters.push("atempo=0.5"), value *= 2);
    while (value > 2) (filters.push("atempo=2"), value /= 2);
    filters.push(`atempo=${value}`);
    return filters.join(",");
}

export async function extractAudio(input: MediaInput) {
    const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-media-audio-"));
    try {
        const source = path.join(directory, safeName(input.name, input.type));
        const output = path.join(directory, "audio.m4a");
        await writeFile(source, input.data);
        await run("ffmpeg", ["-y", "-i", source, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "aac", output]);
        return await readFile(output);
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function probe(file: string) {
    const value = JSON.parse(await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,codec_name:format=duration", "-of", "json", file])) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; codec_name?: string }>; format?: { duration?: string } };
    const video = value.streams?.find((stream) => stream.codec_type === "video");
    const duration = Number(value.format?.duration);
    return { ...(Number.isFinite(duration) ? { durationMs: Math.round(duration * 1000) } : {}), ...(video?.width ? { width: video.width, height: video.height } : {}), streams: (value.streams || []).map((stream) => `${stream.codec_type || "unknown"}:${stream.codec_name || "unknown"}`) };
}

function safeName(name: string, type: string) {
    const extension = type.startsWith("video/") ? ".mp4" : type.startsWith("audio/") ? ".m4a" : ".png";
    return `${name.replace(/[^a-zA-Z0-9._-]/g, "-").slice(0, 80) || "media"}${path.extname(name) ? "" : extension}`;
}

function run(command: string, args: string[]) {
    return new Promise<string>((resolve, reject) => {
        const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (value) => (stdout += value));
        child.stderr.on("data", (value) => (stderr += value));
        child.on("error", () => reject(new Error(`${command} 未安装或无法启动`)));
        child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${command} 执行失败：${stderr.slice(-500)}`))));
    });
}
