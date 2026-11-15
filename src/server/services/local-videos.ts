import type { GenerationMode, LocalVideoView, TaskStatus } from "@/lib/types";
import { config } from "../config";
import { encryptFile, encryptName, SKE_SUFFIX } from "../crypto/ske";
import { prisma } from "../db";
import { errors } from "../errors";
import { logger } from "../logger";
import { shouldEncryptStorage } from "./storage-settings";
import {
  deleteStoredFile,
  downloadCoverFile,
  downloadVideoFile,
  storageFilePath,
  storedFile,
  type StorageKind,
  type VideoSource,
} from "./video-store";

const log = logger.child("localvideos");

/**
 * 落盘任务快照：既包含下载需要的定位信息，也包含要一并入库的记录信息。
 * 直接传 TaskWithAccount 即可满足，多出来的字段会被忽略。
 */
export interface PersistableTask extends VideoSource {
  prompt: string;
  mode: string;
  aspectRatio: string;
  duration: number;
  resolution: string;
  qualityType: number;
  status: string;
  createdAt: Date;
  finishedAt: Date | null;
  account: { label: string };
}

/** 本地标签页一次最多返回的记录数。 */
const LIST_LIMIT = 500;

/** 同一任务只允许一个落盘流程，避免守护轮询与手动刷新同时下载。 */
const inFlight = new Set<string>();

/** 读取加密文件所需的主密码；未配置时直接报错，避免静默返回坏数据。 */
export function storagePassword(): string {
  const password = config.storagePassword;
  if (!password) throw errors.internal("未配置 STORAGE_PASSWORD，无法读取加密文件");
  return password;
}

/**
 * 本地标签页的数据源：直接读 LocalVideo 表，不扫磁盘。
 * 记录在落盘那一刻写入，之后历史记录被删也不受影响。
 */
export async function listLocalVideos(): Promise<LocalVideoView[]> {
  const rows = await prisma.localVideo.findMany({
    orderBy: { savedAt: "desc" },
    take: LIST_LIMIT,
  });

  return rows.map((row) => ({
    taskId: row.taskId,
    filename: row.filename,
    size: row.size,
    savedAt: row.savedAt.toISOString(),
    encrypted: row.encrypted,
    coverUrl: row.coverFilename ? `/api/videos/local/${row.taskId}/cover` : null,
    task: {
      prompt: row.prompt,
      accountLabel: row.accountLabel,
      mode: row.mode as GenerationMode,
      status: row.status as TaskStatus,
      createdAt: row.taskCreatedAt.toISOString(),
      finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
      remoteId: row.remoteId,
      aspectRatio: row.aspectRatio,
      duration: row.duration,
      resolution: row.resolution,
      qualityType: row.qualityType,
    },
  }));
}

/** 把明文文件就地加密成 .ske，并删掉明文；返回加密后的文件名与大小。 */
async function encryptStored(
  kind: StorageKind,
  filename: string
): Promise<{ filename: string; size: number }> {
  const password = storagePassword();
  const src = storageFilePath(kind, filename);
  // 文件名也要按 SKE 规则加密：官方 CLI 会先解密文件名再解密内容。
  const target = `${await encryptName(filename, password)}${SKE_SUFFIX}`;
  await encryptFile(src, storageFilePath(kind, target), password);
  await deleteStoredFile(kind, filename);
  const info = await storedFile(kind, target);
  if (!info) throw new Error("加密后文件写入失败");
  return { filename: target, size: info.size };
}

/**
 * 把成功任务的视频与封面落到本地并登记到数据库。
 *
 * 加密由 Setting 里的开关控制（主密码来自 STORAGE_PASSWORD）。
 * 入库失败会删掉本次新建的文件，避免出现「磁盘有文件、列表里没有」的孤儿。
 * 不抛异常：落盘失败只记日志，绝不影响任务状态与前端 SSE 推送。
 */
