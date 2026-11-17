import { FREE_TIER, isVideoMime } from "@/lib/constants";
import type { LibraryAssetView, UserProfile } from "@/lib/types";
import { errors } from "../../errors";
import { logger } from "../../logger";
import type {
  CoverStream,
  DownloadOptions,
  DownloadTarget,
  GenerationPayload,
  ProviderContext,
  RemoteTaskState,
  UploadedAsset,
  UploadPayload,
  VideoProvider,
  VideoStream,
} from "../types";
import {
  buildMultipart,
  isRetryableUploadError,
  viggleRequest,
  type UpstreamResult,
} from "./client";
import { closeSession } from "./session";

function profileFromUser(data: Record<string, unknown> | undefined): UserProfile {
  const d = data ?? {};
  const num = (key: string) => (typeof d[key] === "number" ? (d[key] as number) : 0);
  const str = (key: string) => (typeof d[key] === "string" ? (d[key] as string) : "");
  return {
    nickname: str("nickname"),
    email: str("email"),
    freeCredits: num("freeCredits"),
    subscribeCredits: num("subscribeCredits"),
    planCredits: num("planCredits"),
    purchasedCredits: num("purchasedCredits"),
    remainingFreeMiniMaxVideoGenCount: num("remainingFreeMiniMaxVideoGenCount"),
  };
}

