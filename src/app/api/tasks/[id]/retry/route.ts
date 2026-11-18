import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import { retryTask } from "@/server/services/tasks";
import { ensureTaskManager } from "@/server/task-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 重试素材上传阶段失败的任务：重新检查账号容量后，后台继续上传并提交。 */
export const POST = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  ensureTaskManager();
  return ok({ task: await retryTask(id) });
});
