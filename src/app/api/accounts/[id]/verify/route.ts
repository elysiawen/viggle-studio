import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import { verifyAccount } from "@/server/services/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const POST = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  return ok({ profile: await verifyAccount(id) });
});
