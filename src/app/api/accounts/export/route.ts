import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import { exportAccounts } from "@/server/services/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 导出账号：format=cookie-profile 或 format=studio。 */
export const GET = withErrors(async (req: NextRequest) => {
  const format = req.nextUrl.searchParams.get("format") ?? "studio";
  return ok(await exportAccounts(format));
});
