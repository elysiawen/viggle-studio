import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Asset, LocalAsset } from "@prisma/client";
import {
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MIME_EXTENSION,
  isAcceptedMime,
  isVideoMime,
} from "@/lib/constants";
import type { LocalAssetView } from "@/lib/types";
import { config } from "../config";
import { decryptAll, encryptFile, encryptName, openEncryptedFile, SKE_SUFFIX } from "../crypto/ske";
import { prisma } from "../db";
import { errors } from "../errors";
import { getProvider } from "../provider";
import type { ProviderContext } from "../provider/types";
import { getStorageDir, shouldEncryptStorage } from "./storage-settings";
import { deleteStoredFile, storageFilePath, storedFile } from "./video-store";

/** 素材箱列表每页条数。 */
const PAGE_SIZE = 30;

export interface SaveLocalAssetInput {
  buffer: Buffer;
  mime: string;
  originalName: string;
}

export interface LocalAssetList {
  items: LocalAssetView[];
  total: number;
  totalBytes: number;
  page: number;
  hasMore: boolean;
}

export type LocalAssetKindFilter = "all" | "image" | "video";

function toView(asset: LocalAsset): LocalAssetView {
  return {
    id: asset.id,
    filename: asset.filename,
    originalName: asset.originalName,
    kind: asset.kind as LocalAssetView["kind"],
    mime: asset.mime,
    size: asset.size,
    url: `/api/assets/local/${asset.id}/file`,
    createdAt: asset.createdAt.toISOString(),
  };
}

/** 去掉用户文件名里的路径分隔符与控制字符，仅用于展示与上传时命名。 */
function safeName(name: string, mime: string): string {
  const cleaned = String(name || "upload").replace(/[\\/:*?"<>|\r\n]/g, "_").trim();
  if (!cleaned) return `upload.${MIME_EXTENSION[mime] || "bin"}`;
  return cleaned.includes(".") ? cleaned : `${cleaned}.${MIME_EXTENSION[mime] || "bin"}`;
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

  const sha256 = createHash("sha256").update(input.buffer).digest("hex");
  const existing = await prisma.localAsset.findUnique({ where: { sha256 } });
  if (existing) return existing;

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
  const tmp = `${target}.part`;
  await writeFile(tmp, input.buffer);
  // Windows 下 rename 不能覆盖已有文件；同哈希的残留文件先清掉。
  await rm(target, { force: true });
  try {
    if (password) await encryptFile(tmp, target, password);
    else await rename(tmp, target);
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
        kind: isVideoMime(mime) ? "video" : "image",
        size: input.buffer.length,
        sha256,
        storageDir: root,
      },
    });
  } catch (err) {
    // 并发上传同一文件时可能同时通过 findUnique，唯一约束冲突后回读即可。
    const raced = await prisma.localAsset.findUnique({ where: { sha256 } });
    if (raced) return raced;
    await rm(target, { force: true }).catch(() => {});
    throw err;
  }
}

/** 素材箱列表：按类型过滤、按时间倒序分页，并汇总当前过滤条件下的数量与占用。 */
export async function listLocalAssets(
  kind: LocalAssetKindFilter,
  page = 1
): Promise<LocalAssetList> {
  const where = kind === "all" ? {} : { kind };
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
    items: rows.map(toView),
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

/** 定位素材磁盘文件；记录或文件缺失都按 404 处理。加密素材直接返回解密后的内容。 */
export async function getLocalAssetFileInfo(id: string): Promise<{
  path?: string;
  buffer?: Buffer;
  size: number;
  mime: string;
  originalName: string;
}> {
  const record = await prisma.localAsset.findUnique({ where: { id } });
  if (!record) throw errors.notFound("素材不存在，可能已被删除");
  const file = await storedFile("asset", record.filename, record.storageDir);
  if (!file) throw errors.notFound("素材文件不存在，可能已被删除");
  if (record.filename.endsWith(SKE_SUFFIX)) {
    const buffer = await readLocalAssetBuffer(record);
    return { buffer, size: buffer.length, mime: record.mime, originalName: record.originalName };
  }
  return { path: file.path, size: file.size, mime: record.mime, originalName: record.originalName };
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
  return toView(updated);
}

/** 删除单个本地素材：先删磁盘文件，再删记录；不存在视为已删除。 */
export async function removeLocalAsset(id: string): Promise<{ deleted: boolean }> {
  const record = await prisma.localAsset.findUnique({ where: { id } });
  if (!record) return { deleted: false };
  await deleteStoredFile("asset", record.filename, record.storageDir);
  await prisma.localAsset.delete({ where: { id } });
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

/** 清空素材箱：删除全部本地素材文件与记录。 */
export async function removeAllLocalAssets(): Promise<{ deleted: number }> {
  const rows = await prisma.localAsset.findMany({ select: { id: true } });
  return removeLocalAssets(rows.map((row) => row.id));
}

/**
 * 生成任务时解析本地素材：同一账号上传过同一文件则复用上游 ID，
 * 否则读取磁盘文件现场上传并登记为 Asset。
 */
export async function resolveLocalAssetForAccount(
  localAssetId: string,
  accountId: string,
  ctx: ProviderContext
): Promise<Asset> {
  const local = await prisma.localAsset.findUnique({ where: { id: localAssetId } });
  if (!local) throw errors.validation("部分素材已被删除，请重新选择");

  const existing = await prisma.asset.findFirst({ where: { accountId, localAssetId } });
  if (existing) return existing;

  const buffer = await readLocalAssetBuffer(local);
  const uploaded = await getProvider().upload(ctx, {
    buffer,
    mime: local.mime,
    filename: local.originalName,
  });

  return prisma.asset.create({
    data: {
      remoteId: uploaded.remoteId,
      accountId,
      kind: uploaded.kind,
      mime: local.mime,
      filename: local.originalName,
      url: uploaded.url,
      coverUrl: uploaded.coverUrl,
      localAssetId: local.id,
    },
  });
}
