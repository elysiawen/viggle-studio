import type { AssetKind, GenerationMode, LibraryAssetView, TaskStatus, UserProfile } from "@/lib/types";

/** 每次上游调用都显式携带账号凭据，禁止 Provider 隐式读取全局状态。 */
export interface ProviderContext {
  accountId: string;
  token: string;
}

export interface GenerationPayload {
  mode: GenerationMode;
  prompt: string;
  aspectRatio: string;
  duration: number;
  resolution: string;
  qualityType: number;
  referenceMedia: Array<{ id: string; type: number }>;
  startFrameId?: string;
  endFrameId?: string;
}

export interface UploadPayload {
  buffer: Buffer;
  mime: string;
  filename: string;
}

export interface UploadedAsset {
  remoteId: string;
  url: string | null;
  coverUrl: string | null;
  kind: AssetKind;
}

/** Provider 返回的、与上游细节解耦的任务状态。 */
export interface RemoteTaskState {
  remoteStatus: number;
  status: TaskStatus;
  stage: string;
  progress: number;
  videoUrl: string | null;
  coverUrl: string | null;
  errorMessage: string | null;
}

/** 某次生成记录里用到的参考素材，地址由上游实时签发。 */
export interface RemoteMediaSource {
  remoteId: string;
  kind: AssetKind;
  /** 原始文件地址，用于补下载 */
  url: string | null;
  /** 可直接用于 <img> 的预览地址；视频取封面 */
  previewUrl: string | null;
}

export interface DownloadTarget {
  taskId: string;
  remoteId: string | null;
  videoUrl: string | null;
}

export interface DownloadOptions {
  range?: string;
  signal?: AbortSignal;
}

export interface VideoStream {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  filename: string;
  contentLength?: number;
  statusCode?: number;
  contentRange?: string;
  acceptRanges?: string;
}

/** 封面图字节流；封面同样是预签名地址，需要每次重新签发。 */
export interface CoverStream {
  body: ReadableStream<Uint8Array>;
  contentType: string;
  contentLength?: number;
}

/**
 * 上游适配层契约。业务层只依赖契约，不感知签名、multipart 等上游细节。
 */
export interface VideoProvider {
  readonly id: "viggle";
  verify(ctx: ProviderContext): Promise<UserProfile>;
  upload(ctx: ProviderContext, payload: UploadPayload): Promise<UploadedAsset>;
  create(ctx: ProviderContext, payload: GenerationPayload): Promise<{ remoteId: string }>;
  poll(ctx: ProviderContext, remoteId: string, startedAt: Date): Promise<RemoteTaskState>;
  /** 删除上游的生成任务与产出视频；上游已无该记录时视为成功。 */
  deleteRemoteTask(ctx: ProviderContext, remoteId: string): Promise<void>;
  /** 拉取账号在上游素材库里已有的图片 / 视频，只读、不消耗积分。 */
  listLibraryAssets(
    ctx: ProviderContext,
    query: { kind: "image" | "video"; page?: number; pageSize?: number }
  ): Promise<LibraryAssetView[]>;
  /** 解析某次生成记录用到的参考素材与最新地址，用于本地副本缺失时补下载 / 预览。 */
  getReferenceMedia(ctx: ProviderContext, remoteId: string): Promise<RemoteMediaSource[]>;
  /** 取当前可用的视频直链。上游给的是预签名地址，过期后必须重新签发。 */
  getVideoUrl(ctx: ProviderContext, target: DownloadTarget): Promise<string | null>;
  getVideoStream(
    ctx: ProviderContext,
    target: DownloadTarget,
    options: DownloadOptions
  ): Promise<VideoStream | null>;
  /** 取封面图字节流，同样每次重新签发预签名地址。 */
  getCoverStream(
    ctx: ProviderContext,
    target: DownloadTarget,
    signal?: AbortSignal
  ): Promise<CoverStream | null>;
}
