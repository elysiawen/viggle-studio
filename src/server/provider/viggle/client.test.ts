import { describe, expect, it } from "vitest";
import { errors } from "../../errors";
import { buildMultipart, isRetryableUploadError } from "./client";

describe("multipart 构造", () => {
  it("字段名为 file 且包含正确的 boundary 与文件名", () => {
    const { boundary, body } = buildMultipart(Buffer.from("hello"), "photo.jpg", "image/jpeg");
    const text = body.toString("utf8");
    expect(text).toContain(`--${boundary}`);
    expect(text).toContain('name="file"');
    expect(text).toContain('filename="photo.jpg"');
    expect(text).toContain("Content-Type: image/jpeg");
    expect(text).toContain("hello");
    expect(text.trimEnd().endsWith(`--${boundary}--`)).toBe(true);
  });
});

describe("上传重试判定", () => {
  it("允许网络、限流、服务端错误和防护响应重试", () => {
    expect(isRetryableUploadError(errors.upstream("连接中断", { transport: true }))).toBe(true);
    expect(isRetryableUploadError(errors.upstream("限流", { status: 429 }))).toBe(true);
    expect(isRetryableUploadError(errors.upstream("服务端错误", { status: 500 }))).toBe(true);
    expect(isRetryableUploadError(errors.blocked())).toBe(true);
  });

  it("不重试鉴权、业务错误和缺少素材 ID 的响应", () => {
    expect(isRetryableUploadError(errors.tokenInvalid())).toBe(false);
    expect(isRetryableUploadError(errors.upstream("参数错误", { status: 400 }))).toBe(false);
    expect(isRetryableUploadError(errors.upstream("上传成功但未返回素材 ID"))).toBe(false);
    expect(isRetryableUploadError(new Error("普通错误"))).toBe(false);
  });
});
