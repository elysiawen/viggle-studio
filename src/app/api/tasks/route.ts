import type { NextRequest } from "next/server";
import { ok, readJson, withErrors } from "@/server/errors";
import { createTask, listTasks } from "@/server/services/tasks";
import { ensureTaskManager } from "@/server/task-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrors(async (req: NextRequest) => {
  ensureTaskManager();
  const params = req.nextUrl.searchParams;
  const accountId = params.get("accountId") || undefined;
  const limit = Number(params.get("limit") || 50);
  return ok({ tasks: await listTasks({ accountId, limit: Number.isFinite(limit) ? limit : 50 }) });
});

export const POST = withErrors(async (req: NextRequest) => {
  ensureTaskManager();
  const task = await createTask(await readJson(req));
  return ok({ task }, { status: 201 });
});
