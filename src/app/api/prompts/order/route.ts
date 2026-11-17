import type { NextRequest } from "next/server";
import { ok, readJson, withErrors } from "@/server/errors";
import { reorderPromptPresets } from "@/server/services/prompt-presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 按拖动后的顺序整体保存预设排序。 */
export const PATCH = withErrors(async (req: NextRequest) => {
  const body = await readJson(req);
  await reorderPromptPresets(body.ids);
  return ok({ reordered: true });
});
