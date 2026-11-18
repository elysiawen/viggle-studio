import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { config } from "@/server/config";
import { decryptThumbnail, openEncryptedFile } from "@/server/crypto/ske";
import { errors, withErrors } from "@/server/errors";
import { getLocalAssetCoverInfo } from "@/server/services/local-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * 素材缩略图：加密素材从 SKE 信封里解密内嵌封面，明文素材直接流式返回。
 * 体积只有几十 KB，弱网下列表不再因为加载原图/原视频而卡死。
 */
export const GET = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const cover = await getLocalAssetCoverInfo(id);

  const headers = new Headers();
  headers.set("Content-Type", "image/jpeg");
  // 内容由 sha256 / 加密 token 决定，不会变，可长期缓存。
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  headers.set("X-Content-Type-Options", "nosniff");

  if (!cover.embedded) {
    if (cover.size) headers.set("Content-Length", String(cover.size));
    const body = Readable.toWeb(createReadStream(cover.path)) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers });
  }

  const password = config.storagePassword;
  if (!password) throw errors.internal("未配置 STORAGE_PASSWORD，无法读取加密素材");
  const { handle, prefix, key } = await openEncryptedFile(cover.path, password);
  try {
    const data = decryptThumbnail(prefix, key);
    if (!data) throw errors.notFound("该素材没有封面");
    headers.set("Content-Length", String(data.length));
    return new Response(new Uint8Array(data), { status: 200, headers });
  } finally {
    await handle.close().catch(() => {});
  }
});
