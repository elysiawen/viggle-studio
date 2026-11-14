import type { NextRequest } from "next/server";
import { NextResponse } from "next/server";
import { z } from "zod";
import { AUTH_COOKIE, accessPassword, authSecret, createAuthToken } from "@/lib/auth";
import { errors, readJson, withErrors } from "@/server/errors";
import { parse } from "@/server/validation";

const loginSchema = z.object({ password: z.string().min(1, "请输入密码").max(200) });

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 校验访问密码并写入 HttpOnly cookie；未配置 ACCESS_PASSWORD 时直接放行。 */
export const POST = withErrors(async (req: NextRequest) => {
  const configured = accessPassword();
  if (!configured) return NextResponse.json({ ok: true, enabled: false });

  const { password } = parse(loginSchema, await readJson(req));
  const expected = await createAuthToken(configured, authSecret());
  const actual = await createAuthToken(password, authSecret());
  if (actual !== expected) throw errors.unauthorized("密码错误");

  const response = NextResponse.json({ ok: true, enabled: true });
  response.cookies.set({
    name: AUTH_COOKIE,
    value: expected,
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 30,
  });
  return response;
});
