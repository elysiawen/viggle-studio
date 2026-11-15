import type { NextRequest } from "next/server";
import { errors, withErrors } from "@/server/errors";
import { getTaskRow } from "@/server/services/tasks";
import { respondWithCover } from "@/server/video-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * 任务封面。库里存的是上游预签名地址，会过期；
 * 这里每次请求重新签发后转发，前端统一指向本站地址。
 */
export const GET = withErrors(async (req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const task = await getTaskRow(id);
  if (task.status !== "succeeded") throw errors.badRequest("视频尚未生成完成");
  return respondWithCover(task, req);
});
