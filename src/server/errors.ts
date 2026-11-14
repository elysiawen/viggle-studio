import { logger } from "./logger";

export type ErrorCode =
  | "BAD_REQUEST"
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "NO_ACTIVE_ACCOUNT"
  | "TOKEN_INVALID"
  | "UPSTREAM_ERROR"
  | "UPSTREAM_BLOCKED"
  | "PROVIDER_UNAVAILABLE"
  | "CONFLICT"
  | "UNAUTHORIZED"
  | "INTERNAL_ERROR";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
    public readonly status = 400,
    public readonly details?: unknown
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const errors = {
  badRequest: (message: string, details?: unknown) =>
    new AppError("BAD_REQUEST", message, 400, details),
  validation: (message: string, details?: unknown) =>
    new AppError("VALIDATION_ERROR", message, 400, details),
  notFound: (message = "资源不存在") => new AppError("NOT_FOUND", message, 404),
  noActiveAccount: () =>
    new AppError("NO_ACTIVE_ACCOUNT", "请先在「账号管理」中添加并激活一个账号", 409),
  unauthorized: (message = "请先输入访问密码") =>
    new AppError("UNAUTHORIZED", message, 401),
  tokenInvalid: (message = "登录态已失效，请更新该账号的 JWT") =>
    new AppError("TOKEN_INVALID", message, 401),
  upstream: (message: string, details?: unknown) =>
    new AppError("UPSTREAM_ERROR", message, 502, details),
  blocked: (message = "上游返回了非 JSON 响应，可能被防护策略拦截") =>
    new AppError("UPSTREAM_BLOCKED", message, 502),
  unavailable: (message: string) => new AppError("PROVIDER_UNAVAILABLE", message, 503),
  internal: (message = "服务内部错误") => new AppError("INTERNAL_ERROR", message, 500),
};

function isSensitive(message: string): boolean {
  return /eyJ[A-Za-z0-9_-]{10,}/.test(message);
}

export function errorResponse(err: unknown): Response {
  if (err instanceof AppError) {
    if (err.status >= 500) logger.error("request.failed", { code: err.code, message: err.message });
    return Response.json(
      { ok: false, error: { code: err.code, message: err.message, details: err.details } },
      { status: err.status }
    );
  }
  const raw = err instanceof Error ? err.message : String(err);
  // 绝不把可能含有凭据的错误原文回传给浏览器
  const message = isSensitive(raw) ? "请求失败（已隐藏可能含凭据的原始错误）" : raw;
  logger.error("request.unhandled", { message });
  return Response.json(
    { ok: false, error: { code: "INTERNAL_ERROR", message } },
    { status: 500 }
  );
}

/** 统一包裹 Route Handler：集中错误处理 + 结构化日志。 */
export function withErrors<Args extends unknown[]>(
  handler: (...args: Args) => Promise<Response>
): (...args: Args) => Promise<Response> {
  return async (...args: Args): Promise<Response> => {
    try {
      return await handler(...args);
    } catch (err) {
      return errorResponse(err);
    }
  };
}

export function ok<T>(data: T, init?: ResponseInit): Response {
  return Response.json({ ok: true, data }, init);
}

/** 批量校验允许不带请求体（表示全部账号），此时按空对象处理。 */
export async function readOptionalJson(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw errors.badRequest("请求体必须是 JSON 对象");
    }
    return value as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw errors.badRequest("请求体不是合法的 JSON");
  }
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw errors.badRequest("请求体必须是 JSON 对象");
    }
    return value as Record<string, unknown>;
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw errors.badRequest("请求体不是合法的 JSON");
  }
}
