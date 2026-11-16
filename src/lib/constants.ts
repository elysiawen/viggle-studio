import type { GenerationMode } from "./types";

/** 免费档可用参数（与《Viggle视频生成接口文档.md》第 6 节一致）。 */
export const ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"] as const;
export const DURATIONS = [5] as const;
export const RESOLUTIONS = ["768p", "480p"] as const;
export const QUALITY_TYPES = [{ value: 0, label: "Flash · 免费" }] as const;

export const MAX_REFERENCE_MEDIA = 5;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;
export const VIDEO_MIME_TYPES = ["video/mp4", "video/quicktime"] as const;
export const ACCEPTED_MIME_TYPES = [...IMAGE_MIME_TYPES, ...VIDEO_MIME_TYPES] as const;

export const MIME_EXTENSION: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "video/mp4": "mp4",
  "video/quicktime": "mov",
};

export const FREE_TIER = {
  duration: 5,
  resolutions: RESOLUTIONS,
  qualityType: 0,
  creditsPerGeneration: 2,
  enhanceType: 1,
} as const;

/** 免费积分每天北京时间 08:00（即 UTC 00:00）刷新，返回下一次刷新时刻。 */
export function nextFreeCreditResetAt(now: Date = new Date()): Date {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0, 0)
  );
}

/** 积分已确认不足、且还没到下次刷新时刻的账号，无需再请求上游校验。 */
export function isCreditsExhausted(
  creditsResetAt: Date | null | undefined,
  now: Date = new Date()
): boolean {
  return !!creditsResetAt && creditsResetAt.getTime() > now.getTime();
}

export const MODE_META: Record<
  GenerationMode,
  { label: string; short: string; description: string; requiresUpload: boolean }
> = {
  references: {
    label: "参考素材",
    short: "References",
    description: "上传 1~5 张图片或视频作为参考，控制角色与画面风格",
    requiresUpload: true,
  },
  frames: {
    label: "首尾帧",
    short: "Start & End Frames",
    description: "首帧必填、尾帧可选，约束视频的起始与结束画面",
    requiresUpload: true,
  },
  text: {
    label: "纯文本",
    short: "Text Only",
    description: "仅用提示词生成，无需上传任何素材",
    requiresUpload: false,
  },
};

export const STATUS_META: Record<string, { label: string; tone: string }> = {
  queued: { label: "排队中", tone: "neutral" },
  running: { label: "生成中", tone: "running" },
  succeeded: { label: "已完成", tone: "done" },
  failed: { label: "失败", tone: "fail" },
};

export function isImageMime(mime: string): boolean {
  return (IMAGE_MIME_TYPES as readonly string[]).includes(mime);
}

export function isVideoMime(mime: string): boolean {
  return (VIDEO_MIME_TYPES as readonly string[]).includes(mime);
}

export function isAcceptedMime(mime: string): boolean {
  return (ACCEPTED_MIME_TYPES as readonly string[]).includes(mime);
}
