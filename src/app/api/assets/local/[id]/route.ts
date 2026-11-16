import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import { removeLocalAsset, renameLocalAsset } from "@/server/services/local-assets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 重命名本地素材（仅改显示名，磁盘文件不变）。 */
export const PATCH = withErrors(async (req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  return ok(await renameLocalAsset(id, String(body.name || "")));
});

/** 删除单个本地素材。 */
export const DELETE = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  return ok(await removeLocalAsset(id));
});
