import type { NextRequest } from "next/server";
import { config, providerInfo } from "@/server/config";
import { ok, withErrors } from "@/server/errors";
import { getActiveProfile, listAccounts } from "@/server/services/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrors(async (_req: NextRequest) => {
  const [accounts, result] = await Promise.all([listAccounts(), getActiveProfile()]);
  return ok({
    provider: providerInfo(),
    activeAccount: accounts.find((a) => a.isActive) ?? null,
    profile: result.profile,
    stale: result.stale,
    pollIntervalMs: config.poll.intervalMs,
  });
});
