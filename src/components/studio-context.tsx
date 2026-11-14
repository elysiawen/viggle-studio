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
import { api, apiJson, errorMessage } from "@/lib/api-client";
import {
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
  GenerationMode,
  ProviderInfo,
  StreamEvent,
  TaskView,
  UserProfile,
} from "@/lib/types";

export type ViewId = "workspace" | "history" | "accounts";
export type ToastTone = "ok" | "error" | "info";
/** 账号列表排序：默认保持接口返回顺序；按积分则剩余点数高的在前。 */
export type AccountSort = "default" | "credits";

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
  tasks: TaskView[];
  toasts: ToastItem[];
  dismissToast: (id: string) => void;
  notify: (message: string, tone?: ToastTone) => void;
  selectedTask: TaskView | null;
  selectTask: (id: string | null) => void;
  mode: GenerationMode;
  setMode: (mode: GenerationMode) => void;
  drafts: DraftAsset[];
  addFiles: (files: FileList | File[], target?: "start" | "end") => Promise<void>;
  addLibraryAssets: (kind: "image" | "video", ids: string[], maxPage?: number) => Promise<void>;
  removeDraft: (key: string) => void;
  clearDrafts: () => void;
  submitting: boolean;
  generate: (params: GenerateParams) => Promise<TaskView>;
  refreshAll: () => Promise<void>;
  refreshMe: () => Promise<void>;
  createAccount: (input: AccountInput) => Promise<void>;
  updateAccount: (id: string, input: AccountInput) => Promise<void>;
  deleteAccount: (id: string) => Promise<void>;
  deleteTask: (id: string, deleteRemote?: boolean) => Promise<void>;
  activateAccount: (id: string) => Promise<void>;
  verifyAccount: (id: string) => Promise<void>;
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
  const [view, setView] = useState<ViewId>("workspace");
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(false);
  const [me, setMe] = useState<MeData | null>(null);
  const [accounts, setAccounts] = useState<AccountView[]>([]);
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [mode, setModeState] = useState<GenerationMode>("references");
  const [drafts, setDrafts] = useState<DraftAsset[]>([]);
  const [submitting, setSubmitting] = useState(false);
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [accountSort, setAccountSort] = useState<AccountSort>("default");

  const draftsRef = useRef<DraftAsset[]>([]);
  useEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);

  /** 记录每个任务上次同步到的状态，只在「刚失败」时通过提示条通知一次。 */
  const taskStatusRef = useRef<Map<string, string>>(new Map());

  const notify = useCallback((message: string, tone: ToastTone = "info") => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, tone, message }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4600);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

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

  const clearDrafts = useCallback(() => {
    draftsRef.current.forEach((draft) => URL.revokeObjectURL(draft.previewUrl));
    draftsRef.current = [];
    setDrafts([]);
  }, []);

  const setMode = useCallback(
    (next: GenerationMode) => {
      clearDrafts();
      setModeState(next);
    },
    [clearDrafts]
  );

  const removeDraft = useCallback((key: string) => {
    setDrafts((prev) => {
      const target = prev.find((d) => d.key === key);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((d) => d.key !== key);
    });
  }, []);

  const uploadOne = useCallback(
    async (file: File, role: AssetRole, position: number) => {
      const key = crypto.randomUUID();
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
        const { asset } = await api<{ asset: AssetView }>("/api/assets", {
          method: "POST",
          body: form,
        });
        setDrafts((prev) =>
          prev.map((d) => (d.key === key ? { ...d, id: asset.id, uploading: false } : d))
        );
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
      if (!me?.activeAccount) {
        notify("请先在「账号管理」中添加并激活一个账号", "error");
        return;
      }

      if (mode === "frames") {
        const role: AssetRole = target === "end" ? "last" : "first";
        const file = list[0];
        const invalid = validateFile(file, true);
        if (invalid) return notify(`上传失败 · ${file.name}：${invalid}`, "error");

        const previous = draftsRef.current.filter((d) => d.role === role);
        const restorable = previous.filter((d) => !d.uploading && d.id);
        setDrafts((prev) => prev.filter((d) => d.role !== role));
        try {
          await uploadOne(file, role, role === "first" ? 0 : 1);
          previous.forEach((d) => URL.revokeObjectURL(d.previewUrl));
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
    [mode, me?.activeAccount, notify, uploadOne]
  );

  const addLibraryAssets = useCallback(
    async (kind: "image" | "video", ids: string[], maxPage = 1) => {
      const used = draftsRef.current.filter((d) => d.role === "reference").length;
      const room = MAX_REFERENCE_MEDIA - used;
      if (room <= 0) return notify(`参考素材最多 ${MAX_REFERENCE_MEDIA} 个`, "error");
      const wanted = ids.slice(0, room);
      if (!wanted.length) return;

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
            key: crypto.randomUUID(),
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
    [notify]
  );

  const generate = useCallback(
    async (params: GenerateParams): Promise<TaskView> => {
      if (!me?.activeAccount) throw new Error("请先添加并激活一个账号");
      const current = draftsRef.current;
      if (current.some((d) => d.uploading)) throw new Error("素材还在上传，请稍候");
      const assets = current
        .filter((d) => d.id)
        .map((d) => ({ id: d.id as string, role: d.role, position: d.position }));
      if (mode === "references" && !assets.length) throw new Error("请至少上传一个参考素材");
      if (mode === "frames" && !assets.some((a) => a.role === "first")) {
        throw new Error("首尾帧模式需要先上传首帧");
      }

      setSubmitting(true);
      try {
        const { task } = await apiJson<{ task: TaskView }>("/api/tasks", "POST", {
          mode,
          ...params,
          assets,
        });
        upsertTask(task);
        setSelectedTaskId(task.id);
        clearDrafts();
        notify("任务已提交，后台正在生成", "ok");
        void refreshMe();
        return task;
      } finally {
        setSubmitting(false);
      }
    },
    [me?.activeAccount, mode, upsertTask, clearDrafts, notify, refreshMe]
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

  const activateAccount = useCallback(
    async (id: string) => {
      const result = await api<{ accounts: AccountView[] }>(`/api/accounts/${id}/activate`, {
        method: "POST",
      });
      setAccounts(result.accounts);
      clearDrafts();
      await refreshMe();
      const name = result.accounts.find((a) => a.isActive)?.label;
      notify(name ? `已切换到「${name}」` : "账号已切换", "ok");
    },
    [clearDrafts, refreshMe, notify]
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
      tasks,
      toasts,
      dismissToast,
      notify,
      selectedTask,
      selectTask: setSelectedTaskId,
      mode,
      setMode,
      drafts,
      addFiles,
      addLibraryAssets,
      removeDraft,
      clearDrafts,
      submitting,
      generate,
      refreshAll,
      refreshMe,
      createAccount,
      updateAccount,
      deleteAccount,
      deleteTask,
      activateAccount,
      verifyAccount,
    }),
    [
      view, loading, connected, me, accounts, accountSort, tasks, toasts, dismissToast, notify,
      selectedTask, mode, setMode, drafts, addFiles, addLibraryAssets, removeDraft, clearDrafts,
      submitting, generate, refreshAll, refreshMe, createAccount, updateAccount,
      deleteAccount, deleteTask, activateAccount, verifyAccount,
    ]
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}
