import { NextResponse, type NextRequest } from "next/server";
import { errors, withErrors } from "@/server/errors";
import { getProvider } from "@/server/provider";
import { getAccountCredentials } from "@/server/services/accounts";
import { getTaskRow } from "@/server/services/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * 跳转到上游的原始播放地址。
 *
 * 库里存的 videoUrl 是预签名地址，放久了会返回 ExpiredRequest，
 * 所以「原始地址」按钮指向这里，点开时现签发一个新地址再 302。
 */
export const GET = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const task = await getTaskRow(id);
  if (task.status !== "succeeded") throw errors.badRequest("视频尚未生成完成");

  const { account, token } = await getAccountCredentials(task.accountId);
  const url = await getProvider().getVideoUrl(
    { accountId: account.id, token },
    { taskId: task.id, remoteId: task.remoteId, videoUrl: task.videoUrl }
  );
  if (!url) throw errors.notFound("上游未返回视频地址，可能已被删除");

  return NextResponse.redirect(url, {
    status: 302,
    headers: { "Cache-Control": "no-store" },
  });
});
