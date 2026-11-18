import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Asset, LocalAsset } from "@prisma/client";
import {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MIME_EXTENSION,
  UPSTREAM_ASSET_REUSE_MS,
  UPSTREAM_ASSET_TTL_MS,
  isAcceptedMime,
  isVideoMime,
} from "@/lib/constants";
import type { LocalAssetView } from "@/lib/types";
import { config } from "../config";
import { decryptAll, encryptFile, encryptName, openEncryptedFile, SKE_SUFFIX } from "../crypto/ske";
import { prisma } from "../db";
import { errors } from "../errors";
import { logger } from "../logger";
import { generateImageThumbnail } from "../media/thumbnail";
import { getProvider } from "../provider";
import type { ProviderContext } from "../provider/types";
import { getKeepAssets, getStorageDir, shouldEncryptStorage } from "./storage-settings";
import { deleteStoredFile, storageFilePath, storedFile } from "./video-store";

/** 素材箱列表每页条数。 */
const PAGE_SIZE = 30;

/** 临时素材的兜底回收时限：刷新页面会丢失草稿，靠这个避免孤儿文件永久占盘。 */
const TEMP_ASSET_TTL_MS = 24 * 60 * 60 * 1000;

export interface SaveLocalAssetInput {
  buffer: Buffer;
  mime: string;
  originalName: string;
  /** 临时素材：不进素材箱，生成提交后由调用方清理 */
  temporary?: boolean;
  /** 视频封面由上传端浏览器抓帧后传入；图片封面服务端用 sharp 生成 */
  thumbnail?: Buffer | null;
}

