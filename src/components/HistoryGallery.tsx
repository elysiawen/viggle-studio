"use client";

import { useEffect, useState } from "react";
import { errorMessage } from "@/lib/api-client";
import { formatTime, relativeTime, truncate } from "@/lib/format";
import { TaskDetailModal } from "./TaskDetailModal";
import { useStudio } from "./studio-context";
import { EmptyState, Icon, Modal, SelectMenu, StatusPill, type SelectOption } from "./ui";

export function HistoryGallery() {
  const { tasks, accounts, setView, refreshAll, notify, deleteTask, deleteTasks } = useStudio();
  const [filter, setFilter] = useState("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set<string>());
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);
  const [batchDeleteRemote, setBatchDeleteRemote] = useState(false);

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

  const list = filter === "all" ? tasks : tasks.filter((task) => task.accountId === filter);
  const succeeded = tasks.filter((task) => task.status === "succeeded").length;
  const accountOptions: SelectOption[] = [
    { value: "all", label: "全部账号", meta: tasks.length },
    ...accounts.map((account) => ({
      value: account.id,
      label: account.label,
      meta: tasks.filter((task) => task.accountId === account.id).length,
    })),
  ];
  const allSelected = list.length > 0 && list.every((task) => selectedIds.has(task.id));

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

  return (
    <div className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">历史画廊</h1>
          <p className="view__subtitle">
            共 {tasks.length} 条生成记录 · {succeeded} 个视频已完成 · 点击卡片查看详情
          </p>
        </div>
        <div className="view__head__actions">
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
        </div>
      </div>

      <div className="filters" style={{ marginBottom: 20 }}>
        <button
          className={`filter-chip ${filter === "all" ? "is-active" : ""}`}
          onClick={() => changeFilter("all")}
        >
          <span>全部账号</span>
          <span className="filter-chip__count">{tasks.length}</span>
        </button>
        {accounts.map((account) => (
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
                style={task.coverUrl ? { backgroundImage: `url("${task.coverUrl}")` } : undefined}
              >
                {task.status === "succeeded" ? (
                  <span className="gallery-card__play"><Icon name="play" size={15} /></span>
                ) : (
                  <span className="gallery-card__placeholder"><Icon name="film" size={20} /></span>
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

      {detailId && <TaskDetailModal taskId={detailId} onClose={() => setDetailId(null)} />}

      {deleteId && (
        <Modal
          title="删除这条记录"
          onClose={() => setDeleteId(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setDeleteId(null)} disabled={deleting}>取消</button>
              <button className="btn btn--danger" onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting ? <span className="spinner" /> : <Icon name="trash" size={14} />}
                {deleteRemote ? "删除记录和上游视频" : "仅删除本地记录"}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.8 }}>
            默认只删除本项目里的这条历史记录，不会影响 Viggle 上游；正在生成的任务将不再跟踪进度。操作不可撤销。
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
              <span className="delete-option__title">删除 Viggle 上的这条任务与视频</span>
              <span className="delete-option__hint">
                会调用上游删除接口，真实删除该账号下的生成记录与产出视频，不可恢复。上游删除失败时本地记录会保留，可重试。
              </span>
            </span>
          </label>
        </Modal>
      )}

      {batchDeleteOpen && (
        <Modal
          title="批量删除记录"
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
                  : `仅删除 ${selectedIds.size} 条本地记录`}
              </button>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.8 }}>
            默认只删除本项目里的 {selectedIds.size} 条历史记录，不影响 Viggle 上游；正在生成的任务将不再跟踪进度。操作不可撤销。
          </p>
          <label className="delete-option">
            <input
              type="checkbox"
              checked={batchDeleteRemote}
              disabled={batchDeleting}
              onChange={(event) => setBatchDeleteRemote(event.target.checked)}
            />
            <span className="delete-option__body">
              <span className="delete-option__title">删除 Viggle 上的这些任务与视频</span>
              <span className="delete-option__hint">
                会逐条调用上游删除接口，真实删除对应账号下的生成记录与产出视频，不可恢复。
                没有上游任务 ID 的记录只删除本地记录；上游删除失败的记录会保留，可重试。
              </span>
            </span>
          </label>
        </Modal>
      )}
    </div>
  );
}