function estimateProgress(startedAt: Date): number {
  const elapsed = Date.now() - startedAt.getTime();
  return Math.min(95, Math.max(5, Math.round((elapsed / 35_000) * 100)));
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * 上游判定失败（审核不通过、退款等）时，status 可能仍是 2 或 0，
 * 真正的原因写在 gen.errorMessage 里，不能只看状态码。
 */
function failureReason(data: Record<string, unknown>): string {
  const gen = asRecord(data.gen);
  const candidates = [
    gen.errorMessage,
    gen.error,
    gen.failReason,
    gen.failureReason,
    data.errorMessage,
    data.error,
    data.failReason,
    data.failureReason,
  ];
  return candidates.map(asText).find(Boolean) ?? "";
}

/** 上游返回的播放地址是预签名 URL，带有效期；用之前必须重新签发一次。 */
async function fetchFreshVideoUrl(
  ctx: ProviderContext,
  remoteId: string | null
): Promise<string | null> {
  if (!remoteId) return null;
  const r = await viggleRequest<{ url?: string }>(
    ctx,
    "GET",
    `/api/asset/video/${encodeURIComponent(remoteId)}`
  );
  return r.data.data?.url ?? null;
}

/** 封面走同一个详情接口，同样是预签名地址，同样会过期。 */
async function fetchFreshCoverUrl(
  ctx: ProviderContext,
  remoteId: string | null
): Promise<string | null> {
  if (!remoteId) return null;
  const r = await viggleRequest<{ coverURL?: string }>(
    ctx,
    "GET",
    `/api/asset/video/${encodeURIComponent(remoteId)}`
  );
  return r.data.data?.coverURL ?? null;
}

export class ViggleProvider implements VideoProvider {
  readonly id = "viggle" as const;

  async verify(ctx: ProviderContext): Promise<UserProfile> {
    const r = await viggleRequest(ctx, "GET", "/api/user");
    return profileFromUser(r.data.data);
  }

  async upload(ctx: ProviderContext, payload: UploadPayload): Promise<UploadedAsset> {
    const { boundary, body } = buildMultipart(payload.buffer, payload.filename, payload.mime);
    const endpoint = isVideoMime(payload.mime) ? "/api/asset/video" : "/api/asset/image";
    const send = async (): Promise<UploadedAsset> => {
      const r = await viggleRequest<{
        id?: string;
        url?: string;
        coverURL?: string;
      }>(ctx, "POST", endpoint, {
        rawBody: body,
        contentType: `multipart/form-data; boundary=${boundary}`,
      });
      const d = r.data.data ?? {};
      if (!d.id) throw errors.upstream("上传成功但未返回素材 ID");
      return {
        remoteId: d.id,
        url: d.url ?? null,
        coverUrl: d.coverURL ?? null,
        kind: isVideoMime(payload.mime) ? "video" : "image",
      };
    };

    try {
      return await send();
    } catch (err) {
      if (!isRetryableUploadError(err)) throw err;
      logger.warn("viggle.upload.retry", {
        accountId: ctx.accountId,
        message: err instanceof Error ? err.message : String(err),
      });
      // 首次请求可能留下半失效连接或防护 Cookie；重试时使用全新会话。
      closeSession(ctx.accountId);
      return send();
    }
  }

  async create(ctx: ProviderContext, payload: GenerationPayload): Promise<{ remoteId: string }> {
    // 键顺序与接口文档保持一致；签名载荷就是这段 JSON 本身。
    const base = {
      aspectRatio: payload.aspectRatio,
      duration: payload.duration,
      resolution: payload.resolution,
      prompt: payload.prompt,
      qualityType: payload.qualityType,
      enhanceType: FREE_TIER.enhanceType,
    };

    let path: string;
    let body: Record<string, unknown>;
    switch (payload.mode) {
      case "references":
        if (!payload.referenceMedia.length) {
          throw errors.validation("参考素材模式至少需要一个素材");
        }
        path = "/api/asset/video/gen/mini-max/reference-media";
        body = { ...base, referenceMedia: payload.referenceMedia };
        break;
      case "frames":
        if (!payload.startFrameId) throw errors.validation("首尾帧模式需要先上传首帧");
        path = "/api/asset/video/gen/mini-max/first-last-frame";
        body = {
          ...base,
          firstFrameImageAssetID: payload.startFrameId,
          ...(payload.endFrameId ? { lastFrameImageAssetID: payload.endFrameId } : {}),
        };
        break;
      case "text":
        path = "/api/asset/video/gen/mini-max/first-last-frame";
        body = base;
        break;
      default:
        throw errors.validation("不支持的生成模式");
    }

    const r = await viggleRequest<{ id?: string }>(ctx, "POST", path, { body });
    const id = r.data.data?.id;
    if (!id) throw errors.upstream("创建任务成功但未返回任务 ID");
    return { remoteId: id };
  }

  async poll(
    ctx: ProviderContext,
    remoteId: string,
    startedAt: Date
  ): Promise<RemoteTaskState> {
    let r: UpstreamResult;
    try {
      r = await viggleRequest(ctx, "GET", `/api/asset/video/${encodeURIComponent(remoteId)}`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 审核失败 / 退款后上游会移除视频记录，轮询接口直接返回「not found」。
      // 刚提交时也可能只是尚未同步，给一个短宽限期再判定失败。
      if (/not\s*found|不存在|已删除/i.test(message)) {
        const waiting = Date.now() - startedAt.getTime() < 60_000;
        return {
          remoteStatus: -1,
          status: waiting ? "running" : "failed",
          stage: waiting ? "等待上游同步" : "生成失败",
          progress: estimateProgress(startedAt),
          videoUrl: null,
          coverUrl: null,
          errorMessage: waiting
            ? null
            : `上游已无该任务记录：${message}（可能审核未通过或额度已退还）`,
        };
      }
      throw err;
    }
    const d = asRecord(r.data.data);
    const rawStatus = d.status;
    const parsedStatus = Number(rawStatus);
    const remoteStatus = Number.isFinite(parsedStatus) ? parsedStatus : -1;
    const url = asText(d.url);
    const coverUrl = asText(d.coverURL);
    const progress = estimateProgress(startedAt);
    const failure = failureReason(d);
    const statusText = asText(rawStatus).toLowerCase();
    const failedByText = ["failed", "failure", "error", "cancelled", "canceled", "refunded", "rejected"].includes(statusText);

    if (remoteStatus === 0 && url) {
      return {
        remoteStatus,
        status: "succeeded",
        stage: "视频已就绪",
        progress: 100,
        videoUrl: url,
        coverUrl: coverUrl || null,
        errorMessage: null,
      };
    }

    // 上游失败时状态码未必变化，失败原因优先于任何「生成中」判断。
    if (failure || failedByText) {
      return {
        remoteStatus,
        status: "failed",
        stage: "生成失败",
        progress,
        videoUrl: null,
        coverUrl: null,
        errorMessage: failure || `上游返回失败状态 ${String(rawStatus ?? "未知")}`,
      };
    }

    // 文档：status=2 为生成中；字段缺失时保守等待，交由服务端超时兜底。
    if (remoteStatus === 2 || rawStatus === undefined || rawStatus === null) {
      return {
        remoteStatus,
        status: "running",
        stage: progress < 30 ? "排队中" : "模型生成中",
        progress,
        videoUrl: null,
        coverUrl: null,
        errorMessage: null,
      };
    }

    // status=0 按文档必然带视频地址；没有地址说明审核未通过或额度已退还。
    if (remoteStatus === 0) {
      return {
        remoteStatus,
        status: "failed",
        stage: "生成失败",
        progress,
        videoUrl: null,
        coverUrl: null,
        errorMessage: "上游已结束任务但未返回视频地址（可能审核未通过或额度已退还）",
      };
    }

    return {
      remoteStatus,
      status: "failed",
      stage: "生成失败",
      progress,
      videoUrl: null,
      coverUrl: null,
      errorMessage: `上游返回异常状态 ${String(rawStatus)}`,
    };
  }

  async deleteRemoteTask(ctx: ProviderContext, remoteId: string): Promise<void> {
    // 文档 12 节实测：/api/video-task 只删任务索引、视频仍在；
    // 真正删除视频要用 /api/asset/video，它会联动清除生成历史与素材库。
    await viggleRequest(ctx, "DELETE", "/api/asset/video", { body: { id: remoteId } });

    // 删除是幂等的：传不存在的 ID 也返回 code:0，不能只看返回值就删本地记录。
    // 回查一次，确认上游确实查不到该视频，否则保留本地记录让用户重试。
    let stillExists = false;
    try {
      const r = await viggleRequest(ctx, "GET", `/api/asset/video/${encodeURIComponent(remoteId)}`);
      const d = asRecord(r.data.data);
      stillExists = Boolean(asText(d.id) || asText(d.url));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/not[\s_-]*found|不存在|已删除/i.test(message)) return;
      // 网络、鉴权、被拦截等错误不能当成「已删除」。
      throw err;
    }
    if (stillExists) {
      throw errors.upstream(
        "Viggle 上游仍可查到该视频，删除可能未生效；本地记录已保留，请稍后重试或取消勾选仅删除本地记录。"
      );
    }
  }

  async listLibraryAssets(
    ctx: ProviderContext,
    query: { kind: "image" | "video"; page?: number; pageSize?: number }
  ): Promise<LibraryAssetView[]> {
    const kind = query.kind;
    const path = kind === "video" ? "/api/asset/video" : "/api/asset/image";
    // sourceType=1 图片、type=1 视频都只取「上传的素材」，排除工具生成的中间产物。
    const params: Record<string, string | number> = {
      page: query.page ?? 1,
      pageSize: query.pageSize ?? 50,
      ...(kind === "video" ? { type: 1 } : { sourceType: 1 }),
    };
    const r = await viggleRequest<unknown[]>(ctx, "GET", path, { params });
    const rows = Array.isArray(r.data.data) ? r.data.data : [];
    return rows
      .map((row) => {
        const d = asRecord(row);
        const id = asText(d.id);
        const url = asText(d.url) || null;
        const coverUrl = asText(d.coverURL) || null;
        return {
          id,
          kind,
          name: asText(d.name) || id.slice(0, 8),
          previewUrl: asText(d.middleURL) || coverUrl || url,
          url,
          coverUrl,
          createdAt: asText(d.createdAt) || null,
        };
      })
      .filter((item) => item.id);
  }

  async getVideoUrl(ctx: ProviderContext, target: DownloadTarget): Promise<string | null> {
    // 预签名地址会过期，每次调用都重新取一次最新地址。
    return fetchFreshVideoUrl(ctx, target.remoteId);
  }

  async getVideoStream(
    ctx: ProviderContext,
    target: DownloadTarget,
    options: DownloadOptions
  ): Promise<VideoStream | null> {
    const url = await fetchFreshVideoUrl(ctx, target.remoteId);
    if (!url) return null;

    const headers: Record<string, string> = {};
    if (options.range) headers.range = options.range;
    const upstream = await fetch(url, { headers, signal: options.signal });
    if (!upstream.ok || !upstream.body) return null;

    const length = upstream.headers.get("content-length");
    return {
      body: upstream.body as ReadableStream<Uint8Array>,
      contentType: upstream.headers.get("content-type") || "video/mp4",
      filename: `viggle_${target.taskId.slice(0, 8)}.mp4`,
      contentLength: length ? Number(length) : undefined,
      statusCode: upstream.status,
      contentRange: upstream.headers.get("content-range") ?? undefined,
      acceptRanges: upstream.headers.get("accept-ranges") ?? undefined,
    };
  }

  async getCoverStream(
    ctx: ProviderContext,
    target: DownloadTarget,
    signal?: AbortSignal
  ): Promise<CoverStream | null> {
    const url = await fetchFreshCoverUrl(ctx, target.remoteId);
    if (!url) return null;

    const upstream = await fetch(url, { signal });
    if (!upstream.ok || !upstream.body) return null;

    const length = upstream.headers.get("content-length");
    return {
      body: upstream.body as ReadableStream<Uint8Array>,
      contentType: upstream.headers.get("content-type") || "image/jpeg",
      contentLength: length ? Number(length) : undefined,
    };
  }
}
