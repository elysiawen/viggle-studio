"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { api, apiJson, errorMessage } from "@/lib/api-client";
import { createId } from "@/lib/id";
import {
  ASPECT_RATIOS,
  DURATIONS,
  QUALITY_TYPES,
  RESOLUTIONS,
  isAcceptedMime,
  isVideoMime,
  MAX_IMAGE_BYTES,
  MAX_REFERENCE_MEDIA,
  MAX_VIDEO_BYTES,
} from "@/lib/constants";
import type {
  AccountView,
  AssetRole,
  AssetView,
  AutoSelectResult,
  GenerationMode,
  LocalAssetView,
  ProviderInfo,
  StreamEvent,
  TaskView,
  UserProfile,
  VerifyAllResult,
} from "@/lib/types";

export type ViewId = "workspace" | "history" | "accounts" | "settings";

/** 每个视图对应的真实路由，URL 里能直接看到 */
export const VIEW_PATH: Record<ViewId, string> = {
  workspace: "/",
  history: "/history",
  accounts: "/accounts",
  settings: "/settings",
};

/** 由 pathname 反推当前视图，刷新/直接访问子路由时也能落对页面 */
export function viewFromPathname(pathname: string | null): ViewId {
  if (!pathname) return "workspace";
  if (pathname.startsWith("/history")) return "history";
  if (pathname.startsWith("/accounts")) return "accounts";
  if (pathname.startsWith("/settings")) return "settings";
  return "workspace";
}
export type ToastTone = "ok" | "error" | "info";
/** 账号列表排序：默认保持接口返回顺序；按积分则剩余点数高的在前。 */
export type AccountSort = "default" | "credits";
/** 手动固定一个账号 / 自动挑选积分充足的账号。 */
export type AccountMode = "manual" | "auto";

/** 顶栏切换器里「自动模式」这一项的哨兵值，不与真实账号 ID 冲突。 */
export const AUTO_ACCOUNT_VALUE = "__auto__";
const ACCOUNT_MODE_KEY = "viggle-studio:account-mode";

/** 顶栏切换器与账号管理页共用；未校验（freeCredits 为 null）的账号排在最后。 */
export function sortAccounts<T extends { freeCredits?: number | null }>(
  list: readonly T[],
  sort: AccountSort
): T[] {
  if (sort === "default") return [...list];
  return [...list].sort((a, b) => (b.freeCredits ?? -1) - (a.freeCredits ?? -1));
}

export interface MeData {
  provider: ProviderInfo;
  activeAccount: AccountView | null;
  profile: UserProfile | null;
  stale: boolean;
  pollIntervalMs: number;
}

export interface DraftAsset {
  key: string;
  id: string | null;
  /** 来自本地素材箱时记录素材 ID；这类草稿在生成时才由后端上传 */
  localAssetId?: string | null;
  role: AssetRole;
  position: number;
  previewUrl: string;
  filename: string;
  mime: string;
  uploading: boolean;
  isVideo: boolean;
}

export interface ToastItem {
  id: string;
  tone: ToastTone;
  message: string;
  /** 正在播放退出动画，动画结束后再从列表移除。 */
  leaving?: boolean;
}

export interface GenerateParams {
  prompt: string;
  aspectRatio: string;
  duration: number;
  resolution: string;
  qualityType: number;
}

export interface AccountInput {
  label: string;
  token?: string;
  note?: string;
  /** 续期用的登录邮箱；传空字符串表示清除 */
  loginEmail?: string | null;
  /** 续期用的登录密码；传空字符串表示清除 */
  loginPassword?: string | null;
}

