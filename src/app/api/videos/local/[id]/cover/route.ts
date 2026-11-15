import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { decryptAll, openEncryptedFile } from "@/server/crypto/ske";
import { withErrors } from "@/server/errors";
import { getLocalCoverFileInfo, storagePassword } from "@/server/services/local-videos";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 加密后文件名是 SKE token，没有扩展名，只能按魔术字节判断图片类型。 */
function sniffImageType(data: Buffer): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8) return "image/jpeg";
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (
    data.length >= 12 &&
    data.subarray(0, 4).toString("ascii") === "RIFF" &&
    data.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return "application/octet-stream";
}

/** 本地封面：未加密直接流式返回，加密文件整份解密后返回（体积很小）。 */
export const GET = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const cover = await getLocalCoverFileInfo(id);

  const headers = new Headers();
  headers.set("Cache-Control", "private, max-age=86400");

  if (!cover.encrypted) {
    headers.set("Content-Type", cover.contentType ?? "application/octet-stream");
    headers.set("Content-Length", String(cover.size));
    const body = Readable.toWeb(createReadStream(cover.path)) as unknown as ReadableStream<Uint8Array>;
    return new Response(body, { status: 200, headers });
  }

  const { handle, prefix, key } = await openEncryptedFile(cover.path, storagePassword());
  let data: Buffer;
  try {
    data = await decryptAll(handle, prefix, key);
  } finally {
    await handle.close().catch(() => {});
  }
  headers.set("Content-Type", sniffImageType(data));
  headers.set("Content-Length", String(data.length));
  return new Response(new Uint8Array(data), { status: 200, headers });
});
