import { NextResponse } from "next/server";
import { AUTH_COOKIE } from "@/lib/auth";
import { withErrors } from "@/server/errors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = withErrors(async () => {
  const response = NextResponse.json({ ok: true });
  response.cookies.set({
    name: AUTH_COOKIE,
    value: "",
    httpOnly: true,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
  return response;
});
