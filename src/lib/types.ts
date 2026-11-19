/** 前后端共享的领域类型。此文件不得引入任何 Node/服务端依赖。 */

export type GenerationMode = "references" | "frames" | "text";
export type TaskStatus = "preparing" | "queued" | "running" | "succeeded" | "failed";
export type AccountStatus = "unknown" | "valid" | "invalid";
export type ProviderId = "viggle";
export type AssetKind = "image" | "video" | "audio";
export type AssetRole = "reference" | "first" | "last";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
}

export interface AccountView {
  id: string;
  label: string;
  email: string | null;
  /** 续期用的登录邮箱（与上游返回的 email 分开） */
  loginEmail: string | null;
  /** 是否已保存登录密码；密码本身永不回传 */
  hasPassword: boolean;
  nickname: string | null;
  isActive: boolean;
  status: AccountStatus;
  lastCheckedAt: string | null;
  freeCredits: number | null;
  /** 积分不足时记录的下次刷新时刻；刷新前自动选号会直接跳过该账号 */
  creditsResetAt: string | null;
  note: string | null;
  tokenMask: string;
  /** JWT 的 exp；解析不出来时为 null */
  tokenExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface UserProfile {
  nickname: string;
  email: string;
  freeCredits: number;
  subscribeCredits: number;
  planCredits: number;
  purchasedCredits: number;
  remainingFreeMiniMaxVideoGenCount: number;
}

/** 自动选号结果：切换后的账号列表与本次实际选中的账号。 */
export interface AutoSelectResult {
  accounts: AccountView[];
  selectedId: string;
  label: string;
  freeCredits: number;
}

/** 批量校验的结果汇总。 */
export interface VerifyAllResult {
  total: number;
  valid: number;
  invalid: number;
  /** 凭据无法解密、保留原状态的账号数。 */
  skipped: number;
}

export interface AssetView {
  id: string;
  remoteId: string;
  accountId: string;
  kind: AssetKind;
  mime: string;
  filename: string;
  /** 上游临时预览地址，仅用于本次响应；不落库，过期后不可用 */
  previewUrl: string | null;
  createdAt: string;
}

/** 任务详情里展示的素材：只带预览所需的轻量信息。 */
export interface TaskAssetView {
  role: AssetRole;
  position: number;
  kind: AssetKind;
  filename: string;
  mime: string;
  /** 可直接用于 <img> 预览的地址；视频没有封面时为 null */
  previewUrl: string | null;
  /** 由用户手动从素材箱关联回来的素材（上游原件可能已删除） */
  manual?: boolean;
}

/** 素材箱里来自上游素材库的一条记录（只读，被选用后才落库）。 */
export interface LibraryAssetView {
  id: string;
  kind: "image" | "video";
  name: string;
  previewUrl: string | null;
  url: string | null;
  coverUrl: string | null;
  createdAt: string | null;
  /** 上游剩余保留秒数，用于校准过期时间 */
  remainingSeconds: number | null;
}

/** 本地素材箱里的一份文件；url 指向本地只读接口。 */
export interface LocalAssetView {
  id: string;
  /** 磁盘文件名（内容哈希 + 扩展名） */
  filename: string;
  /** 上传时的原始文件名 */
  originalName: string;
  kind: "image" | "video";
  mime: string;
  size: number;
  url: string;
  /** 缩略图地址；没有封面时为 null，前端应回退到占位图而不是加载原文件 */
  coverUrl: string | null;
  createdAt: string;
}

/** 用户自己保存的提示词预设。 */
export interface PromptPresetView {
  id: string;
  /** 预设标题；保存时留空则由内容首行自动生成 */
  title: string;
  content: string;
  createdAt: string;
}

export interface TaskView {
  id: string;
  remoteId: string | null;
  accountId: string;
  accountLabel: string;
  mode: GenerationMode;
  prompt: string;
  aspectRatio: string;
  duration: number;
  resolution: string;
  qualityType: number;
  status: TaskStatus;
  stage: string;
  progress: number;
  errorMessage: string | null;
  videoUrl: string | null;
  coverUrl: string | null;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
  /** 上游任务未创建且保留了提交快照时可重试（选号/上传失败、上游繁忙被拒绝等），不重复消耗额度 */
  retryable: boolean;
}

/**
 * 本地已落盘的视频文件。
 * 与历史记录完全独立：删文件不影响记录，删记录也不删文件。
 */
export interface LocalVideoView {
  taskId: string;
  filename: string;
  /** 文件字节数 */
  size: number;
  /** 文件最后写入时间 */
  savedAt: string;
  /** 是否以 SKE（Sakura Encryptor）格式加密存储 */
  encrypted: boolean;
  /** 本地封面地址（存在 cover 目录）；上游没有封面时为 null */
  coverUrl: string | null;
  /** 落盘时一并快照的记录信息 */
  task: {
    prompt: string;
    accountLabel: string;
    mode: GenerationMode;
    status: TaskStatus;
    createdAt: string;
    finishedAt: string | null;
    /** 上游 Viggle 任务 ID */
    remoteId: string | null;
    aspectRatio: string;
    /** 时长（秒） */
    duration: number;
    resolution: string;
    qualityType: number;
  } | null;
}

/** /api/tasks 的请求体 */
export interface CreateTaskInput {
  mode: GenerationMode;
  prompt: string;
  aspectRatio: string;
  duration: number;
  resolution: string;
  qualityType: number;
  assets: Array<{ id: string; role: AssetRole; position: number }>;
  /** 本地素材箱里的文件，生成时由后端上传到上游 */
  localAssets?: Array<{ id: string; role: AssetRole; position: number }>;
}

export type StreamEvent =
  | { type: "snapshot"; tasks: TaskView[]; accounts: AccountView[] }
  | { type: "task.created"; task: TaskView }
  | { type: "task.updated"; task: TaskView }
  | { type: "task.deleted"; id: string }
  | { type: "accounts.synced"; accounts: AccountView[] }
  | { type: "heartbeat"; at: number };

export interface ApiOk<T> {
  ok: true;
  data: T;
}

export interface ApiErr {
  ok: false;
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export type ApiResult<T> = ApiOk<T> | ApiErr;
