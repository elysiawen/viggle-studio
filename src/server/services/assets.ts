import type { Asset } from "@prisma/client";
import type { AssetView, LibraryAssetView } from "@/lib/types";
import {
  isAcceptedMime,
  isVideoMime,
  MAX_IMAGE_BYTES,
  MAX_VIDEO_BYTES,
  MIME_EXTENSION,
} from "@/lib/constants";
import { errors } from "../errors";
import { prisma } from "../db";
import { getProvider } from "../provider";
import { getActiveCredentials } from "./accounts";
import { saveLocalAsset } from "./local-assets";
import { getKeepAssets } from "./storage-settings";

export interface UploadInput {
  buffer: Buffer;
  mime: string;
  filename: string;
}

function toView(asset: Asset): AssetView {
  return {
    id: asset.id,
    remoteId: asset.remoteId,
    accountId: asset.accountId,
    kind: asset.kind as AssetView["kind"],
    mime: asset.mime,
    filename: asset.filename,
    url: asset.url,
    coverUrl: asset.coverUrl,
    createdAt: asset.createdAt.toISOString(),
  };
}

export async function uploadAsset(input: UploadInput): Promise<AssetView> {
  const mime = String(input.mime || "").toLowerCase();
  if (!isAcceptedMime(mime)) {
    throw errors.validation("仅支持 JPG / PNG / WebP / MP4 / MOV 格式");
  }
  const limit = isVideoMime(mime) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (!input.buffer?.length) throw errors.validation("文件内容为空");
  if (input.buffer.length > limit) {
    throw errors.validation(`文件不能超过 ${isVideoMime(mime) ? 20 : 10}MB`);
  }

  const original = String(input.filename || "upload").replace(/[\\/:*?"<>|\r\n]/g, "_");
  const ext = MIME_EXTENSION[mime] || "bin";
  const filename = original.includes(".") ? original : `${original}.${ext}`;

  // 先落本地素材箱：即使上游上传失败，用户仍能在素材箱里找到这份文件。
  // 设置页可以关闭自动存档，此时只上传上游、不保留本地副本。
  const local = (await getKeepAssets())
    ? await saveLocalAsset({ buffer: input.buffer, mime, originalName: filename })
    : null;

  const { ctx, account } = await getActiveCredentials();
  const uploaded = await getProvider().upload(ctx, { buffer: input.buffer, mime, filename });

  const asset = await prisma.asset.create({
    data: {
      remoteId: uploaded.remoteId,
      accountId: account.id,
      kind: uploaded.kind,
      mime,
      filename,
      url: uploaded.url,
      coverUrl: uploaded.coverUrl,
      localAssetId: local?.id ?? null,
    },
  });
  return toView(asset);
}

/** 每页条数；返回满页即认为可能还有更多。 */
const LIBRARY_PAGE_SIZE = 30;
export const LIBRARY_MAX_PAGES = 10;

/** 拉取当前激活账号在上游素材库里的图片 / 视频（只读，不落库）。 */
export async function listLibraryAssets(
  kind: "image" | "video",
  page = 1
): Promise<{ items: LibraryAssetView[]; hasMore: boolean; page: number }> {
  const { ctx } = await getActiveCredentials();
  const items = await getProvider().listLibraryAssets(ctx, {
    kind,
    page,
    pageSize: LIBRARY_PAGE_SIZE,
  });
  return {
    items,
    hasMore: page < LIBRARY_MAX_PAGES && items.length >= LIBRARY_PAGE_SIZE,
    page,
  };
}

/**
 * 把素材箱里选中的上游素材登记到本地 Asset 表，之后生成流程与「本地上传」完全一致。
 * 前端只传 ID 和已加载到的最大页码，URL / 类型一律由服务端重新从素材库取，避免伪造；
 * 选中项可能来自多个分页，因此依次拉取直到找齐或到底。
 */
export async function importLibraryAssets(
  kind: "image" | "video",
  ids: string[],
  maxPage = 1
): Promise<AssetView[]> {
  if (!ids.length) return [];
  const { ctx, account } = await getActiveCredentials();
  const lastPage = Math.min(Math.max(maxPage, 1), LIBRARY_MAX_PAGES);
  const byId = new Map<string, LibraryAssetView>();
  for (let page = 1; page <= lastPage; page += 1) {
    const rows = await getProvider().listLibraryAssets(ctx, {
      kind,
      page,
      pageSize: LIBRARY_PAGE_SIZE,
    });
    rows.forEach((item) => byId.set(item.id, item));
    if (rows.length < LIBRARY_PAGE_SIZE || ids.every((id) => byId.has(id))) break;
  }
  if (ids.some((id) => !byId.has(id))) {
    throw errors.validation("部分素材已不在素材库中，请刷新素材箱后重试");
  }

  const result: AssetView[] = [];
  for (const id of ids) {
    const item = byId.get(id)!;
    const existing = await prisma.asset.findFirst({
      where: { accountId: account.id, remoteId: id },
    });
    if (existing) {
      result.push(toView(existing));
      continue;
    }
    const created = await prisma.asset.create({
      data: {
        remoteId: id,
        accountId: account.id,
        kind: item.kind,
        mime: item.kind === "video" ? "video/mp4" : "image/png",
        filename: item.name || `${item.kind}-${id.slice(0, 8)}`,
        url: item.url,
        coverUrl: item.previewUrl || item.coverUrl,
      },
    });
    result.push(toView(created));
  }
  return result;
}
