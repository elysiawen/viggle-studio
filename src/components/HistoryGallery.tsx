"use client";

import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { MODE_META } from "@/lib/constants";
import { formatTime, relativeTime, truncate } from "@/lib/format";
import { GalleryTheater, type GalleryTheaterItem } from "./GalleryTheater";
import { LocalVideoGallery } from "./LocalVideoGallery";
import { TaskQueue } from "./PreviewPanel";
import { TaskDetailModal } from "./TaskDetailModal";
import { useStudio } from "./studio-context";
import { useLocalVideos } from "./use-local-videos";
import { EmptyState, Icon, Modal, SelectMenu, StatusPill, type SelectOption } from "./ui";

/** 账号筛选栏展开 / 收起的本地记忆键。 */
const FILTERS_OPEN_KEY = "viggle.history.filtersOpen";
/** 创作库最后停留在哪个标签页（云端 / 本地 / 任务队列）。 */
const GALLERY_TAB_KEY = "viggle.history.tab";
/** 三个 tab 各自的滚动位置（从 Shell 的 .content 容器读取）。 */
const GALLERY_SCROLL_KEY = "viggle.history.scroll";
type GalleryTab = "history" | "local" | "queue";
const TABS: readonly GalleryTab[] = ["history", "local", "queue"];

function readSavedGalleryTab(): GalleryTab {
  try {
    const saved = window.localStorage.getItem(GALLERY_TAB_KEY);
    if (saved && (TABS as readonly string[]).includes(saved)) return saved as GalleryTab;
  } catch {
    // 隐私模式禁用存储时按默认云端处理
  }
  return "history";
}

function readSavedScroll(): Record<GalleryTab, number> {
  const fallback: Record<GalleryTab, number> = { history: 0, local: 0, queue: 0 };
  try {
    const raw = window.localStorage.getItem(GALLERY_SCROLL_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      history: typeof parsed.history === "number" && Number.isFinite(parsed.history) ? parsed.history : 0,
      local: typeof parsed.local === "number" && Number.isFinite(parsed.local) ? parsed.local : 0,
      queue: typeof parsed.queue === "number" && Number.isFinite(parsed.queue) ? parsed.queue : 0,
    };
  } catch {
    return fallback;
  }
}

function persistScroll(positions: Record<GalleryTab, number>) {
  try {
    window.localStorage.setItem(GALLERY_SCROLL_KEY, JSON.stringify(positions));
  } catch {
    // 存储不可用时只影响记忆
  }
}

/** Shell 把整个 <main className="content"> 作为滚动容器，HistoryGallery 需要找到它来恢复位置。 */
function findScrollContainer(): HTMLElement | null {
  return document.querySelector<HTMLElement>("main.content, main.content--workspace");
}

