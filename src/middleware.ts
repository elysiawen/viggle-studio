import { NextResponse, type NextRequest } from "next/server";
import { AUTH_COOKIE, accessPassword, authSecret, createAuthToken } from "@/lib/auth";

/** 登录相关接口本身不需要鉴权。 */
const PUBLIC_PATHS = new Set(["/api/auth/login", "/api/auth/logout", "/api/auth/status"]);

export async function middleware(req: NextRequest) {
  const password = accessPassword();
  if (!password) {
    // 未设置访问密码时不做任何限制，登录页直接回首页。
    if (req.nextUrl.pathname === "/login") {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  }

  const { pathname, search } = req.nextUrl;
  const token = req.cookies.get(AUTH_COOKIE)?.value;
  const expected = await createAuthToken(password, authSecret());
  const authenticated = Boolean(token && token === expected);

  if (pathname === "/login") {
    return authenticated ? NextResponse.redirect(new URL("/", req.url)) : NextResponse.next();
  }
  if (PUBLIC_PATHS.has(pathname) || authenticated) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { ok: false, error: { code: "UNAUTHORIZED", message: "请输入访问密码后再访问" } },
      { status: 401 }
    );
  }

  const loginUrl = new URL("/login", req.url);
  if (pathname !== "/") loginUrl.searchParams.set("next", `${pathname}${search}`);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
