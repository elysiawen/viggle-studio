import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import { getRenewCredentials } from "@/server/services/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

/**
 * 供客户机上的续期助手读取该账号的明文登录凭据。
 * 依赖全局登录态（middleware 拦截 /api/*），且只应在内网使用。
 */
export const GET = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  return ok(await getRenewCredentials(id));
});