interface StudioContextValue {
  view: ViewId;
  setView: (view: ViewId) => void;
  loading: boolean;
  connected: boolean;
  me: MeData | null;
  accounts: AccountView[];
  accountSort: AccountSort;
  setAccountSort: (sort: AccountSort) => void;
  accountMode: AccountMode;
  /** 切换模式；切到自动时立即定号，便于素材箱/上传沿用同一个账号。 */
  setAccountMode: (mode: AccountMode) => Promise<void>;
  /** 立即重新评估并激活一个积分充足的账号。 */
  autoSelect: (options?: { silent?: boolean }) => Promise<void>;
  /** 自动模式下、且当前没有已上传素材时定号；供上传与生成链路调用。 */
  ensureAutoAccount: () => Promise<void>;
  tasks: TaskView[];
  toasts: ToastItem[];
  dismissToast: (id: string) => void;
  notify: (message: string, tone?: ToastTone) => void;
  selectedTask: TaskView | null;
  selectTask: (id: string | null) => void;
  mode: GenerationMode;
  setMode: (mode: GenerationMode) => void;
  /** 生成表单（提示词、比例、时长等）放在上下文里，切换页面再回来不会丢。 */
  generateForm: GenerateParams;
  setGenerateForm: (patch: Partial<GenerateParams>) => void;
  drafts: DraftAsset[];
  addFiles: (files: FileList | File[], target?: "start" | "end") => Promise<void>;
  addLibraryAssets: (kind: "image" | "video", ids: string[], maxPage?: number) => Promise<void>;
  /** 把本地素材箱里的文件直接加入草稿，生成时再由后端上传。 */
  addLocalAssets: (items: LocalAssetView[]) => void;
  removeDraft: (key: string) => void;
  clearDrafts: () => void;
  submitting: boolean;
  generate: (params: GenerateParams) => Promise<TaskView>;
  refreshAll: () => Promise<void>;
  refreshMe: () => Promise<void>;
  createAccount: (input: AccountInput) => Promise<void>;
  updateAccount: (id: string, input: AccountInput) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  /** 一次删除多选账号，只刷新一次全量数据。 */
  deleteAccounts: (ids: string[]) => Promise<void>;
  deleteTask: (id: string, deleteRemote?: boolean) => Promise<void>;
  /** 批量删除历史记录，可选一并删除上游视频；返回成功与失败明细。 */
  deleteTasks: (ids: string[], deleteRemote?: boolean) => Promise<{
    deleted: number;
    deletedIds: string[];
    failed: Array<{ id: string; message: string }>;
  }>;
  activateAccount: (id: string) => Promise<void>;
  verifyAccount: (id: string) => Promise<void>;
  /** 不传 ids 时校验全部账号；传 ids 时只校验多选账号。 */
  verifyAllAccounts: (ids?: string[]) => Promise<VerifyAllResult>;
}

const StudioContext = createContext<StudioContextValue | null>(null);

export function useStudio(): StudioContextValue {
  const value = useContext(StudioContext);
  if (!value) throw new Error("useStudio 必须在 StudioProvider 内使用");
  return value;
}

function validateFile(file: File, framesOnly: boolean): string | null {
  if (!isAcceptedMime(file.type)) return "仅支持 JPG / PNG / WebP / MP4 / MOV";
  if (framesOnly && isVideoMime(file.type)) return "首尾帧仅支持图片";
  const limit = isVideoMime(file.type) ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  if (file.size > limit) return `文件不能超过 ${isVideoMime(file.type) ? 20 : 10}MB`;
  return null;
}

