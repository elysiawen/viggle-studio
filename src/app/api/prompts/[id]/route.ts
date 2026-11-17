import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import { deletePromptPreset } from "@/server/services/prompt-presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 删除一条提示词预设。 */
export const DELETE = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  await deletePromptPreset(id);
  return ok({ deleted: true });
});
