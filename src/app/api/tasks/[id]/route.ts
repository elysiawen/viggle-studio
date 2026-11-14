import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import { deleteTask, getTask } from "@/server/services/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

export const GET = withErrors(async (_req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  return ok({ task: await getTask(id) });
});

export const DELETE = withErrors(async (req: NextRequest, ctx: Context) => {
  const { id } = await ctx.params;
  const deleteRemote = req.nextUrl.searchParams.get("remote") === "1";
  await deleteTask(id, { deleteRemote });
  return ok({ id });
});
