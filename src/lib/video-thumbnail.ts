/** 视频封面在上传前由浏览器抓帧生成，服务端不再依赖 ffmpeg/ffprobe。 */

const MAX_SIDE = 512;
const MAX_BYTES = 512 * 1024;
/** 取第 30% 进度的帧；太短的视频用中点。 */
const SEEK_RATIO = 0.3;
const TIMEOUT_MS = 6_000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

/**
 * 从本地文件抓一帧生成 512px 以内的 JPEG。
 * 浏览器解不了的编码（如 HEVC）或损坏文件返回 null，由界面显示占位图标。
 */
export async function captureVideoThumbnail(file: File): Promise<Blob | null> {
  if (typeof document === "undefined") return null;

  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "metadata";
  video.muted = true;
  video.playsInline = true;

  try {
    video.src = url;
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onloadedmetadata = () => resolve();
        video.onerror = () => reject(new Error("video_load_failed"));
      }),
      TIMEOUT_MS
    );

    const duration = Number.isFinite(video.duration) ? video.duration : 0;
    const ratioSeek = duration > 1 ? duration * SEEK_RATIO : duration / 2;
    // 首帧常常是黑场，至少往前挪 50ms；同时避免 seek 到片尾之外。
    const target =
      duration > 0
        ? Math.min(Math.max(ratioSeek, 0.05), Math.max(0.05, duration - 0.05))
        : 0.05;

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        video.onseeked = () => resolve();
        video.onerror = () => reject(new Error("video_seek_failed"));
        video.currentTime = target;
      }),
      TIMEOUT_MS
    );

    const width = video.videoWidth;
    const height = video.videoHeight;
    if (!width || !height) return null;

    const scale = Math.min(1, MAX_SIDE / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.8)
    );
    if (!blob || blob.size > MAX_BYTES) return null;
    return blob;
  } catch {
    return null;
  } finally {
    URL.revokeObjectURL(url);
    video.removeAttribute("src");
    video.load();
  }
}
