import { describe, expect, it } from "vitest";
import { buildMultipart } from "./client";

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
