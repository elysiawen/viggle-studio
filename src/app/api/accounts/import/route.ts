import type { NextRequest } from "next/server";
import { ok, readJson, withErrors } from "@/server/errors";
import { importAccounts } from "@/server/services/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 批量导入 Cookie / localStorage 导出文件里解析出的 Viggle 账号。 */
export const POST = withErrors(async (req: NextRequest) => {
  return ok({ result: await importAccounts(await readJson(req)) }, { status: 201 });
});
