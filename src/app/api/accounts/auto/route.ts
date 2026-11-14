import type { NextRequest } from "next/server";
import { ok, withErrors } from "@/server/errors";
import { autoSelectAccount } from "@/server/services/accounts";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 自动模式：实时校验积分并激活一个够用的账号，供上传素材 / 生成前调用。 */
export const POST = withErrors(async (_req: NextRequest) => ok(await autoSelectAccount()));
