import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import { removeLocalAsset } from "@/server/services/local-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 删除单个本地素材。 */
export const DELETE = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  return ok(await removeLocalAsset(id));
});
