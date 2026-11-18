import sharp from "sharp";
import { logger } from "../logger";

const log = logger.child("thumbnail");

/** 缩略图最长边；与 SKE 参考实现（Pillow / ffmpeg）保持一致。 */
const MAX_SIDE = 512;
/** 输出上限，正常 512px JPEG 只有几十 KB。 */
const MAX_OUTPUT_BYTES = 512 * 1024;
/** 同时最多处理两张图，避免批量上传打满 CPU。 */
const MAX_CONCURRENT = 2;

let active = 0;
const waiters: Array<() => void> = [];

async function withSlot<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((resolve) => waiters.push(resolve));
  active += 1;
  try {
    return await fn();
  } finally {
    active -= 1;
    waiters.shift()?.();
  }
}

/**
 * 为图片素材生成小尺寸 JPEG 预览，失败或无必要时返回 null。
 *
 * - sharp（libvips）解码，不启子进程，自动按 EXIF 方向摆正。
 * - 最长边超过 512 才缩放，小图直接跳过，避免缩略图比原图还大。
 * - 视频封面由上传端浏览器抓帧后随表单传入，服务端不再依赖 ffmpeg。
 */
export async function generateImageThumbnail(file: string | Buffer): Promise<Buffer | null> {
  return withSlot(async () => {
    try {
      const source = sharp(file, { failOn: "none" });
      const meta = await source.metadata();
      const width = meta.width ?? 0;
      const height = meta.height ?? 0;
      if (width && height && Math.max(width, height) <= MAX_SIDE) return null;

      const data = await source
        .rotate()
        .resize({
          width: MAX_SIDE,
          height: MAX_SIDE,
          fit: "inside",
          withoutEnlargement: true,
        })
        .jpeg({ quality: 80, mozjpeg: true })
        .toBuffer();
      if (data.length < 128 || data.length > MAX_OUTPUT_BYTES) return null;
      return data;
    } catch (err) {
      log.warn("generate_failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  });
}
