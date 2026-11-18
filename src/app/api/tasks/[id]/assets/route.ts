import type { NextRequest } from "next/server";
import { ok, readJson, withErrors } from "@/server/errors";
import { addTaskManualAssets, listTaskAssets } from "@/server/services/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 任务详情里展示用到的素材（只读，不下载）。 */
export const GET = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  return ok({ assets: await listTaskAssets(id) });
});

/** 手动把本地素材箱里的文件关联到这条历史任务。 */
export const POST = withErrors(async (req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  const ids = Array.isArray(body.localAssetIds)
    ? body.localAssetIds.filter((value): value is string => typeof value === "string")
    : [];
  return ok({ assets: await addTaskManualAssets(id, ids) });
});