export async function persistTaskVideo(task: PersistableTask): Promise<boolean> {
  if (inFlight.has(task.id)) return false;
  inFlight.add(task.id);

  // 记录本次新建的文件，失败时回滚；同类型只保留最新文件名（加密后会换成 .ske）。
  const created: Array<{ kind: StorageKind; filename: string }> = [];
  const track = (kind: StorageKind, filename: string): void => {
    const index = created.findIndex((file) => file.kind === kind);
    const entry = { kind, filename };
    if (index >= 0) created[index] = entry;
    else created.push(entry);
  };
  try {
    // 已登记过就直接返回：加密后磁盘上没有 .mp4，不能靠文件是否存在判断幂等。
    const existing = await prisma.localVideo.findUnique({ where: { taskId: task.id } });
    if (existing) return true;

    const encrypt = await shouldEncryptStorage();

    const video = await downloadVideoFile(task);
    let filename = `${task.id}.mp4`;
    let size = video.bytes;
    let encrypted = false;
    if (video.downloaded) track("video", filename);

    if (video.downloaded && encrypt) {
      const converted = await encryptStored("video", filename);
      track("video", converted.filename);
      filename = converted.filename;
      size = converted.size;
      encrypted = true;
    }

    // 封面失败不影响视频落盘，只记一条 warn。
    let coverFilename: string | null = null;
    let coverSize: number | null = null;
    let coverEncrypted = false;
    try {
      const cover = await downloadCoverFile(task);
      if (cover) {
        track("cover", cover.filename);
        coverFilename = cover.filename;
        coverSize = cover.size;
        if (encrypt) {
          const converted = await encryptStored("cover", cover.filename);
          track("cover", converted.filename);
          coverFilename = converted.filename;
          coverSize = converted.size;
          coverEncrypted = true;
        }
      }
    } catch (err) {
      log.warn("cover_failed", {
        taskId: task.id,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    await prisma.localVideo.upsert({
      where: { taskId: task.id },
      create: {
        taskId: task.id,
        filename,
        size,
        encrypted,
        coverFilename,
        coverSize,
        coverEncrypted,
        remoteId: task.remoteId,
        prompt: task.prompt,
        mode: task.mode,
        accountId: task.accountId,
        accountLabel: task.account.label,
        aspectRatio: task.aspectRatio,
        duration: task.duration,
        resolution: task.resolution,
        qualityType: task.qualityType,
        status: task.status,
        taskCreatedAt: task.createdAt,
        finishedAt: task.finishedAt,
      },
      update: {
        filename,
        size,
        encrypted,
        coverFilename,
        coverSize,
        coverEncrypted,
        savedAt: new Date(),
      },
    });

    log.info("saved", {
      taskId: task.id,
      bytes: size,
      downloaded: video.downloaded,
      encrypted,
      cover: coverFilename,
    });
    return true;
  } catch (err) {
    // 回滚本次新建的文件（未登记的记录对用户不可见，留着只会占空间）
    for (const file of created) {
      await deleteStoredFile(file.kind, file.filename).catch(() => {});
    }
    log.warn("save_failed", {
      taskId: task.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return false;
  } finally {
    inFlight.delete(task.id);
  }
}

/** 自动落盘入口：受 VIDEO_AUTO_SAVE 开关控制，关闭时不请求上游、不碰磁盘。 */
export function autoPersistTaskVideo(task: PersistableTask): void {
  if (!config.autoSaveVideo) return;
  void persistTaskVideo(task);
}

/** 删除本地副本（视频 + 封面）与它的数据库记录；历史记录与 Viggle 上游都不受影响。 */
export async function removeLocalVideo(taskId: string): Promise<{ taskId: string }> {
  const record = await prisma.localVideo.findUnique({ where: { taskId } });
  if (!record) throw errors.notFound("本地记录不存在，可能已被删除");

  // 先删文件再删记录：文件删不掉时保留记录，用户还能重试。
  await deleteStoredFile("video", record.filename);
  if (record.coverFilename) await deleteStoredFile("cover", record.coverFilename);
  await prisma.localVideo.delete({ where: { taskId } });
  log.info("deleted", { taskId, encrypted: record.encrypted });
  return { taskId };
}

export interface LocalVideoFileInfo {
  path: string;
  filename: string;
  size: number;
  encrypted: boolean;
}

/** 播放/下载路由用：定位视频文件，未登记或文件丢失都按 404 处理。 */
export async function getLocalVideoFileInfo(taskId: string): Promise<LocalVideoFileInfo> {
  const record = await prisma.localVideo.findUnique({
    where: { taskId },
    select: { filename: true, encrypted: true },
  });
  if (!record) throw errors.notFound("本地记录不存在，可能已被删除");

  const file = await storedFile("video", record.filename);
  if (!file) throw errors.notFound("本地文件不存在，可能已被删除");
  return { path: file.path, filename: record.filename, size: file.size, encrypted: record.encrypted };
}

export interface LocalCoverFileInfo {
  path: string;
  filename: string;
  size: number;
  /** 加密文件名是 token，拿不到扩展名，此时返回 null 交由调用方嗅探 */
  contentType: string | null;
  encrypted: boolean;
}

/** 明文封面的 Content-Type 由扩展名决定。 */
function coverContentType(filename: string): string | null {
  if (filename.endsWith(SKE_SUFFIX)) return null;
  const ext = filename.slice(filename.lastIndexOf(".") + 1).toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

export async function getLocalCoverFileInfo(taskId: string): Promise<LocalCoverFileInfo> {
  const record = await prisma.localVideo.findUnique({
    where: { taskId },
    select: { coverFilename: true, coverEncrypted: true },
  });
  if (!record?.coverFilename) throw errors.notFound("本地封面不存在");

  const file = await storedFile("cover", record.coverFilename);
  if (!file) throw errors.notFound("本地封面不存在");
  return {
    path: file.path,
    filename: record.coverFilename,
    size: file.size,
    contentType: coverContentType(record.coverFilename),
    encrypted: record.coverEncrypted,
  };
}
