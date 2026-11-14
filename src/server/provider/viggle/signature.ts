import { createHash, randomUUID } from "node:crypto";

/** navigator.userAgent.split("/").pop()，Chrome 下为 "537.36"。 */
export function userAgentTail(userAgent: string): string {
  return userAgent.split("/").pop() ?? "";
}

/**
 * 签名载荷规则（与接口文档第 3 节一致）：
 * - GET：键升序，key=[value] 直接拼接，无分隔符
 * - POST：与实际发送的 JSON 字符串完全一致（键顺序敏感）
 * - multipart：空串
 */
export function buildPayloadString(
  method: string,
  params: Record<string, string | number>,
  body?: unknown
): string {
  if (method.toUpperCase() === "GET") {
    return Object.keys(params)
      .sort()
      .map((key) => `${key}=[${params[key]}]`)
      .join("");
  }
  return body === undefined ? "" : JSON.stringify(body);
}

export function signRequest(input: {
  t: string;
  u: string;
  payload: string;
  userAgent: string;
  salt: string;
}): string {
  return createHash("md5")
    .update(
      input.t + input.u + userAgentTail(input.userAgent) + input.payload + input.salt,
      "utf8"
    )
    .digest("hex");
}

export function buildSignedHeaders(input: {
  payload: string;
  baseUrl: string;
  userAgent: string;
  salt: string;
  token: string;
  withAuth?: boolean;
  extra?: Record<string, string>;
  now?: number;
  uuid?: string;
}): Record<string, string> {
  const t = String(input.now ?? Date.now());
  const u = input.uuid ?? randomUUID();
  const headers: Record<string, string> = {
    t,
    u,
    s: signRequest({
      t,
      u,
      payload: input.payload,
      userAgent: input.userAgent,
      salt: input.salt,
    }),
    origin: input.baseUrl,
    referer: `${input.baseUrl}/meme/app/video-gen`,
    "user-agent": input.userAgent,
    accept: "*/*",
    "accept-language": "zh-CN,zh;q=0.9",
    ...input.extra,
  };
  if (input.withAuth !== false) headers.authorization = `Bearer ${input.token}`;
  return headers;
}