export function HistoryGallery() {
  const { tasks, accounts, setView, refreshAll, notify, deleteTask, deleteTasks } = useStudio();
  const [filter, setFilter] = useState("all");
  /** 桌面端的账号筛选 chip 太多，可收起，只保留当前选中的账号。 */
  const [filtersOpen, setFiltersOpen] = useState(true);

  // 展开状态记在浏览器里，刷新或重新进入画廊后保持上次的选择。
  useEffect(() => {
    try {
      if (window.localStorage.getItem(FILTERS_OPEN_KEY) === "0") setFiltersOpen(false);
    } catch {
      // 隐私模式禁用 localStorage 时按默认展开处理
    }
  }, []);

  function toggleFiltersOpen() {
    const next = !filtersOpen;
    setFiltersOpen(next);
    try {
      window.localStorage.setItem(FILTERS_OPEN_KEY, next ? "1" : "0");
    } catch {
      // 存不进去也不影响本次交互
    }
  }
  /** 关键词：提示词 / 任务 ID / 账号名 / 生成模式 */
  const [query, setQuery] = useState("");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set<string>());
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchDeleteRemote, setBatchDeleteRemote] = useState(false);
  /** 三个标签页的数据源互相独立：云端记录在数据库，本地文件在磁盘，任务队列取进行中的任务。 */
  const [tab, setTabState] = useState<GalleryTab>(() => readSavedGalleryTab());
  /** 切 tab 前先把当前位置存好（含 localStorage），切过去后再恢复目标 tab 的位置。 */
  const scrollPositionsRef = useRef<Record<GalleryTab, number>>(readSavedScroll());
  const saveTimerRef = useRef<number | null>(null);

  function saveCurrentScroll() {
    const container = findScrollContainer();
    if (!container) return;
    scrollPositionsRef.current[tab] = Math.max(0, container.scrollTop);
    persistScroll(scrollPositionsRef.current);
  }

  // 滚动时高频防抖存当前 tab 的位置（50ms），确保切 view / 切 tab 前位置已落盘。
  // 注意：不在卸载 cleanup 里 saveCurrentScroll —— Shell 的 [view] effect 会先 scrollTo(0)，
  // cleanup 那时候读 scrollTop 已经是 0，会把之前存好的正确值覆盖掉。
  useEffect(() => {
    const container = findScrollContainer();
    if (!container) return;
    const onScroll = () => {
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(saveCurrentScroll, 50);
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      container.removeEventListener("scroll", onScroll);
      if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  function restoreScroll(target: GalleryTab) {
    const container = findScrollContainer();
    if (!container) return;
    const targetTop = scrollPositionsRef.current[target] ?? 0;
    if (targetTop <= 0) return;
    // mount 时子组件（如 LocalVideoGallery）可能还在异步渲染，scrollHeight 还没撑开，
    // 等几帧/几百毫秒再滚，直到 scrollHeight 足够大或超时兜底。
    let frames = 0;
    const tick = () => {
      frames += 1;
      const maxTop = Math.max(0, container.scrollHeight - container.clientHeight);
      if (maxTop > 0 || frames >= 10) {
        container.scrollTop = Math.min(targetTop, maxTop);
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  /** 切换标签页的统一入口：更新状态并写回 localStorage，同时交换滚动位置。 */
  const setTab = (next: GalleryTab) => {
    if (next === tab) return;
    saveCurrentScroll();
    setTabState(next);
    try {
      window.localStorage.setItem(GALLERY_TAB_KEY, next);
    } catch {
      // 存储不可用时只影响记忆，不影响本次交互
    }
  };

  // 首次挂载、从别的 view 切回来、或 tab 变化时，都恢复目标 tab 的滚动位置。
  // requestAnimationFrame 会自动等内容渲染完再滚，不需要额外区分 mount / 切换。
  useEffect(() => {
    restoreScroll(tab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);
  /** 本地文件状态提到这里，顶部操作区才能与内容区共用同一份查询 / 多选状态。 */
  const local = useLocalVideos(tab === "local");
  /** 已落盘的任务 ID，用来把卡片上的保存按钮显示成「已保存」。 */
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set<string>());
  const [savingId, setSavingId] = useState<string | null>(null);
  /** 打开时固化当前筛选结果，后台任务刷新不会打乱正在播放的列表。 */
  const [theater, setTheater] = useState<{
    source: "云端" | "本地";
    items: GalleryTheaterItem[];
    startId?: string;
  } | null>(null);

  // 每次切回历史记录都重新对一次本地文件，避免手动删除后状态过期。
  useEffect(() => {
    if (tab !== "history") return;
    let cancelled = false;
    api<{ videos: Array<{ taskId: string }> }>("/api/videos/local")
      .then((data) => {
        if (!cancelled) setSavedIds(new Set(data.videos.map((video) => video.taskId)));
      })
      .catch(() => {
        // 读取失败不影响手动保存，按钮保持可用
      });
    return () => {
      cancelled = true;
    };
  }, [tab]);

  async function saveToLocal(taskId: string) {
    if (savingId) return;
    setSavingId(taskId);
    try {
      const result = await api<{ taskId: string; alreadyExists: boolean }>(
        `/api/videos/local/${taskId}`,
        { method: "POST" }
      );
      setSavedIds((prev) => new Set(prev).add(taskId));
      notify(
        result.alreadyExists ? "这条视频已经在本地了" : "已保存到本地：视频与封面一起落盘",
        "ok"
      );
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setSavingId(null);
    }
  }

  const pendingDelete = tasks.find((task) => task.id === deleteId);

  async function confirmDelete() {
    if (!deleteId) return;
    setDeleting(true);
    try {
      await deleteTask(deleteId, deleteRemote);
      if (detailId === deleteId) setDetailId(null);
      setDeleteId(null);
      setDeleteRemote(false);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setDeleting(false);
    }
  }

  const keyword = query.trim().toLowerCase();
  const accountTasks = filter === "all" ? tasks : tasks.filter((task) => task.accountId === filter);
  const list = keyword
    ? accountTasks.filter((task) =>
        [task.prompt, task.id, task.accountLabel, MODE_META[task.mode]?.label].some(
          (value) => typeof value === "string" && value.toLowerCase().includes(keyword)
        )
      )
    : accountTasks;
  const playableTasks = list.filter((task) => task.status === "succeeded" && task.videoUrl);
  const succeeded = tasks.filter((task) => task.status === "succeeded").length;
  const queueCount = tasks.filter(
    (task) =>
      task.status === "preparing" ||
      task.status === "queued" ||
      task.status === "running" ||
      task.status === "failed"
  ).length;
  const accountOptions: SelectOption[] = [
    { value: "all", label: "全部账号", meta: tasks.length },
    ...accounts.map((account) => ({
      value: account.id,
      label: account.label,
      meta: tasks.filter((task) => task.accountId === account.id).length,
    })),
  ];
  const allSelected = list.length > 0 && list.every((task) => selectedIds.has(task.id));
  const visibleAccounts = filtersOpen
    ? accounts
    : accounts.filter((account) => account.id === filter);

  /** 记录在别处被删除时清理失效选中项。 */
  useEffect(() => {
    setSelectedIds((prev) => {
      if (!prev.size) return prev;
      const existing = new Set(tasks.map((task) => task.id));
      const next = new Set([...prev].filter((id) => existing.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [tasks]);

  function changeFilter(next: string) {
    setFilter(next);
    setSelectedIds(new Set<string>());
  }

  function toggleSelectionMode() {
    setSelectionMode((prev) => !prev);
    setSelectedIds(new Set<string>());
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set<string>() : new Set(list.map((task) => task.id)));
  }

  async function confirmBatchDelete() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBatchDeleting(true);
    try {
      await deleteTasks(ids, batchDeleteRemote);
      setBatchDeleteOpen(false);
      setSelectedIds(new Set<string>());
      setSelectionMode(false);
      if (detailId && ids.includes(detailId)) setDetailId(null);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBatchDeleting(false);
    }
  }

  function openCloudTheater(startId?: string) {
    setTheater({
      source: "云端",
      startId,
      items: playableTasks.map((task) => ({
        id: task.id,
        title: task.prompt.trim() || "无提示词",
        src: `/api/tasks/${task.id}/stream`,
        poster: task.coverUrl ? `/api/tasks/${task.id}/cover` : undefined,
        meta: `${task.accountLabel} · ${task.aspectRatio} · ${task.resolution}`,
      })),
    });
  }

  function openLocalTheater(startId?: string) {
    setTheater({
      source: "本地",
      startId,
      items: local.list.map((video) => ({
        id: video.taskId,
        title: video.task?.prompt?.trim() || `任务 ${video.taskId.slice(0, 8)}`,
        src: `/api/videos/local/${video.taskId}`,
        poster: video.coverUrl ?? undefined,
        meta: video.task
          ? `${video.task.accountLabel} · ${video.task.aspectRatio} · ${video.task.resolution}`
          : "仅本地文件",
      })),
    });
  }

  return (
    <div className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">创作库</h1>
          <p className="view__subtitle">
            {tab === "history"
              ? `共 ${tasks.length} 条云端记录 · ${succeeded} 个视频已完成 · 点击卡片查看详情`
              : tab === "local"
                ? "磁盘上已落盘的视频 · 删除本地文件不会影响云端记录"
                : "进行中与失败的任务 · 各阶段与失败原因实时更新"}
          </p>
        </div>
        <div className="view__head__actions">
          {tab === "history" ? (
            <>
              {playableTasks.length > 0 && (
                <button
                  className="btn btn--primary"
                  onClick={() => openCloudTheater()}
                  title="连播当前筛选结果；随机模式下首条也随机"
                >
                  <Icon name="expand" size={14} /> 全屏连播
                </button>
              )}
              <button
                className="btn"
                onClick={() => void refreshAll().catch((err) => notify(errorMessage(err), "error"))}
              >
                <Icon name="refresh" size={14} /> 刷新
              </button>
              {tasks.length > 0 && (
                <button
                  className={`btn ${selectionMode ? "btn--active" : ""}`}
                  onClick={toggleSelectionMode}
                  disabled={batchDeleting}
                  title="多选历史记录后批量删除"
                >
                  <Icon name="layers" size={14} /> {selectionMode ? "退出多选" : "多选"}
                </button>
              )}
              <div className="account-search">
                <Icon name="search" size={14} />
                <input
                  className="input account-search__input"
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  placeholder="搜索提示词、任务 ID 或账号"
                  aria-label="搜索生成记录"
                />
                {query && (
                  <button
                    type="button"
                    className="icon-btn account-search__clear"
                    onClick={() => setQuery("")}
                    aria-label="清空搜索"
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
            </>
          ) : tab === "local" ? (
            <>
              {local.list.length > 0 && (
                <button
                  className="btn btn--primary"
                  onClick={() => openLocalTheater()}
                  title="连播当前搜索结果；随机模式下首条也随机"
                >
                  <Icon name="expand" size={14} /> 全屏连播
                </button>
              )}
              <button
                className="btn"
                onClick={() => void local.load()}
                disabled={local.loading}
                title="重新读取磁盘上的视频文件"
              >
                <Icon name="refresh" size={14} /> 刷新
              </button>
              {local.videos.length > 0 && (
                <button
                  className={`btn ${local.selectionMode ? "btn--active" : ""}`}
                  onClick={local.toggleSelectionMode}
                  disabled={local.batchDeleting}
                  title="多选本地文件后批量删除"
                >
                  <Icon name="layers" size={14} /> {local.selectionMode ? "退出多选" : "多选"}
                </button>
              )}
              <div className="account-search">
                <Icon name="search" size={14} />
                <input
                  className="input account-search__input"
                  type="search"
                  value={local.query}
                  onChange={(event) => local.setQuery(event.target.value)}
                  placeholder="搜索提示词、任务 ID 或文件名"
                  aria-label="搜索本地文件"
                />
                {local.query && (
                  <button
                    type="button"
                    className="icon-btn account-search__clear"
                    onClick={() => local.setQuery("")}
                    aria-label="清空搜索"
                  >
                    <Icon name="close" size={12} />
                  </button>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>

      <div className="gallery-tabs" role="tablist" aria-label="画廊分类">
        <button
          role="tab"
          aria-selected={tab === "history"}
          className={`gallery-tab ${tab === "history" ? "is-active" : ""}`}
          onClick={() => setTab("history")}
        >
          <Icon name="cloud" size={14} /> 云端
          <span className="gallery-tab__count">{tasks.length}</span>
        </button>
        <button
          role="tab"
          aria-selected={tab === "local"}
          className={`gallery-tab ${tab === "local" ? "is-active" : ""}`}
          onClick={() => setTab("local")}
        >
          <Icon name="database" size={14} /> 本地
          {local.videos.length > 0 && (
            <span className="gallery-tab__count">{local.videos.length}</span>
          )}
        </button>
        <button
          role="tab"
          aria-selected={tab === "queue"}
          className={`gallery-tab ${tab === "queue" ? "is-active" : ""}`}
          onClick={() => setTab("queue")}
        >
          <Icon name="layers" size={14} /> 任务队列
          {queueCount > 0 && <span className="gallery-tab__count">{queueCount}</span>}
        </button>
        {tab === "history" && accounts.length > 1 && (
          <button
            type="button"
            className="gallery-tabs__action"
            onClick={toggleFiltersOpen}
            aria-expanded={filtersOpen}
            title={filtersOpen ? "收起账号筛选" : `展开全部 ${accounts.length} 个账号`}
          >
            <span>{filtersOpen ? "收起账号" : `展开账号 (${accounts.length})`}</span>
            <Icon name="chevron" size={12} className="filter-chip__chevron" />
          </button>
        )}
      </div>

      {tab === "local" && <LocalVideoGallery local={local} onTheater={openLocalTheater} />}

      {tab === "queue" && <TaskQueue all />}

      {tab === "history" && (
        <>
      <div className="filters" style={{ marginBottom: 20 }}>
        <button
          className={`filter-chip ${filter === "all" ? "is-active" : ""}`}
          onClick={() => changeFilter("all")}
        >
          <span>全部账号</span>
          <span className="filter-chip__count">{tasks.length}</span>
        </button>
        {visibleAccounts.map((account) => (
          <button
            key={account.id}
            className={`filter-chip ${filter === account.id ? "is-active" : ""}`}
            onClick={() => changeFilter(account.id)}
          >
            <span>{account.label}</span>
            <span className="filter-chip__count">
              {tasks.filter((t) => t.accountId === account.id).length}
            </span>
          </button>
        ))}
        <div className="filters__mobile">
          <span className="filters__mobile-label">账号</span>
          <SelectMenu
            id="history-account-filter"
            value={filter}
            options={accountOptions}
            onChange={changeFilter}
            menuTitle="按账号筛选"
            ariaLabel="按账号筛选生成记录"
          />
        </div>
      </div>

      {selectionMode && list.length > 0 && (
        <div className="account-selection-bar">
          <button className="filter-chip" onClick={toggleSelectAll}>
            {allSelected ? "取消全选" : "全选"}
          </button>
          <span className="account-selection-bar__count">
            已选 {selectedIds.size} / {list.length} 条记录
          </span>
          <div className="account-selection-bar__actions">
            <button
              className="btn btn--sm btn--danger"
              onClick={() => {
                setBatchDeleteRemote(false);
                setBatchDeleteOpen(true);
              }}
              disabled={!selectedIds.size || batchDeleting}
            >
              <Icon name="trash" size={12} /> 删除选中 ({selectedIds.size})
            </button>
          </div>
        </div>
      )}

      {list.length === 0 ? (
        <div className="panel">
          {keyword ? (
            <EmptyState
              icon="search"
              title="没有匹配的记录"
              subtitle={`没有找到包含「${query.trim()}」的生成记录`}
              action={
                <button className="btn" onClick={() => setQuery("")}>
                  <Icon name="close" size={14} /> 清空搜索
                </button>
              }
            />
          ) : (
            <EmptyState
              icon="history"
              title="暂无生成记录"
              subtitle="切换到工作台发起第一次生成，记录会自动出现在这里"
              action={
                <button className="btn btn--primary" style={{ marginTop: 8 }} onClick={() => setView("workspace")}>
                  <Icon name="sparkles" size={14} /> 前往工作台
                </button>
              }
            />
          )}
        </div>
      ) : (
        <div className="gallery">
          {list.map((task) => (
            <article
              key={task.id}
              className={`gallery-card ${selectionMode ? "is-selectable" : ""} ${selectedIds.has(task.id) ? "is-selected" : ""}`}
              onClick={() => {
                if (selectionMode) {
                  toggleSelected(task.id);
                  return;
                }
                setDetailId(task.id);
              }}
              role="button"
              tabIndex={0}
              aria-label={
                selectionMode
                  ? `${selectedIds.has(task.id) ? "取消选择" : "选择"}记录：${truncate(task.prompt || "无提示词", 30)}`
                  : `查看任务详情：${truncate(task.prompt || "无提示词", 30)}`
              }
              aria-pressed={selectionMode ? selectedIds.has(task.id) : undefined}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  if (selectionMode) toggleSelected(task.id);
                  else setDetailId(task.id);
                }
              }}
            >
              <div
                className="gallery-card__cover"
                style={
                  task.coverUrl
                    ? { backgroundImage: `url("/api/tasks/${task.id}/cover")` }
                    : undefined
                }
              >
                {task.status === "succeeded" ? (
                  <span className="gallery-card__play"><Icon name="play" size={15} /></span>
                ) : (
                  <span className="gallery-card__placeholder"><Icon name="film" size={20} /></span>
                )}
                {!selectionMode && task.status === "succeeded" && (
                  <button
                    className={`gallery-card__save ${savedIds.has(task.id) ? "is-saved" : ""}`}
                    onClick={(event) => {
                      event.stopPropagation();
                      void saveToLocal(task.id);
                    }}
                    onKeyDown={(event) => event.stopPropagation()}
                    disabled={savingId === task.id}
                    aria-label={savedIds.has(task.id) ? "已保存到本地" : "保存视频到本地"}
                    title={savedIds.has(task.id) ? "已保存到本地" : "保存视频与封面到本地"}
                  >
                    {savingId === task.id ? (
                      <span className="spinner" />
                    ) : (
                      <Icon name={savedIds.has(task.id) ? "check" : "download"} size={13} />
                    )}
                  </button>
                )}
                {selectionMode ? (
                  <input
                    className="gallery-card__check"
                    type="checkbox"
                    checked={selectedIds.has(task.id)}
                    onChange={() => toggleSelected(task.id)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`选择记录：${truncate(task.prompt || "无提示词", 30)}`}
                  />
                ) : (
                  <button
                    className="gallery-card__delete"
                    onClick={(event) => { event.stopPropagation(); setDeleteRemote(false); setDeleteId(task.id); }}
                    onKeyDown={(event) => event.stopPropagation()}
                    aria-label="删除这条记录"
                    title="删除这条记录"
                  >
                    <Icon name="trash" size={13} />
                  </button>
                )}
              </div>
              <div className="gallery-card__body">
                <div className="gallery-card__prompt">{truncate(task.prompt || "（无提示词）", 90)}</div>
                <div className="gallery-card__row">
                  <StatusPill status={task.status} />
                  <span className="gallery-card__time" title={formatTime(task.createdAt)}>
                    {relativeTime(task.createdAt)}
                  </span>
                </div>
                <div className="gallery-card__row gallery-card__row--sub">
                  <span className="gallery-card__account" title={task.accountLabel}>
                    {task.accountLabel}
                  </span>
                  <span className="gallery-card__spec" title={`${task.aspectRatio} · ${task.resolution}`}>
                    {task.aspectRatio} · {task.resolution}
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {detailId && (
        <TaskDetailModal
          taskId={detailId}
          onClose={() => setDetailId(null)}
          onTheater={() => {
            setDetailId(null);
            openCloudTheater(detailId);
          }}
        />
      )}

      {deleteId && (
        <Modal
          title="删除这条云端记录"
          onClose={() => setDeleteId(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setDeleteId(null)} disabled={deleting}>取消</button>
              <button className="btn btn--danger" onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting ? <span className="spinner" /> : <Icon name="trash" size={14} />}
                {deleteRemote ? "删除记录和上游视频" : "删除记录"}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.8 }}>
            只删除本站保存的这条云端记录，Viggle 账号里的任务和视频不受影响。删除后无法恢复。
            本地已保存的视频会保留；生成中的任务需要结束后才能删除。
          </p>
          <label
            className="delete-option"
            title={pendingDelete?.remoteId ? undefined : "这条记录没有上游任务 ID"}
          >
            <input
              type="checkbox"
              checked={deleteRemote}
              disabled={deleting || !pendingDelete?.remoteId}
              onChange={(event) => setDeleteRemote(event.target.checked)}
            />
            <span className="delete-option__body">
              <span className="delete-option__title">同时删除 Viggle 上游的视频</span>
              <span className="delete-option__hint">
                会调用上游接口，真实删除该账号下的任务和产出视频，不可恢复。删除失败时本地记录会保留，可以重试。
              </span>
            </span>
          </label>
        </Modal>
      )}

      {batchDeleteOpen && (
        <Modal
          title="批量删除云端记录"
          onClose={() => setBatchDeleteOpen(false)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setBatchDeleteOpen(false)} disabled={batchDeleting}>取消</button>
              <button
                className="btn btn--danger"
                onClick={() => void confirmBatchDelete()}
                disabled={batchDeleting || !selectedIds.size}
              >
                {batchDeleting ? <span className="spinner" /> : <Icon name="trash" size={14} />}
                {batchDeleteRemote
                  ? `删除 ${selectedIds.size} 条记录和上游视频`
                  : `删除 ${selectedIds.size} 条记录`}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.8 }}>
            将删除选中的 {selectedIds.size} 条云端记录，不影响 Viggle 账号里的任务和视频。删除后无法恢复。
            生成中的任务会跳过；本地已保存的视频会保留。
          </p>
          <label className="delete-option">
            <input
              type="checkbox"
              checked={batchDeleteRemote}
              disabled={batchDeleting}
              onChange={(event) => setBatchDeleteRemote(event.target.checked)}
            />
            <span className="delete-option__body">
              <span className="delete-option__title">同时删除 Viggle 上游的任务与视频</span>
              <span className="delete-option__hint">
                会逐条调用上游接口，真实删除对应账号下的任务和产出视频，不可恢复。
                没有上游任务 ID 的记录只删记录；删除失败的记录会保留，可以重试。
              </span>
            </span>
          </label>
        </Modal>
      )}
        </>
      )}

      {theater && (
        <GalleryTheater
          source={theater.source}
          items={theater.items}
          startId={theater.startId}
          onClose={() => setTheater(null)}
        />
      )}
    </div>
  );
}