export function StudioProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  // 视图不再放 state：以 URL 为准，前进/后退、刷新都能对得上
  const view = viewFromPathname(pathname);
  const setView = useCallback(
    (next: ViewId) => {
      router.push(VIEW_PATH[next]);
    },
    [router]
  );
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState<MeData | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [mode, setModeState] = useState<GenerationMode>("references");
  const [generateForm, setGenerateFormState] = useState<GenerateParams>({
    prompt: "",
    aspectRatio: ASPECT_RATIOS[0],
    duration: DURATIONS[0],
    resolution: RESOLUTIONS[0],
    qualityType: QUALITY_TYPES[0].value,
  });
  const setGenerateForm = useCallback(
    (patch: Partial<GenerateParams>) => setGenerateFormState((prev) => ({ ...prev, ...patch })),
    []
  );
  const [drafts, setDrafts] = useState<DraftAsset[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [accountSort, setAccountSort] = useState<AccountSort>("default");
  const [accountMode, setAccountModeState] = useState<AccountMode>("manual");
  /** 合并生成后与上传前同时触发的自动选号，避免重复校验和并发切换。 */
  const autoSelectRequestRef = useRef<Promise<AutoSelectResult> | null>(null);

  const draftsRef = useRef<DraftAsset[]>([]);
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  /** 记录每个任务上次同步到的状态，只在「刚失败」时通过提示条通知一次。 */
  const taskStatusRef = useRef<Map<string, string>>(new Map());

  /** 已开始播放退出动画的通知，避免重复触发。 */
  const hidingToastsRef = useRef<Set<string>>(new Set());

  /** 先播放退出动画，动画结束后再从列表移除。 */
  const hideToast = useCallback((id: string) => {
    if (hidingToastsRef.current.has(id)) return;
    hidingToastsRef.current.add(id);
    setToasts((prev) =>
      prev.map((toast) => (toast.id === id ? { ...toast, leaving: true } : toast))
    );
    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
      hidingToastsRef.current.delete(id);
    }, 220);
  }, []);

  const notify = useCallback((message: string, tone: ToastTone = "info") => {
    const id = createId();
    setToasts((prev) => [...prev, { id, tone, message }]);
    setTimeout(() => hideToast(id), 4600);
  }, [hideToast]);

  const dismissToast = useCallback((id: string) => hideToast(id), [hideToast]);

  const upsertTask = useCallback((task: TaskView) => {
    setTasks((prev) => {
      const index = prev.findIndex((t) => t.id === task.id);
      if (index === -1) return [task, ...prev];
      const next = [...prev];
      next[index] = task;
      return next;
    });
  }, []);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api<MeData>("/api/me"));
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }, [notify]);

  const refreshAll = useCallback(async () => {
    const [meData, accountData, taskData] = await Promise.all([
      api<MeData>("/api/me"),
      api<{ accounts: AccountView[] }>("/api/accounts"),
      api<{ tasks: TaskView[] }>("/api/tasks"),
    ]);
    setMe(meData);
    setAccounts(accountData.accounts);
    setTasks(taskData.tasks);
  }, []);

  // 刷新页面后恢复模式；不立即请求上游，等第一次上传 / 生成时再定号。
  useEffect(() => {
    try {
      if (window.localStorage.getItem(ACCOUNT_MODE_KEY) === "auto") {
        setAccountModeState("auto");
      }
    } catch {
      // 本地存储不可用时保持手动模式
    }
  }, []);

  const autoSelect = useCallback(
    async (options: { silent?: boolean } = {}) => {
      let request = autoSelectRequestRef.current;
      if (!request) {
        request = (async () => {
          const result = await api<AutoSelectResult>("/api/accounts/auto", { method: "POST" });
          setAccounts(result.accounts);
          await refreshMe();
          return result;
        })();
        autoSelectRequestRef.current = request;
      }
      try {
        const result = await request;
        if (!options.silent) {
          notify(`自动选号 · 「${result.label}」剩余 ${result.freeCredits} 积分`, "ok");
        }
      } finally {
        if (autoSelectRequestRef.current === request) autoSelectRequestRef.current = null;
      }
    },
    [refreshMe, notify]
  );

  /**
   * 素材库选中的上游素材绑定了当时的激活账号，必须锁定。
   * 直接上传的文件已改为先落本地，提交生成时才定号，不再需要提前选号。
   */
  const ensureAutoAccount = useCallback(async () => {
    if (accountMode !== "auto") return;
    if (draftsRef.current.some((d) => d.id)) return;
    await autoSelect({ silent: true });
  }, [accountMode, autoSelect]);

  const setAccountMode = useCallback(
    async (next: AccountMode) => {
      setAccountModeState(next);
      try {
        window.localStorage.setItem(ACCOUNT_MODE_KEY, next);
      } catch {
        // 忽略不可用的本地存储
      }
      if (next === "auto") {
        // 已有上传素材时不能换号，否则素材会与任务分属不同账号。
        if (draftsRef.current.some((d) => d.id)) {
          notify("已开启自动模式 · 当前素材仍使用上传时的账号", "info");
          return;
        }
        try {
          await autoSelect();
        } catch (err) {
          notify(errorMessage(err), "error");
        }
      } else {
        notify("已切换为手动选号", "info");
      }
    },
    [autoSelect, notify]
  );

  // 初始化 + SSE 长连接。卸载时关闭连接，避免旧项目那种无边界轮询泄漏。
  useEffect(() => {
    let disposed = false;
    let source: EventSource | null = null;

    void (async () => {
      try {
        await refreshAll();
      } catch (err) {
        if (!disposed) notify("初始化失败：" + errorMessage(err), "error");
      } finally {
        if (!disposed) setLoading(false);
      }
      if (disposed) return;

      source = new EventSource("/api/events");
      source.onopen = () => setConnected(true);
      source.onerror = () => setConnected(false);

      const onEvent = (event: Event) => {
        const raw = (event as MessageEvent).data;
        let payload: StreamEvent;
        try {
          payload = JSON.parse(raw) as StreamEvent;
        } catch {
          return;
        }
        setConnected(true);
        switch (payload.type) {
          case "snapshot":
            setTasks(payload.tasks);
            setAccounts(payload.accounts);
            taskStatusRef.current = new Map(
              payload.tasks.map((task): [string, string] => [task.id, task.status])
            );
            break;
          case "task.created":
            upsertTask(payload.task);
            taskStatusRef.current.set(payload.task.id, payload.task.status);
            break;
          case "task.updated": {
            const previous = taskStatusRef.current.get(payload.task.id);
            upsertTask(payload.task);
            taskStatusRef.current.set(payload.task.id, payload.task.status);
            if (payload.task.status === "failed" && previous !== "failed") {
              notify(payload.task.errorMessage || "生成失败", "error");
            }
            break;
          }
          case "task.deleted":
            setTasks((prev) => prev.filter((task) => task.id !== payload.id));
            setSelectedTaskId((prev) => (prev === payload.id ? null : prev));
            taskStatusRef.current.delete(payload.id);
            break;
          case "accounts.synced":
            setAccounts(payload.accounts);
            break;
          case "heartbeat":
            break;
        }
      };

      for (const type of [
        "snapshot",
        "task.created",
        "task.updated",
        "task.deleted",
        "accounts.synced",
        "heartbeat",
      ]) {
        source.addEventListener(type, onEvent);
      }
    })();

    return () => {
      disposed = true;
      source?.close();
      setConnected(false);
    };
  }, [refreshAll, upsertTask, notify]);

  /** 丢弃草稿时顺带清理临时素材；服务端只删临时记录，永久素材不受影响。 */
  const cleanupTempDrafts = useCallback((items: DraftAsset[]) => {
    const ids = items
      .map((draft) => draft.localAssetId)
      .filter((id): id is string => Boolean(id));
    if (!ids.length) return;
    void api(`/api/assets/local?temp=1&ids=${encodeURIComponent(ids.join(","))}`, {
      method: "DELETE",
    }).catch(() => {});
  }, []);

  const clearDrafts = useCallback(() => {
    draftsRef.current.forEach((draft) => URL.revokeObjectURL(draft.previewUrl));
    cleanupTempDrafts(draftsRef.current);
    draftsRef.current = [];
    setDrafts([]);
  }, [cleanupTempDrafts]);

  const setMode = useCallback(
    (next: GenerationMode) => {
      clearDrafts();
      setModeState(next);
    },
    [clearDrafts]
  );

  const removeDraft = useCallback(
    (key: string) => {
      const target = draftsRef.current.find((d) => d.key === key);
      if (target) {
        URL.revokeObjectURL(target.previewUrl);
        cleanupTempDrafts([target]);
      }
      setDrafts((prev) => prev.filter((d) => d.key !== key));
    },
    [cleanupTempDrafts]
  );

  const uploadOne = useCallback(
    async (file: File, role: AssetRole, position: number) => {
      const key = createId();
      const previewUrl = URL.createObjectURL(file);
      const item: DraftAsset = {
        key,
        id: null,
        role,
        position,
        previewUrl,
        filename: file.name,
        mime: file.type,
        uploading: true,
        isVideo: isVideoMime(file.type),
      };
      setDrafts((prev) => [...prev, item]);

      try {
        const form = new FormData();
        form.append("file", file);
        // 只落本地素材：提交生成时再按最终选中的账号上传，换号不会让素材失效。
        const { asset } = await api<{ asset: LocalAssetView }>("/api/assets/local", {
          method: "POST",
          body: form,
        });
        setDrafts((prev) =>
          prev.map((d) =>
            d.key === key
              ? { ...d, localAssetId: asset.id, previewUrl: asset.url, uploading: false }
              : d
          )
        );
        URL.revokeObjectURL(previewUrl);
      } catch (err) {
        setDrafts((prev) => prev.filter((d) => d.key !== key));
        URL.revokeObjectURL(previewUrl);
        throw err;
      }
    },
    []
  );

  const addFiles = useCallback(
    async (files: FileList | File[], target?: "start" | "end") => {
      if (mode === "text") return;
      const list = Array.from(files);
      if (!list.length) return;

      if (mode === "frames") {
        const role: AssetRole = target === "end" ? "last" : "first";
        const file = list[0];
        const invalid = validateFile(file, true);
        if (invalid) return notify(`上传失败 · ${file.name}：${invalid}`, "error");

        const previous = draftsRef.current.filter((d) => d.role === role);
        const restorable = previous.filter((d) => !d.uploading && (d.id || d.localAssetId));
        setDrafts((prev) => prev.filter((d) => d.role !== role));
        try {
          await uploadOne(file, role, role === "first" ? 0 : 1);
          previous.forEach((d) => URL.revokeObjectURL(d.previewUrl));
          cleanupTempDrafts(previous);
        } catch (err) {
          setDrafts((prev) => [...prev.filter((d) => d.role !== role), ...restorable]);
          previous
            .filter((d) => !restorable.includes(d))
            .forEach((d) => URL.revokeObjectURL(d.previewUrl));
          notify(`上传失败 · ${file.name}：${errorMessage(err)}`, "error");
        }
        return;
      }

      const existing = draftsRef.current.filter((d) => d.role === "reference").length;
      const room = MAX_REFERENCE_MEDIA - existing;
      if (room <= 0) return notify(`参考素材最多 ${MAX_REFERENCE_MEDIA} 个`, "error");
      const picked = list.slice(0, room);
      const failures: string[] = [];
      let position = existing;
      for (const file of picked) {
        const invalid = validateFile(file, false);
        if (invalid) {
          failures.push(`${file.name}：${invalid}`);
          continue;
        }
        try {
          await uploadOne(file, "reference", position);
          position += 1;
        } catch (err) {
          failures.push(`${file.name}：${errorMessage(err)}`);
        }
      }
      if (failures.length) {
        const summary =
          failures.length === 1
            ? `上传失败 · ${failures[0]}`
            : `${failures.length} 个文件上传失败 · ${failures.slice(0, 2).join("；")}${failures.length > 2 ? "…" : ""}`;
        notify(summary, "error");
      }
      if (list.length > room) notify(`最多上传 ${MAX_REFERENCE_MEDIA} 个，已截取前 ${room} 个`, "info");
    },
    [mode, notify, uploadOne, cleanupTempDrafts]
  );

  const addLibraryAssets = useCallback(
    async (kind: "image" | "video", ids: string[], maxPage = 1) => {
      const used = draftsRef.current.filter((d) => d.role === "reference").length;
      const room = MAX_REFERENCE_MEDIA - used;
      if (room <= 0) return notify(`参考素材最多 ${MAX_REFERENCE_MEDIA} 个`, "error");
      const wanted = ids.slice(0, room);
      if (!wanted.length) return;
      await ensureAutoAccount();

      const { assets } = await api<{ assets: AssetView[] }>("/api/assets/library", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind, ids: wanted, maxPage }),
      });
      setDrafts((prev) => {
        const offset = prev.filter((d) => d.role === "reference").length;
        return [
          ...prev,
          ...assets.map((asset, index) => ({
            key: createId(),
            id: asset.id,
            role: "reference" as const,
            position: offset + index,
            previewUrl: asset.coverUrl || asset.url || "",
            filename: asset.filename,
            mime: asset.mime,
            uploading: false,
            isVideo: asset.kind === "video",
          })),
        ];
      });
      notify(`已从素材箱添加 ${assets.length} 个素材`, "ok");
    },
    [notify, ensureAutoAccount]
  );

  const addLocalAssets = useCallback(
    (items: LocalAssetView[]) => {
      const used = draftsRef.current.filter((d) => d.role === "reference").length;
      const room = MAX_REFERENCE_MEDIA - used;
      if (room <= 0) return notify(`参考素材最多 ${MAX_REFERENCE_MEDIA} 个`, "error");
      const picked = items.slice(0, room);
      if (!picked.length) return;
      setDrafts((prev) => {
        const offset = prev.filter((d) => d.role === "reference").length;
        return [
          ...prev,
          ...picked.map((asset, index) => ({
            key: createId(),
            id: null,
            localAssetId: asset.id,
            role: "reference" as const,
            position: offset + index,
            previewUrl: asset.kind === "image" ? asset.url : "",
            filename: asset.originalName,
            mime: asset.mime,
            uploading: false,
            isVideo: asset.kind === "video",
          })),
        ];
      });
      notify(`已从本地素材箱添加 ${picked.length} 个素材`, "ok");
    },
    [notify]
  );

  const generate = useCallback(
    async (params: GenerateParams): Promise<TaskView> => {
      setSubmitting(true);
      try {
        const current = draftsRef.current;
        // 素材库选中的上游素材已绑定当前账号，此时换号必然跨号，只能沿用激活账号。
        const autoAccount = accountMode === "auto" && !current.some((d) => d.id);
        if (!autoAccount && !me?.activeAccount) {
          throw new Error("请先添加并激活一个账号");
        }
        if (current.some((d) => d.uploading)) throw new Error("素材还在上传，请稍候");
        const assets = current
          .filter((d) => d.id)
          .map((d) => ({ id: d.id as string, role: d.role, position: d.position }));
        const localAssets = current
          .filter((d) => !d.id && d.localAssetId)
          .map((d) => ({ id: d.localAssetId as string, role: d.role, position: d.position }));
        if (mode === "references" && !assets.length && !localAssets.length) {
          throw new Error("请至少上传一个参考素材");
        }
        if (
          mode === "frames" &&
          !current.some((d) => d.role === "first" && (d.id || d.localAssetId))
        ) {
          throw new Error("首尾帧模式需要先上传首帧");
        }

        const { task } = await apiJson<{ task: TaskView }>("/api/tasks", "POST", {
          mode,
          ...params,
          assets,
          localAssets,
          autoAccount,
        });
        upsertTask(task);
        setSelectedTaskId(task.id);
        clearDrafts();
        notify(
          autoAccount
            ? `任务已提交 · 自动使用「${task.accountLabel}」`
            : "任务已提交，后台正在生成",
          "ok"
        );
        // 服务端可能切换了激活账号，这里同步一次顶栏展示。
        void refreshMe();
        return task;
      } finally {
        setSubmitting(false);
      }
    },
    [
      accountMode, me?.activeAccount, mode,
      upsertTask, clearDrafts, notify, refreshMe,
    ]
  );

  const createAccount = useCallback(
    async (input: AccountInput) => {
      await apiJson("/api/accounts", "POST", input);
      await refreshAll();
      notify("账号已添加", "ok");
    },
    [refreshAll, notify]
  );

  const updateAccount = useCallback(
    async (id: string, input: AccountInput) => {
      await apiJson(`/api/accounts/${id}`, "PATCH", input);
      await refreshAll();
      notify("账号已更新", "ok");
    },
    [refreshAll, notify]
  );

  const deleteAccount = useCallback(
    async (id: string) => {
      await api(`/api/accounts/${id}`, { method: "DELETE" });
      clearDrafts();
      await refreshAll();
      notify("账号已删除", "ok");
    },
    [refreshAll, clearDrafts, notify]
  );

  const deleteAccounts = useCallback(
    async (ids: string[]) => {
      const { deleted } = await apiJson<{ deleted: number }>("/api/accounts/batch-delete", "POST", { ids });
      clearDrafts();
      await refreshAll();
      notify(`已删除 ${deleted} 个账号`, "ok");
    },
    [refreshAll, clearDrafts, notify]
  );

  const deleteTask = useCallback(
    async (id: string, deleteRemote = false) => {
      await api(`/api/tasks/${id}${deleteRemote ? "?remote=1" : ""}`, { method: "DELETE" });
      setTasks((prev) => prev.filter((task) => task.id !== id));
      setSelectedTaskId((prev) => (prev === id ? null : prev));
      taskStatusRef.current.delete(id);
      notify(deleteRemote ? "记录与 Viggle 上游视频已删除" : "历史记录已删除", "ok");
    },
    [notify]
  );

  const deleteTasks = useCallback(
    async (ids: string[], deleteRemote = false) => {
      const result = await apiJson<{
        deleted: number;
        deletedIds: string[];
        failed: Array<{ id: string; message: string }>;
      }>("/api/tasks/batch-delete", "POST", { ids, remote: deleteRemote });
      const removed = new Set(result.deletedIds);
      setTasks((prev) => prev.filter((task) => !removed.has(task.id)));
      setSelectedTaskId((prev) => (prev && removed.has(prev) ? null : prev));
      removed.forEach((id) => taskStatusRef.current.delete(id));
      if (result.failed.length) {
        notify(
          `已删除 ${result.deleted} 条记录，${result.failed.length} 条失败：${result.failed[0].message}`,
          "error"
        );
      } else {
        notify(
          deleteRemote
            ? `已删除 ${result.deleted} 条记录及上游视频`
            : `已删除 ${result.deleted} 条历史记录`,
          "ok"
        );
      }
      return result;
    },
    [notify]
  );

  const activateAccount = useCallback(
    async (id: string) => {
      // 手动指定账号即退出自动模式，避免下次生成又被自动换走。
      if (accountMode === "auto") {
        setAccountModeState("manual");
        try {
          window.localStorage.setItem(ACCOUNT_MODE_KEY, "manual");
        } catch {
          // 忽略不可用的本地存储
        }
      }
      const result = await api<{ accounts: AccountView[] }>(`/api/accounts/${id}/activate`, {
        method: "POST",
      });
      setAccounts(result.accounts);
      clearDrafts();
      await refreshMe();
      const name = result.accounts.find((a) => a.isActive)?.label;
      notify(name ? `已切换到「${name}」` : "账号已切换", "ok");
    },
    [accountMode, clearDrafts, refreshMe, notify]
  );

  const verifyAccount = useCallback(
    async (id: string) => {
      const { profile } = await api<{ profile: UserProfile }>(
        `/api/accounts/${id}/verify`,
        { method: "POST" }
      );
      await refreshAll();
      notify(`校验通过 · 剩余 ${profile.freeCredits} 积分`, "ok");
    },
    [refreshAll, notify]
  );

  const verifyAllAccounts = useCallback(
    async (ids?: string[]) => {
      const result = await apiJson<VerifyAllResult>(
        "/api/accounts/verify-all",
        "POST",
        ids ? { ids } : {}
      );
      await refreshAll();
      return result;
    },
    [refreshAll]
  );

  const selectedTask = useMemo(
    () => tasks.find((t) => t.id === selectedTaskId) ?? null,
    [tasks, selectedTaskId]
  );

  const value = useMemo<StudioContextValue>(
    () => ({
      view,
      setView,
      loading,
      connected,
      me,
      accounts,
      accountSort,
      setAccountSort,
      accountMode,
      setAccountMode,
      autoSelect,
      ensureAutoAccount,
      tasks,
      toasts,
      dismissToast,
      notify,
      selectedTask,
      selectTask: setSelectedTaskId,
      mode,
      setMode,
      generateForm,
      setGenerateForm,
      drafts,
      addFiles,
      addLibraryAssets,
      addLocalAssets,
      removeDraft,
      clearDrafts,
      submitting,
      generate,
      refreshAll,
      refreshMe,
      createAccount,
      updateAccount,
      deleteAccount,
      deleteAccounts,
      deleteTask,
      deleteTasks,
      activateAccount,
      verifyAccount,
      verifyAllAccounts,
    }),
    [
      view, loading, connected, me, accounts, accountSort, setAccountSort, accountMode,
      setAccountMode, autoSelect, ensureAutoAccount, tasks, toasts, dismissToast, notify,
      selectedTask, mode, setMode, generateForm, setGenerateForm, drafts, addFiles, addLibraryAssets, addLocalAssets, removeDraft, clearDrafts,
      submitting, generate, refreshAll, refreshMe, createAccount, updateAccount,
      deleteAccount, deleteAccounts, deleteTask, deleteTasks, activateAccount, verifyAccount, verifyAllAccounts,
    ]
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}
