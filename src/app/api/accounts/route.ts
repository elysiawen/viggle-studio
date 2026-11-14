import type { NextRequest } from "next/server";
import { ok, readJson, withErrors } from "@/server/errors";
import { createAccount, listAccounts } from "@/server/services/accounts";
import { ensureTaskManager } from "@/server/task-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrors(async (_req: NextRequest) => {
  ensureTaskManager();
  return ok({ accounts: await listAccounts() });
});

export const POST = withErrors(async (req: NextRequest) => {
  const account = await createAccount(await readJson(req));
  return ok({ account }, { status: 201 });
});
