import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import { reuseTaskAssets } from "@/server/services/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 把这条任务用过的素材复制进本地素材箱，供工作台复用提示词与参数。 */
export const POST = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  return ok(await reuseTaskAssets(id));
});
