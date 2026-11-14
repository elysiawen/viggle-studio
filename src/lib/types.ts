/** 前后端共享的领域类型。此文件不得引入任何 Node/服务端依赖。 */

export type GenerationMode = "references" | "frames" | "text";
export type TaskStatus = "queued" | "running" | "succeeded" | "failed";
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
  nickname: string | null;
  isActive: boolean;
  status: AccountStatus;
  lastCheckedAt: string | null;
  freeCredits: number | null;
  note: string | null;
  tokenMask: string;
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
  url: string | null;
  coverUrl: string | null;
  createdAt: string;
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
