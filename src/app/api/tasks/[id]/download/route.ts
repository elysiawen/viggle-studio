import type { NextRequest } from "next/server";
import { errors, withErrors } from "@/server/errors";
import { getProvider } from "@/server/provider";
import { getAccountCredentials } from "@/server/services/accounts";
import { getTaskRow } from "@/server/services/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = withErrors(async (req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const task = await getTaskRow(id);
  if (task.status !== "succeeded") throw errors.badRequest("视频尚未生成完成");

  const { account, token } = await getAccountCredentials(task.accountId);
  const stream = await getProvider().getVideoStream(
    { accountId: account.id, token },
    { taskId: task.id, remoteId: task.remoteId, videoUrl: task.videoUrl },
    { range: req.headers.get("range") ?? undefined, signal: req.signal }
  );
  if (!stream) throw errors.notFound("视频源暂不可用，预签名地址可能已过期");

  const headers = new Headers();
  headers.set("Content-Type", stream.contentType);
  headers.set("Content-Disposition", `attachment; filename="${stream.filename}"`);
  headers.set("Cache-Control", "private, max-age=3600");
  if (stream.contentLength !== undefined) {
    headers.set("Content-Length", String(stream.contentLength));
  }
  if (stream.contentRange) headers.set("Content-Range", stream.contentRange);
  if (stream.acceptRanges) headers.set("Accept-Ranges", stream.acceptRanges);

  return new Response(stream.body, { status: stream.statusCode ?? 200, headers });
});
