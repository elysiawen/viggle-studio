import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { AUTH_COOKIE, accessPassword, authSecret, createAuthToken } from "@/lib/auth";
import { withErrors } from "@/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 返回是否启用访问密码，以及当前请求是否已登录。 */
export const GET = withErrors(async (req: NextRequest) => {
  const password = accessPassword();
  if (!password) {
    return NextResponse.json({ ok: true, enabled: false, authenticated: true });
  }
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  const expected = await createAuthToken(password, authSecret());
  return NextResponse.json({ ok: true, enabled: true, authenticated: token === expected });
});
