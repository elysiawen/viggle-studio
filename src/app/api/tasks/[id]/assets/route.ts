import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import { listTaskAssets } from "@/server/services/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 任务详情里展示用到的素材（只读，不下载）。 */
export const GET = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  return ok({ assets: await listTaskAssets(id) });
});
