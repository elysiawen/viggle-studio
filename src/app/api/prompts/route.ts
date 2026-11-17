import type { NextRequest } from "next/server";
import { ok, readJson, withErrors } from "@/server/errors";
import { createPromptPreset, listPromptPresets } from "@/server/services/prompt-presets";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 列出已保存的提示词预设。 */
export const GET = withErrors(async () => {
  return ok({ presets: await listPromptPresets() });
});

/** 保存当前提示词为预设。 */
export const POST = withErrors(async (req: NextRequest) => {
  const body = await readJson(req);
  return ok(await createPromptPreset({ title: body.title, content: body.content }));
});
