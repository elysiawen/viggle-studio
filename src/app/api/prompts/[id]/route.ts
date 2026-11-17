import type { NextRequest } from "next/server";
import { ok, readJson, withErrors } from "@/server/errors";
import { deletePromptPreset, updatePromptPreset } from "@/server/services/prompt-presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/** 编辑一条提示词预设。 */
export const PATCH = withErrors(async (req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const body = await readJson(req);
  return ok(await updatePromptPreset(id, { title: body.title, content: body.content }));
});

/** 删除一条提示词预设。 */
export const DELETE = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  await deletePromptPreset(id);
  return ok({ deleted: true });
});
