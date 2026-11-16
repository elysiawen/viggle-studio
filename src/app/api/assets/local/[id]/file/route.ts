import { createReadStream } from "node:fs";
import { Readable } from "node:stream";
import type { NextRequest } from "next/server";
import { withErrors } from "@/server/errors";
import { getLocalAssetFileInfo } from "@/server/services/local-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 本地素材文件：按内容哈希命名，可长期缓存。 */
export const GET = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const file = await getLocalAssetFileInfo(id);

  const headers = new Headers();
  headers.set("Content-Type", file.mime || "application/octet-stream");
  headers.set("Content-Length", String(file.size));
  headers.set("Cache-Control", "private, max-age=31536000, immutable");
  // 加密素材在服务端解密后整份返回；明文素材仍然流式读取。
  const body: BodyInit = file.buffer
    ? new Uint8Array(file.buffer)
    : (Readable.toWeb(createReadStream(file.path!)) as unknown as ReadableStream<Uint8Array>);
  return new Response(body, { status: 200, headers });
});
