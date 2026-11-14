import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import { resumeTask } from "@/server/services/tasks";
import { ensureTaskManager } from "@/server/task-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 恢复被误判失败、但上游仍在生成的任务，避免重复消耗额度。 */
export const POST = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  ensureTaskManager();
  return ok({ task: await resumeTask(id) });
});
