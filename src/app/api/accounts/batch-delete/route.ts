import type { NextRequest } from "next/server";
import { ok, readJson, withErrors } from "@/server/errors";
import { deleteAccounts } from "@/server/services/accounts";
import { deleteAccountsSchema, parse } from "@/server/validation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 一次删除多选账号，连带其任务与素材记录（由数据库外键级联）。 */
export const POST = withErrors(async (req: NextRequest) => {
  const { ids } = parse(deleteAccountsSchema, await readJson(req));
  return ok(await deleteAccounts(ids));
});
