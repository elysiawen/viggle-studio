import type { NextRequest } from "next/server";
import { errors, withErrors } from "@/server/errors";
import { getTaskRow } from "@/server/services/tasks";
import { respondWithVideo } from "@/server/video-response";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = withErrors(async (req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const task = await getTaskRow(id);
  if (task.status !== "succeeded") throw errors.badRequest("视频尚未生成完成");
  return respondWithVideo(task, req, "attachment");
});
