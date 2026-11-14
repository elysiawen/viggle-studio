import type { NextRequest } from "next/server";
import { ok, readJson, withErrors } from "@/server/errors";
import { deleteAccount, updateAccount } from "@/server/services/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const PATCH = withErrors(async (req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const account = await updateAccount(id, await readJson(req));
  return ok({ account });
});

export const DELETE = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  return ok(await deleteAccount(id));
});