/** 上传端传来的封面只接受小尺寸 JPEG，防止被塞大文件。 */
function sanitizeThumbnail(buffer?: Buffer | null): Buffer | null {
  if (!buffer?.length || buffer.length > 512 * 1024) return null;
  if (buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  return buffer;
}

export interface LocalAssetList {
  items: LocalAssetView[];
  total: number;
  totalBytes: number;
  page: number;
  hasMore: boolean;
}

export type LocalAssetKindFilter = "all" | "image" | "video";

/** 素材记录转前端视图；上传接口与列表共用。 */
export function toLocalAssetView(asset: LocalAsset): LocalAssetView {
  return {
    id: asset.id,
    filename: asset.filename,
    originalName: asset.originalName,
    kind: asset.kind as LocalAssetView["kind"],
    mime: asset.mime,
    size: asset.size,
    url: `/api/assets/local/${asset.id}/file`,
    // 有封面才给地址，前端在缺失时回退到占位图（避免直接拉原图/原视频）。
    coverUrl:
      asset.coverFilename || asset.coverEmbedded
        ? `/api/assets/local/${asset.id}/cover`
        : null,
    createdAt: asset.createdAt.toISOString(),
  };
}

/** 去掉用户文件名里的路径分隔符与控制字符，仅用于展示与上传时命名。 */
function safeName(name: string, mime: string): string {
  const cleaned = String(name || "upload").replace(/[\\/:*?"<>|\r\n]/g, "_").trim();
  if (!cleaned) return `upload.${MIME_EXTENSION[mime] || "bin"}`;
  return cleaned.includes(".") ? cleaned : `${cleaned}.${MIME_EXTENSION[mime] || "bin"}`;
}

/** 同一 sha256 的保存队列：并发上传同一文件时串行写盘，跑完即清理，避免长期占内存。 */
const saveChains = new Map<string, Promise<unknown>>();

function withSaveLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = saveChains.get(key) ?? Promise.resolve();
  const run = previous.then(fn, fn);
  const tail = run.then(
    () => undefined,
    () => undefined
  );
  saveChains.set(key, tail);
  void tail.then(() => {
    if (saveChains.get(key) === tail) saveChains.delete(key);
  });
  return run;
}

/**
 * 老记录、或临时转永久时还没有封面：有可用缩略图就补上。
 * 加密素材直接把原文重新加密写回（内容不变，只是多了内嵌封面）。
 */
async function attachMissingCover(
  asset: LocalAsset,
  body: Buffer,
  thumb: Buffer
): Promise<LocalAsset> {
  if (asset.coverFilename || asset.coverEmbedded) return asset;
  const root = asset.storageDir || (await getStorageDir());
  const file = await storedFile("asset", asset.filename, root);
  if (!file) return asset;

  if (asset.filename.endsWith(SKE_SUFFIX)) {
    const password = config.storagePassword;
    if (!password) return asset;
    const suffix = randomBytes(6).toString("hex");
    const tmpPlain = `${file.path}.${suffix}.plain`;
    const tmpEncrypted = `${file.path}.${suffix}.tmp`;
    const backup = `${file.path}.${suffix}.bak`;
    try {
      await writeFile(tmpPlain, body);
      await encryptFile(tmpPlain, tmpEncrypted, password, thumb);
      // 先把原文件改名备份，再换上新文件；任一步失败都能还原，避免素材丢文件。
      await rename(file.path, backup);
      try {
        await rename(tmpEncrypted, file.path);
      } catch (err) {
        await rename(backup, file.path).catch(() => {});
        throw err;
      }
      await rm(backup, { force: true }).catch(() => {});
    } catch (err) {
      await rm(tmpPlain, { force: true }).catch(() => {});
      await rm(tmpEncrypted, { force: true }).catch(() => {});
      logger.warn("assets.cover_attach_failed", {
        id: asset.id,
        message: err instanceof Error ? err.message : String(err),
      });
      return asset;
    }
    await rm(tmpPlain, { force: true }).catch(() => {});
    return prisma.localAsset.update({
      where: { id: asset.id },
      data: { coverEmbedded: true, coverFilename: null },
    });
  }

  const coverName = `${asset.sha256}.thumb.jpg`;
  try {
    await writeFile(storageFilePath("asset", coverName, root), thumb);
  } catch (err) {
    logger.warn("assets.cover_write_failed", {
      id: asset.id,
      message: err instanceof Error ? err.message : String(err),
    });
    return asset;
  }
  return prisma.localAsset.update({
    where: { id: asset.id },
    data: { coverFilename: coverName, coverEmbedded: false },
  });
}

/**
 * 保存一份上传文件到本地素材箱。
 * 按 sha256 去重：同一内容只落一份磁盘文件与一条记录；并发冲突时回读既有记录。
 */
export async function saveLocalAsset(input: SaveLocalAssetInput): Promise<LocalAsset> {
  const mime = String(input.mime || "").toLowerCase();
  if (!isAcceptedMime(mime)) throw errors.validation("仅支持 JPG / PNG / WebP / MP4 / MOV 格式");
  if (!input.buffer?.length) throw errors.validation("文件内容为空");
  const limit = isVideoMime(mime) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (input.buffer.length > limit) {
    throw errors.validation(`文件不能超过 ${isVideoMime(mime) ? 20 : 10}MB`);
  }
  // 不阻塞本次上传；回收失败也不影响保存。
  void sweepStaleTemporaryAssets().catch(() => {});

  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const temporary = Boolean(input.temporary);
  const kind = isVideoMime(mime) ? "video" : "image";
  // 同一内容串行保存：并发请求若同时写同一个临时文件，会互相删掉对方正在加密的文件。
  return withSaveLock(sha256, async () => {
    const existing = await prisma.localAsset.findUnique({ where: { sha256 } });
    if (existing) {
      let updated = existing;
      // 同一文件先以临时身份上传、后来又要求永久保存时，直接转正即可。
      if (existing.temporary && !temporary) {
        updated = await prisma.localAsset.update({
          where: { id: existing.id },
          data: { temporary: false },
        });
      }
      // 老素材或刚转正的素材可能还没有封面；这次带了可用缩略图就顺手补上。
      if (!temporary && !updated.coverFilename && !updated.coverEmbedded) {
        const thumb =
          kind === "image"
            ? await generateImageThumbnail(input.buffer).catch(() => null)
            : sanitizeThumbnail(input.thumbnail);
        if (thumb?.length) updated = await attachMissingCover(updated, input.buffer, thumb);
      }
      return updated;
    }

    const root = await getStorageDir();
    const plainName = `${sha256}.${MIME_EXTENSION[mime] || "bin"}`;
    const encrypt = await shouldEncryptStorage("asset");
    const password = encrypt ? config.storagePassword : null;
    if (encrypt && !password) {
      throw errors.internal("未配置 STORAGE_PASSWORD，无法加密素材");
    }
    // 加密时文件名也要按 SKE 规则生成，便于官方 CLI 还原。
    const filename = password ? `${await encryptName(plainName, password)}${SKE_SUFFIX}` : plainName;
    const target = storageFilePath("asset", filename, root);
    await mkdir(dirname(target), { recursive: true });
    // 临时文件带随机后缀：即使有多进程并发，也不会共用同一个半成品文件。
    const tmp = `${target}.${randomBytes(6).toString("hex")}.part`;
    await writeFile(tmp, input.buffer);

    // 缩略图只给永久素材生成：临时素材提交后就删，没必要花 CPU。
    // 图片由服务端 sharp 缩放；视频封面由上传端浏览器抓帧后随表单传入。
    const thumb = temporary
      ? null
      : kind === "image"
        ? await generateImageThumbnail(tmp).catch(() => null)
        : sanitizeThumbnail(input.thumbnail);
    const coverName = `${sha256}.thumb.jpg`;
    let coverFilename: string | null = null;
    let coverEmbedded = false;

    // Windows 下 rename 不能覆盖已有文件；同哈希的残留文件先清掉。
    await rm(target, { force: true });
    try {
      if (password) {
        // 加密时缩略图写进 SKE 信封，素材仍是单文件，删文件即删封面。
        await encryptFile(tmp, target, password, thumb);
        coverEmbedded = Boolean(thumb?.length);
      } else {
        await rename(tmp, target);
        if (thumb?.length) {
          const coverPath = storageFilePath("asset", coverName, root);
          try {
            await writeFile(coverPath, thumb);
            coverFilename = coverName;
          } catch (err) {
            // 封面写失败不影响素材本体。
            logger.warn("assets.cover_write_failed", {
              sha256,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    } catch (err) {
      await rm(target, { force: true }).catch(() => {});
      throw err;
    } finally {
      await rm(tmp, { force: true }).catch(() => {});
    }

    try {
      return await prisma.localAsset.create({
        data: {
          filename,
          originalName: safeName(input.originalName, mime),
          mime,
          kind,
          size: input.buffer.length,
          sha256,
          storageDir: root,
          temporary,
          coverFilename,
          coverEmbedded,
        },
      });
    } catch (err) {
      // 进程内已串行，这里只兜多进程写入的情况：已存在记录就复用，别删共用文件。
      const raced = await prisma.localAsset.findUnique({ where: { sha256 } });
      if (raced) return raced;
      await rm(target, { force: true }).catch(() => {});
      if (coverFilename) {
        await deleteStoredFile("asset", coverFilename, root).catch(() => {});
      }
      throw err;
    }
  });
}

/** 孤儿清理节流：进程内最多每小时扫一次，避免每次列表都扫表，也避免长期运行后残留不清理。 */
let orphanCleanup: Promise<void> | null = null;
let orphanCleanupAt = 0;
const ORPHAN_CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

/**
 * 清理纯垃圾 Asset：没有本地副本、没有任何历史任务引用、且上游记录已过保留期。
 * 还有任务引用的记录不能删，否则历史详情再也解析不出素材。
 * 同时清掉「任务记录和本地视频都不存在」的素材关联，这类关联已经没有任何展示入口。
 */
export function cleanupOrphanAssetsOnce(): Promise<void> {
  if (orphanCleanup) return orphanCleanup;
  if (Date.now() - orphanCleanupAt < ORPHAN_CLEANUP_INTERVAL_MS) return Promise.resolve();
  orphanCleanup = (async () => {
    const result = await prisma.asset.deleteMany({
      where: {
        localAssetId: null,
        remoteSyncedAt: { lt: new Date(Date.now() - UPSTREAM_ASSET_TTL_MS) },
        usedIn: { none: {} },
      },
    });
    if (result.count) logger.info("assets.prune_orphans", { count: result.count });

    const taskIds = (
      await prisma.taskLocalAsset.findMany({ select: { taskId: true }, distinct: ["taskId"] })
    ).map((row) => row.taskId);
    if (taskIds.length) {
      const [tasks, videos] = await Promise.all([
        prisma.task.findMany({ where: { id: { in: taskIds } }, select: { id: true } }),
        prisma.localVideo.findMany({ where: { taskId: { in: taskIds } }, select: { taskId: true } }),
      ]);
      const alive = new Set([...tasks.map((row) => row.id), ...videos.map((row) => row.taskId)]);
      const dangling = taskIds.filter((id) => !alive.has(id));
      if (dangling.length) {
        const links = await prisma.taskLocalAsset.deleteMany({
          where: { taskId: { in: dangling } },
        });
        logger.info("assets.prune_dangling_links", { count: links.count });
      }
    }

    // 同时回收过期的临时素材：提交失败或页面刷新后它们不再被任何草稿引用，
    // 只在「下次上传」时回收的话，长期不上传就会一直留在磁盘上。
    await sweepStaleTemporaryAssets();
  })()
    .catch((err) => {
      logger.warn("assets.prune_orphans_failed", {
        message: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      orphanCleanup = null;
      orphanCleanupAt = Date.now();
    });
  return orphanCleanup;
}

/** 素材箱列表：按类型过滤、按时间倒序分页，并汇总当前过滤条件下的数量与占用。 */
export async function listLocalAssets(
  kind: LocalAssetKindFilter,
  page = 1
): Promise<LocalAssetList> {
  void cleanupOrphanAssetsOnce();
  const where = kind === "all" ? { temporary: false } : { temporary: false, kind };
  const [rows, total, sum] = await Promise.all([
    prisma.localAsset.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * PAGE_SIZE,
      take: PAGE_SIZE,
    }),
    prisma.localAsset.count({ where }),
    prisma.localAsset.aggregate({ where, _sum: { size: true } }),
  ]);
  return {
    items: rows.map(toLocalAssetView),
    total,
    totalBytes: sum._sum.size ?? 0,
    page,
    hasMore: page * PAGE_SIZE < total,
  };
}

/** 读取素材明文；加密素材自动解密。文件接口与生成上传共用。 */
export async function readLocalAssetBuffer(
  record: Pick<LocalAsset, "filename" | "storageDir">
): Promise<Buffer> {
  const file = await storedFile("asset", record.filename, record.storageDir);
  if (!file) throw errors.notFound("素材文件不存在，可能已被删除");
  if (!record.filename.endsWith(SKE_SUFFIX)) return readFile(file.path);
  const password = config.storagePassword;
  if (!password) throw errors.internal("未配置 STORAGE_PASSWORD，无法读取加密素材");
  const { handle, prefix, key } = await openEncryptedFile(file.path, password);
  try {
    return await decryptAll(handle, prefix, key);
  } finally {
    await handle.close();
  }
}

/**
 * 定位素材磁盘文件；记录或文件缺失都按 404 处理。
 * 加密素材只返回密文路径与标记，由调用方按需解密（整段或 Range 分块）。
 */
export async function getLocalAssetFileInfo(id: string): Promise<{
  path: string;
  encrypted: boolean;
  /** 磁盘上的字节数；加密素材为密文长度，明文长度需解析文件头。 */
  size: number;
  mime: string;
  originalName: string;
}> {
  const record = await prisma.localAsset.findUnique({ where: { id } });
  if (!record) throw errors.notFound("素材不存在，可能已被删除");
  const file = await storedFile("asset", record.filename, record.storageDir);
  if (!file) throw errors.notFound("素材文件不存在，可能已被删除");
  return {
    path: file.path,
    encrypted: record.filename.endsWith(SKE_SUFFIX),
    size: file.size,
    mime: record.mime,
    originalName: record.originalName,
  };
}

/**
 * 定位素材缩略图：
 * - 明文素材是相邻的 `<sha256>.thumb.jpg`；
 * - 加密素材内嵌在 `.ske` 信封里，需要调用方解密。
 */
export async function getLocalAssetCoverInfo(id: string): Promise<{
  path: string;
  embedded: boolean;
  size: number | null;
}> {
  const record = await prisma.localAsset.findUnique({ where: { id } });
  if (!record) throw errors.notFound("素材不存在，可能已被删除");

  const thumbName = record.coverFilename;
  if (thumbName) {
    const file = await storedFile("asset", thumbName, record.storageDir);
    if (!file) throw errors.notFound("素材封面不存在");
    return { path: file.path, embedded: false, size: file.size };
  }
  if (record.coverEmbedded) {
    const file = await storedFile("asset", record.filename, record.storageDir);
    if (!file) throw errors.notFound("素材文件不存在，可能已被删除");
    return { path: file.path, embedded: true, size: null };
  }
  throw errors.notFound("该素材没有封面");
}

/**
 * 重命名素材：只改展示与下载用的文件名，扩展名跟随素材类型固定；
 * 磁盘文件按内容哈希命名，不随重命名移动或改名。
 */
export async function renameLocalAsset(id: string, name: string): Promise<LocalAssetView> {
  const record = await prisma.localAsset.findUnique({ where: { id } });
  if (!record) throw errors.notFound("素材不存在，可能已被删除");
  const base = String(name || "")
    .replace(/[\\/:*?"<>|\r\n]/g, "_")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .replace(/^\.+$/, "")
    .trim()
    .slice(0, 80)
    .trim();
  if (!base) throw errors.validation("文件名不能为空");
  const ext = MIME_EXTENSION[record.mime] || "bin";
  const updated = await prisma.localAsset.update({
    where: { id },
    data: { originalName: `${base}.${ext}` },
  });
  return toLocalAssetView(updated);
}

/** 删除单个本地素材：先删磁盘文件与封面，再删记录；不存在视为已删除。 */
export async function removeLocalAsset(id: string): Promise<{ deleted: boolean }> {
  const record = await prisma.localAsset.findUnique({ where: { id } });
  if (!record) return { deleted: false };
  await deleteStoredFile("asset", record.filename, record.storageDir);
  if (record.coverFilename) {
    await deleteStoredFile("asset", record.coverFilename, record.storageDir).catch(() => {});
  }
  // 用 deleteMany 而不是 delete：服务端与前端可能同时清理同一个临时素材。
  await prisma.localAsset.deleteMany({ where: { id } });
  return { deleted: true };
}

/** 批量删除本地素材，返回实际删除数量。 */
export async function removeLocalAssets(ids: string[]): Promise<{ deleted: number }> {
  let deleted = 0;
  for (const id of ids) {
    const result = await removeLocalAsset(id);
    if (result.deleted) deleted += 1;
  }
  return { deleted };
}

/** 清空素材箱：只删除永久素材，临时素材由生成流程自行清理。 */
export async function removeAllLocalAssets(): Promise<{ deleted: number }> {
  const rows = await prisma.localAsset.findMany({
    where: { temporary: false },
    select: { id: true },
  });
  return removeLocalAssets(rows.map((row) => row.id));
}

/** 待重试任务的提交快照仍引用这些临时素材时，不能提前删掉。 */
async function pendingTempAssetIds(ids: string[]): Promise<Set<string>> {
  const referenced = new Set<string>();
  if (!ids.length) return referenced;
  const tasks = await prisma.task.findMany({
    where: { submitInputs: { not: null } },
    select: { submitInputs: true },
  });
  const wanted = new Set(ids);
  for (const task of tasks) {
    if (!task.submitInputs) continue;
    try {
      const parsed = JSON.parse(task.submitInputs) as { localAssets?: Array<{ id: string }> };
      for (const item of parsed.localAssets ?? []) {
        if (wanted.has(item.id)) referenced.add(item.id);
      }
    } catch {
      // 快照损坏时忽略，不影响其它文件清理
    }
  }
  return referenced;
}

/** 只清理指定 ID 里的临时素材；永久素材、已删除的记录、待重试任务引用的文件都忽略。 */
export async function removeTemporaryLocalAssets(ids: string[]): Promise<{ deleted: number }> {
  const unique = [...new Set(ids)].filter(Boolean);
  if (!unique.length) return { deleted: 0 };
  const pending = await pendingTempAssetIds(unique);
  const removable = unique.filter((id) => !pending.has(id));
  if (!removable.length) return { deleted: 0 };
  const rows = await prisma.localAsset.findMany({
    where: { id: { in: removable }, temporary: true },
    select: { id: true },
  });
  return removeLocalAssets(rows.map((row) => row.id));
}

/** 回收超过保留时限的临时素材：草稿只存在内存里，刷新页面后这些文件就再也没人引用了。 */
async function sweepStaleTemporaryAssets(): Promise<void> {
  const rows = await prisma.localAsset.findMany({
    where: {
      temporary: true,
      createdAt: { lt: new Date(Date.now() - TEMP_ASSET_TTL_MS) },
    },
    select: { id: true },
  });
  if (!rows.length) return;
  const pending = await pendingTempAssetIds(rows.map((row) => row.id));
  const stale = rows.filter((row) => !pending.has(row.id));
  if (stale.length) await removeLocalAssets(stale.map((row) => row.id));
}

/**
 * 上游素材库直接选用的素材没有本地副本，选中当下补一份到素材箱，
 * 之后即使上游把文件删了，任务详情与复用仍然能看到、用到原素材。
 * 地址由调用方传入（上游直链不落库），「自动存盘 → 素材」关闭时按用户设置不落盘。
 */
export async function snapshotAssetLocally(asset: Asset, url: string | null): Promise<void> {
  if (asset.localAssetId || !url) return;
  if (!(await getKeepAssets())) return;

  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  // 上游记录的 mime 可能不准（素材库图片一律记成 png），优先用响应头
  const headerMime = (response.headers.get("content-type") || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const mime = isAcceptedMime(headerMime)
    ? headerMime
    : asset.mime || (asset.kind === "video" ? "video/mp4" : "image/png");
  const saved = await saveLocalAsset({
    buffer,
    mime,
    originalName: asset.filename,
  });
  // 并发下载同一素材时只认第一次写入
  await prisma.asset.updateMany({
    where: { id: asset.id, localAssetId: null },
    data: { localAssetId: saved.id },
  });
}

/**
 * 上游素材约 7 天后会被清理，remoteId 与直链随之失效。
 * 用本地记录的同步时间做确定性判断，不需要额外请求上游。
 */
export function isRemoteAssetFresh(asset: { remoteSyncedAt: Date }): boolean {
  return Date.now() - asset.remoteSyncedAt.getTime() < UPSTREAM_ASSET_REUSE_MS;
}

/** 由上游返回的剩余保留秒数反推同步时间，用于导入素材库时校准过期时间。 */
export function syncedAtFromRemaining(remainingSeconds: number | null | undefined): Date {
  if (remainingSeconds == null || !Number.isFinite(remainingSeconds)) return new Date();
  return new Date(Date.now() - Math.max(0, UPSTREAM_ASSET_TTL_MS - remainingSeconds * 1000));
}

/**
 * 生成任务时解析本地素材：同一账号上传过同一文件则复用上游 ID，
 * 否则读取磁盘文件现场上传并登记为 Asset。
 * 上游记录超过保留期时复用必然失败，此时用本地文件重新上传并更新 remoteId。
 *
 * 同一账号上传同一文件时进程内串行：两个任务并发提交同一素材时不重复上传，
 * 也避免在「查询未命中」后各自插入一条重复的 Asset。
 */
const resolvingAssets = new Map<string, Promise<Asset>>();

export function resolveLocalAssetForAccount(
  localAssetId: string,
  accountId: string,
  ctx: ProviderContext
): Promise<Asset> {
  const key = `${accountId}:${localAssetId}`;
  const running = resolvingAssets.get(key);
  if (running) return running;
  const task = uploadLocalAsset(localAssetId, accountId, ctx).finally(() => {
    resolvingAssets.delete(key);
  });
  resolvingAssets.set(key, task);
  return task;
}

async function uploadLocalAsset(
  localAssetId: string,
  accountId: string,
  ctx: ProviderContext
): Promise<Asset> {
  const local = await prisma.localAsset.findUnique({ where: { id: localAssetId } });
  if (!local) throw errors.validation("部分素材已被删除，请重新选择");

  const existing = await prisma.asset.findFirst({ where: { accountId, localAssetId } });
  if (existing && isRemoteAssetFresh(existing)) return existing;

  const buffer = await readLocalAssetBuffer(local);
  const uploaded = await getProvider().upload(ctx, {
    buffer,
    mime: local.mime,
    filename: local.originalName,
  });

  if (existing) {
    return prisma.asset.update({
      where: { id: existing.id },
      data: {
        remoteId: uploaded.remoteId,
        kind: uploaded.kind,
        mime: local.mime,
        filename: local.originalName,
        remoteSyncedAt: new Date(),
      },
    });
  }

  return prisma.asset.create({
    data: {
      remoteId: uploaded.remoteId,
      accountId,
      kind: uploaded.kind,
      mime: local.mime,
      filename: local.originalName,
      localAssetId: local.id,
    },
  });
}
