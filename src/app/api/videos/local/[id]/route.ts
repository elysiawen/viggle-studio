import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import {
  getLocalVideoFileInfo,
  removeLocalVideo,
  saveTaskToLocal,
  storagePassword,
} from "@/server/services/local-videos";
import {
  createDecryptStream,
  decryptRange,
  openEncryptedFile,
  plaintextSize,
} from "@/server/crypto/ske";

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
 * 播放 / 下载本地落盘的视频。
 * 未加密直接流式返回；加密文件按需解密（Range 只解开覆盖到的分块）。
 */
export const GET = withErrors(async (req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const file = await getLocalVideoFileInfo(id);

  const download = req.nextUrl.searchParams.get("download") === "1";
  const headers = new Headers();
  headers.set("Content-Type", "video/mp4");
  headers.set("Accept-Ranges", "bytes");
  headers.set("Cache-Control", "private, max-age=3600");
  headers.set(
    "Content-Disposition",
    `${download ? "attachment" : "inline"}; filename="viggle_${id.slice(0, 8)}.mp4"`
  );

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

  // 加密文件：明文长度需要解析头部才能知道
  const { handle, prefix, key } = await openEncryptedFile(file.path, storagePassword());
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

/** 手动保存：把这条已完成任务的视频与封面一起落盘，已保存过则直接返回。 */
export const POST = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  return ok(await saveTaskToLocal(id));
});

/** 只删本地文件：历史记录、上游视频都保留。 */
export const DELETE = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  await removeLocalVideo(id);
  return ok({ taskId: id });
});
