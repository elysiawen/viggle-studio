import type { NextRequest } from "next/server";
import { ok, readOptionalJson, withErrors } from "@/server/errors";
import { verifyAllAccounts } from "@/server/services/accounts";
import { parse, verifyAccountsSchema } from "@/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 逐批校验账号的登录态与剩余积分；带 ids 时只校验多选账号，只读、不消耗生成额度。 */
export const POST = withErrors(async (req: NextRequest) => {
  const { ids } = parse(verifyAccountsSchema, await readOptionalJson(req));
  return ok(await verifyAllAccounts(ids));
});
