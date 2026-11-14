import type { NextRequest } from "next/server";
import { ok, readJson, withErrors } from "@/server/errors";
import { deleteTasks } from "@/server/services/tasks";
import { deleteTasksSchema, parse } from "@/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 批量删除历史记录；remote 为 true 时逐条删除 Viggle 上游任务与视频。 */
export const POST = withErrors(async (req: NextRequest) => {
  const { ids, remote } = parse(deleteTasksSchema, await readJson(req));
  return ok(await deleteTasks(ids, { deleteRemote: remote }));
});
