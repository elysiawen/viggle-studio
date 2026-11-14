import { describe, expect, it } from "vitest";
import { buildPayloadString, buildSignedHeaders, signRequest, userAgentTail } from "./signature";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36";
const SALT = "qdsnfXVFGS1dVCYTju";

describe("Viggle 请求签名", () => {
  it("复现接口文档中的真实抓包验证样例", () => {
    const t = "1794654203375";
    const u = "f37a084c-89fb-453a-b3dd-e0c07b83753e";
    const body = '{"duration":5,"modelType":7,"qualityType":0,"resolution":"768p"}';
    expect(signRequest({ t, u, payload: body, userAgent: UA, salt: SALT })).toBe(
      "42bcdec03d9597dcaabc49082eb980c5"
    );
  });

  it("UA 末段为 537.36", () => {
    expect(userAgentTail(UA)).toBe("537.36");
  });

  it("GET 参数按键升序拼接为 key=[value]，无分隔符", () => {
    expect(buildPayloadString("GET", { pageSize: 8, page: 1 })).toBe("page=[1]pageSize=[8]");
    expect(buildPayloadString("GET", {})).toBe("");
  });

  it("POST 载荷与实际发送 JSON 完全一致", () => {
    const body = { aspectRatio: "16:9", duration: 5 };
    expect(buildPayloadString("POST", {}, body)).toBe(JSON.stringify(body));
    expect(buildPayloadString("POST", {}, undefined)).toBe("");
  });

  it("buildSignedHeaders 用固定 t/u 可复现，并包含必需的请求头", () => {
    const payload = '{"a":1}';
    const headers = buildSignedHeaders({
      payload,
      baseUrl: "https://viggle.ai",
      userAgent: UA,
      salt: SALT,
      token: "jwt-value",
      now: 1794654203375,
      uuid: "f37a084c-89fb-453a-b3dd-e0c07b83753e",
    });
    expect(headers.s).toBe(signRequest({ t: "1794654203375", u: "f37a084c-89fb-453a-b3dd-e0c07b83753e", payload, userAgent: UA, salt: SALT }));
    expect(headers.authorization).toBe("Bearer jwt-value");
    expect(headers.origin).toBe("https://viggle.ai");
    expect(headers.referer).toBe("https://viggle.ai/meme/app/video-gen");
    expect(headers["user-agent"]).toBe(UA);
  });

  it("登录类请求可以不带 Authorization", () => {
    const headers = buildSignedHeaders({
      payload: "{}",
      baseUrl: "https://viggle.ai",
      userAgent: UA,
      salt: SALT,
      token: "",
      withAuth: false,
    });
    expect(headers.authorization).toBeUndefined();
    expect(headers.s).toHaveLength(32);
  });
});
