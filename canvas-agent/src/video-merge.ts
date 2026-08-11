import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type VideoMergeOptions = { transition?: "cut" | "fade"; transitionDurationMs?: number };
export type VideoMergeResult = { data: Buffer; width: number; height: number; durationMs: number };

type VideoProbe = { width: number; height: number; fps: number; duration: number; hasAudio: boolean };

export async function mergeVideos(blobs: Buffer[], options: VideoMergeOptions = {}): Promise<VideoMergeResult> {
    if (blobs.length < 2) throw new Error("至少需要两个视频片段");
    const directory = await mkdtemp(path.join(os.tmpdir(), "canvas-video-merge-"));
    try {
        const files = await Promise.all(blobs.map(async (blob, index) => {
            const file = path.join(directory, `input-${index}.mp4`);
            await writeFile(file, blob);
            return file;
        }));
        const probes = await Promise.all(files.map(probeVideo));
        const output = path.join(directory, "merged.mp4");
        await runFfmpeg(files, probes, output, options);
        const finalProbe = await probeVideo(output);
        return { data: await readFile(output), width: finalProbe.width, height: finalProbe.height, durationMs: Math.round(finalProbe.duration * 1000) };
    } finally {
        await rm(directory, { recursive: true, force: true });
    }
}

async function probeVideo(file: string): Promise<VideoProbe> {
    const result = JSON.parse(await run("ffprobe", ["-v", "error", "-show_entries", "stream=codec_type,width,height,r_frame_rate:format=duration", "-of", "json", file])) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string }>; format?: { duration?: string } };
    const video = result.streams?.find((stream) => stream.codec_type === "video");
    const fpsParts = String(video?.r_frame_rate || "30/1").split("/").map(Number);
    const fps = fpsParts[0] && fpsParts[1] ? fpsParts[0] / fpsParts[1] : 30;
    const duration = Number(result.format?.duration);
    if (!video?.width || !video.height || !Number.isFinite(duration) || duration <= 0) throw new Error("无法读取视频规格");
    return { width: video.width, height: video.height, fps: Math.max(1, Math.min(120, fps)), duration, hasAudio: result.streams?.some((stream) => stream.codec_type === "audio") || false };
}

async function runFfmpeg(files: string[], probes: VideoProbe[], output: string, options: VideoMergeOptions) {
    const first = probes[0];
    const args = files.flatMap((file, index) => probes[index].hasAudio ? ["-i", file] : ["-i", file, "-f", "lavfi", "-t", String(probes[index].duration), "-i", "anullsrc=r=48000:cl=stereo"]);
    const inputIndexes: Array<{ video: number; audio: number }> = [];
    let inputIndex = 0;
    probes.forEach((probe) => {
        inputIndexes.push({ video: inputIndex, audio: probe.hasAudio ? inputIndex : inputIndex + 1 });
        inputIndex += probe.hasAudio ? 1 : 2;
    });
    const filter: string[] = inputIndexes.flatMap(({ video, audio }, index) => [
        `[${video}:v]scale=${first.width}:${first.height}:force_original_aspect_ratio=decrease,pad=${first.width}:${first.height}:(ow-iw)/2:(oh-ih)/2,fps=${first.fps},setsar=1,setpts=PTS-STARTPTS[v${index}]`,
        `[${audio}:a]aformat=sample_rates=48000:channel_layouts=stereo,asetpts=PTS-STARTPTS[a${index}]`,
    ]);
    const fade = options.transition === "fade";
    if (!fade) filter.push(`${inputIndexes.map((_, index) => `[v${index}][a${index}]`).join("")}concat=n=${files.length}:v=1:a=1[v][a]`);
    else {
        let video = "v0";
        let audio = "a0";
        let elapsed = probes[0].duration;
        for (let index = 1; index < files.length; index += 1) {
            const duration = Math.min(Math.max(0.1, (options.transitionDurationMs || 1000) / 1000), elapsed / 2, probes[index].duration / 2);
            filter.push(`[${video}][v${index}]xfade=transition=fade:duration=${duration}:offset=${Math.max(0, elapsed - duration)}[vx${index}]`, `[${audio}][a${index}]acrossfade=d=${duration}[ax${index}]`);
            video = `vx${index}`;
            audio = `ax${index}`;
            elapsed += probes[index].duration - duration;
        }
        filter.push(`[${video}]null[v]`, `[${audio}]anull[a]`);
    }
    await run("ffmpeg", ["-y", ...args, "-filter_complex", filter.join(";"), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", "-movflags", "+faststart", output]);
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
