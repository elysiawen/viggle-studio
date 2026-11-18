import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { config } from "@/server/config";
import {
  createDecryptStream,
  decryptRange,
  openEncryptedFile,
  plaintextSize,
} from "@/server/crypto/ske";
import { errors, withErrors } from "@/server/errors";
import { getLocalAssetFileInfo } from "@/server/services/local-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 解析单段 Range 请求；无法解析时返回 null，按整段返回。 */
function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return null;

  let start: number;
  let end: number;
  if (!rawStart) {
    // bytes=-N：最后 N 字节
    const suffix = Number(rawEnd);
    if (!Number.isFinite(suffix) || suffix <= 0) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : size - 1;
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  if (start > end || start >= size) return null;
  return { start, end: Math.min(end, size - 1) };
}

/**
 * 本地素材文件：按内容哈希命名，可长期缓存。
 * 支持 Range，视频预览可以边下边播、直接拖动进度；加密文件按需解密覆盖到的分块。
 */
export const GET = withErrors(async (req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const file = await getLocalAssetFileInfo(id);

  const headers = new Headers();
  headers.set("Content-Type", file.mime || "application/octet-stream");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  if (req.nextUrl.searchParams.get("download") === "1") {
    headers.set(
      "Content-Disposition",
      `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName)}`
    );
  }

  if (!file.encrypted) {
    const range = parseRange(req.headers.get("range"), file.size);
    if (range) {
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
      headers.set("Content-Length", String(range.end - range.start + 1));
      const body = Readable.toWeb(
        createReadStream(file.path, { start: range.start, end: range.end })
      ) as unknown as ReadableStream<Uint8Array>;
      return new Response(body, { status: 206, headers });
    }
    headers.set("Content-Length", String(file.size));
    const body = Readable.toWeb(createReadStream(file.path)) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers });
  }

  // 加密素材：只解密请求覆盖到的分块，避免每次预览都把整份文件读进内存。
  const password = config.storagePassword;
  if (!password) throw errors.internal("未配置 STORAGE_PASSWORD，无法读取加密素材");
  const { handle, prefix, key } = await openEncryptedFile(file.path, password);
  try {
    const { size: cipherSize } = await handle.stat();
    const total = plaintextSize(cipherSize, prefix.bodyOffset);
    const range = parseRange(req.headers.get("range"), total);
    if (range) {
      const data = await decryptRange(handle, prefix, key, range.start, range.end);
      await handle.close();
      headers.set("Content-Range", `bytes ${range.start}-${range.end}/${total}`);
      headers.set("Content-Length", String(data.length));
      return new Response(new Uint8Array(data), { status: 206, headers });
    }
    headers.set("Content-Length", String(total));
    const stream = createDecryptStream(handle, prefix, key);
    return new Response(Readable.toWeb(stream) as unknown as ReadableStream<Uint8Array>, {
      status: 200,
      headers,
    });
  } catch (err) {
    await handle.close().catch(() => {});
    throw err;
  }
});
