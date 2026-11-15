import type { NextRequest } from "next/server";
import { errors, withErrors } from "@/server/errors";
import { getTaskRow } from "@/server/services/tasks";
import { respondWithVideo } from "@/server/video-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * 预览播放用的视频地址。任务详情里保存的是上游预签名 URL，会过期，
 * 所以 `<video>` 一律指向这里，由服务端每次重新签发后转发。
 */
export const GET = withErrors(async (req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const task = await getTaskRow(id);
  if (task.status !== "succeeded") throw errors.badRequest("视频尚未生成完成");
  return respondWithVideo(task, req, "inline");
});
