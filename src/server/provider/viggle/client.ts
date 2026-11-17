import { randomUUID } from "node:crypto";
import { config } from "../../config";
import { errors, AppError } from "../../errors";
import { logger } from "../../logger";
import type { ProviderContext } from "../types";
import { getSession } from "./session";
import { buildPayloadString, buildSignedHeaders } from "./signature";

export interface UpstreamEnvelope<T = Record<string, unknown>> {
  code: number;
  message?: string;
  reason?: string;
  data?: T;
}

export interface UpstreamResult<T = Record<string, unknown>> {
  status: number;
  data: UpstreamEnvelope<T>;
}

interface RequestInput {
  params?: Record<string, string | number>;
  body?: Record<string, unknown>;
  /** 原始 multipart body：此时签名载荷固定为空串 */
  rawBody?: Buffer | string;
  contentType?: string;
  timeoutSeconds?: number;
}

function buildQuery(params: Record<string, string | number>): string {
  const search = new URLSearchParams();
  for (const key of Object.keys(params).sort()) search.append(key, String(params[key]));
  const query = search.toString();
  return query ? "?" + query : "";
}

function parseBody(text: string): UpstreamEnvelope {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") throw new Error("not an object");
    return parsed as UpstreamEnvelope;
  } catch {
    throw new AppError("UPSTREAM_BLOCKED", "上游返回了非 JSON 响应，可能被防护策略拦截", 502, {
      raw: text.slice(0, 300),
    });
  }
}

/** 仅上传链路使用：网络、限流、服务端错误和防护响应值得换会话重试一次。 */
export function isRetryableUploadError(err: unknown): boolean {
  if (!(err instanceof AppError)) return false;
  if (err.code === "UPSTREAM_BLOCKED") return true;
  if (err.code !== "UPSTREAM_ERROR" || !err.details || typeof err.details !== "object") {
    return false;
  }
  const details = err.details as { transport?: unknown; status?: unknown };
  if (details.transport === true) return true;
  return (
    typeof details.status === "number" &&
    (details.status === 408 || details.status === 429 || details.status >= 500)
  );
}

/** 统一的签名 + 指纹会话 + 错误治理入口。 */
export async function viggleRequest<T = Record<string, unknown>>(
  ctx: ProviderContext,
  method: "GET" | "POST" | "DELETE",
  path: string,
  input: RequestInput = {}
): Promise<UpstreamResult<T>> {
  const params = input.params ?? {};
  const payload = input.rawBody
    ? ""
    : buildPayloadString(method, params, input.body);
  const bodyText = input.rawBody
    ? undefined
    : method === "GET"
      ? undefined
      : (payload || "{}");
  const headers = buildSignedHeaders({
    payload,
    baseUrl: config.viggle.baseUrl,
    userAgent: config.viggle.userAgent,
    salt: config.viggle.signSalt,
    token: ctx.token,
    extra: input.contentType ? { "content-type": input.contentType } : {},
  });
  if (method !== "GET" && !input.contentType) headers["content-type"] = "application/json";

  const url = config.viggle.baseUrl + path + (method === "GET" ? buildQuery(params) : "");
  const session = await getSession(ctx.accountId);

  let response;
  try {
    response = await session.request(method, url, {
      headers,
      body: input.rawBody ?? bodyText,
      timeout:
        input.timeoutSeconds ??
        (input.rawBody ? config.viggle.uploadTimeoutSeconds : config.viggle.requestTimeoutSeconds),
    });
  } catch (err) {
    logger.error("viggle.request.failed", { path, message: String(err) });
    throw errors.upstream("上游请求失败：" + (err instanceof Error ? err.message : "未知错误"), {
      transport: true,
    });
  }

  if (response.statusCode === 401) {
    throw errors.tokenInvalid();
  }

  const envelope = parseBody(response.text) as UpstreamEnvelope<T>;
  if (response.statusCode !== 200 || envelope.code !== 0) {
    const message =
      envelope.reason || envelope.message || `上游返回异常（HTTP ${response.statusCode} / code ${envelope.code}）`;
    throw errors.upstream(message, { code: envelope.code, status: response.statusCode });
  }
  return { status: response.statusCode, data: envelope };
}

/** multipart 上传的字段名固定为 file，签名载荷为空串。 */
export function buildMultipart(
  buffer: Buffer,
  filename: string,
  mime: string
): { boundary: string; body: Buffer } {
  const boundary = "----WebKitFormBoundary" + randomUUID().replace(/-/g, "").slice(0, 16);
  const safeName = filename.replace(/["\r\n]/g, "_");
  const head = Buffer.from(
    `--${boundary}\r\n` +
      `Content-Disposition: form-data; name="file"; filename="${safeName}"\r\n` +
      `Content-Type: ${mime}\r\n\r\n`,
    "utf8"
  );
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`, "utf8");
  return { boundary, body: Buffer.concat([head, buffer, tail]) };
}
