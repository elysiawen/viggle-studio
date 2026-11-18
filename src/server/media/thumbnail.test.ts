import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { generateImageThumbnail } from "./thumbnail";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "viggle-thumb-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("素材缩略图（sharp）", () => {
  it("大图缩到最长边 512，输出 JPEG", async () => {
    const src = join(dir, "big.jpg");
    await writeFile(
      src,
      await sharp({
        create: { width: 1200, height: 800, channels: 3, background: "#445566" },
      })
        .jpeg()
        .toBuffer()
    );

    const thumb = await generateImageThumbnail(src);
    expect(thumb).not.toBeNull();
    expect(thumb![0]).toBe(0xff);
    expect(thumb![1]).toBe(0xd8);

    const meta = await sharp(thumb!).metadata();
    expect(meta.width).toBe(512);
    expect(meta.height).toBe(341);
    expect(meta.format).toBe("jpeg");
  });

  it("小图不生成缩略图，避免比原图还大", async () => {
    const src = join(dir, "small.png");
    await writeFile(
      src,
      await sharp({
        create: { width: 320, height: 200, channels: 3, background: "#112233" },
      })
        .png()
        .toBuffer()
    );

    expect(await generateImageThumbnail(src)).toBeNull();
  });

  it("损坏的图片返回 null 而不是抛错", async () => {
    const src = join(dir, "broken.jpg");
    await writeFile(src, Buffer.from("not an image"));
    expect(await generateImageThumbnail(src)).toBeNull();
  });

  it("也接受内存 Buffer（去重补封面时用）", async () => {
    const source = await sharp({
      create: { width: 900, height: 600, channels: 3, background: "#223344" },
    })
      .jpeg()
      .toBuffer();

    const thumb = await generateImageThumbnail(source);
    expect(thumb).not.toBeNull();
    const meta = await sharp(thumb!).metadata();
    expect(meta.width).toBe(512);
  });
});
