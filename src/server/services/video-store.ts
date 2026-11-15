import { open, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { config } from "../config";
import { errors } from "../errors";
import { getProvider } from "../provider";
import { getAccountCredentials } from "./accounts";

/** 下载所需的定位信息；提示词等元信息由业务层负责入库。 */
export interface VideoSource {
  id: string;
  accountId: string;
  remoteId: string | null;
  videoUrl: string | null;
}

/** 落盘的两类文件：视频与封面，分别位于根目录下的 videos/ 与 covers/。 */
export type StorageKind = "video" | "cover";

/** 失败重试次数：上游偶发 5xx 时多试一次，每次都会重新签发直链。 */
const MAX_ATTEMPTS = 2;
const RETRY_DELAY_MS = 1500;

/** 任务 ID 只允许字母、数字与连字符，杜绝路径穿越。 */
const TASK_ID = /^[A-Za-z0-9-]{6,64}$/;
/** 明文文件名：<任务ID>.<媒体扩展名> */
const PLAIN_FILE = /^([A-Za-z0-9-]{6,64})\.(?:mp4|jpg|jpeg|png|webp)$/;
/**
 * 加密文件名：`<SKE 文件名 token>.ske`。
 * token 由 encryptName 生成，是 base64url，官方 `ske decrypt` 依赖它还原原名。
 */
const ENCRYPTED_FILE = /^[A-Za-z0-9_-]{16,128}\.ske$/;

function isStoredFilename(filename: string): boolean {
  return PLAIN_FILE.test(filename) || ENCRYPTED_FILE.test(filename);
}

/**
 * 落盘根目录：VIDEO_STORAGE_DIR 只需配这一个（如 ./storage 或 /mnt/hdd/Bt）。
 * path.resolve 遇到绝对路径会原样使用，相对路径才按 process.cwd() 拼接。
 */
function storageRoot(): string {
  return resolve(process.cwd(), config.storageDir);
}

function videosDir(): string {
  return join(storageRoot(), "videos");
}

function coversDir(): string {
  return join(storageRoot(), "covers");
}

function dirOf(kind: StorageKind): string {
  return kind === "video" ? videosDir() : coversDir();
}

/** 由文件名得到绝对路径；文件名不合法直接拒绝。 */
export function storageFilePath(kind: StorageKind, filename: string): string {
  if (!isStoredFilename(filename)) throw errors.validation("文件名不合法");
  return join(dirOf(kind), filename);
}

/** 读取已落盘文件的元信息；不存在时返回 null。 */
export async function storedFile(
  kind: StorageKind,
  filename: string
): Promise<{ path: string; size: number; savedAt: Date } | null> {
  if (!isStoredFilename(filename)) return null;
  const path = storageFilePath(kind, filename);
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size === 0) return null;
    return { path, size: info.size, savedAt: info.mtime };
  } catch {
    return null;
  }
}

/**
 * 删除一个落盘文件（含残留的 .part）。只动磁盘，不碰数据库记录。
 * 视频还会顺带清理早期版本留下的 `<任务ID>.json` sidecar。
 */
export async function deleteStoredFile(kind: StorageKind, filename: string): Promise<boolean> {
  const target = storageFilePath(kind, filename);
  const existed = (await storedFile(kind, filename)) !== null;
  await rm(target, { force: true });
  await rm(`${target}.part`, { force: true });

  const plain = PLAIN_FILE.exec(filename);
  if (kind === "video" && plain) {
    const legacy = join(videosDir(), `${plain[1]}.json`);
    await rm(legacy, { force: true });
    await rm(`${legacy}.part`, { force: true });
  }
  return existed;
}

const delay = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** 把字节流写进临时文件，返回字节数；失败时清理临时文件。 */
async function writeBody(body: ReadableStream<Uint8Array>, tmp: string): Promise<number> {
  const handle = await open(tmp, "w");
  let bytes = 0;
  try {
    // ReadableStream 在 Node 18+ 可直接异步迭代，逐块写盘兼顾内存与背压。
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.from(chunk);
      bytes += buffer.byteLength;
      await handle.write(buffer);
    }
  } catch (err) {
    await handle.close();
    await rm(tmp, { force: true });
    throw err;
  }
  await handle.close();
  return bytes;
}

/** 一次完整的视频下载：先写 .part 临时文件，成功后 rename 成正式文件。 */
async function downloadOnce(task: VideoSource, target: string): Promise<number> {
  const { account, token } = await getAccountCredentials(task.accountId);
  const stream = await getProvider().getVideoStream(
    { accountId: account.id, token },
    { taskId: task.id, remoteId: task.remoteId, videoUrl: task.videoUrl },
    {}
  );
  if (!stream) throw new Error("上游未返回视频流，可能已被删除或直链已失效");

  const tmp = `${target}.part`;
  const bytes = await writeBody(stream.body, tmp);
  if (bytes === 0) {
    await rm(tmp, { force: true });
    throw new Error("下载到的视频为空");
  }
  await rename(tmp, target);
  return bytes;
}

/**
 * 把视频下载到 `<根目录>/videos/<任务ID>.mp4`。
 * 本地已有该文件时直接返回（`downloaded: false`），避免重复下载。
 */
export async function downloadVideoFile(
  task: VideoSource
): Promise<{ bytes: number; downloaded: boolean }> {
  const filename = `${task.id}.mp4`;
  const existing = await storedFile("video", filename);
  if (existing) return { bytes: existing.size, downloaded: false };

  const target = storageFilePath("video", filename);
  await mkdir(dirname(target), { recursive: true });

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const bytes = await downloadOnce(task, target);
      return { bytes, downloaded: true };
    } catch (err) {
      lastError = err;
      if (attempt < MAX_ATTEMPTS) await delay(RETRY_DELAY_MS);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** 下载封面到 `<根目录>/covers/<任务ID>.<ext>`；上游没有封面时返回 null。 */
export async function downloadCoverFile(
  task: VideoSource
): Promise<{ filename: string; size: number } | null> {
  const { account, token } = await getAccountCredentials(task.accountId);
  const stream = await getProvider().getCoverStream(
    { accountId: account.id, token },
    { taskId: task.id, remoteId: task.remoteId, videoUrl: task.videoUrl }
  );
  if (!stream) return null;

  const ext = stream.contentType.includes("png")
    ? "png"
    : stream.contentType.includes("webp")
      ? "webp"
      : "jpg";
  const filename = `${task.id}.${ext}`;
  const target = storageFilePath("cover", filename);
  await mkdir(dirname(target), { recursive: true });

  const tmp = `${target}.part`;
  const bytes = await writeBody(stream.body, tmp);
  if (bytes === 0) {
    await rm(tmp, { force: true });
    throw new Error("下载到的封面为空");
  }
  await rename(tmp, target);
  return { filename, size: bytes };
}

/** 校验任务 ID（路由参数用）。 */
export function isValidTaskId(taskId: string): boolean {
  return TASK_ID.test(taskId);
}
