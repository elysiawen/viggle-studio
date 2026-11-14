import type { NextRequest } from "next/server";
import { providerInfo } from "@/server/config";
import { prisma } from "@/server/db";
import { ok, withErrors } from "@/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = withErrors(async (_req: NextRequest) => {
  await prisma.$queryRaw`SELECT 1`;
  return ok({
    status: "ok",
    provider: providerInfo(),
    database: "sqlite",
    time: new Date().toISOString(),
  });
});
