"use client";

import { useState } from "react";
import { errorMessage } from "@/lib/api-client";
import { formatTime, relativeTime, truncate } from "@/lib/format";
import { TaskDetailModal } from "./TaskDetailModal";
import { useStudio } from "./studio-context";
import { EmptyState, Icon, Modal, StatusPill } from "./ui";

export function HistoryGallery() {
  const { tasks, accounts, setView, refreshAll, notify, deleteTask } = useStudio();
  const [filter, setFilter] = useState("all");
  const [detailId, setDetailId] = useState<string | null>(null);
  const [deleteId, setDeleteId] = useState<string | null>(null);
  const [deleteRemote, setDeleteRemote] = useState(false);
  const [deleting, setDeleting] = useState(false);

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

  return (
    <div className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">历史画廊</h1>
          <p className="view__subtitle">
            共 {tasks.length} 条生成记录 · {succeeded} 个视频已完成 · 点击卡片查看详情
          </p>
        </div>
        <button
          className="btn"
          onClick={() => void refreshAll().catch((err) => notify(errorMessage(err), "error"))}
        >
          <Icon name="refresh" size={14} /> 刷新
        </button>
      </div>

      <div className="filters" style={{ marginBottom: 20 }}>
        <button
          className={`filter-chip ${filter === "all" ? "is-active" : ""}`}
          onClick={() => setFilter("all")}
        >
          全部账号 · {tasks.length}
        </button>
        {accounts.map((account) => (
          <button
            key={account.id}
            className={`filter-chip ${filter === account.id ? "is-active" : ""}`}
            onClick={() => setFilter(account.id)}
          >
            {account.label} · {tasks.filter((t) => t.accountId === account.id).length}
          </button>
        ))}
      </div>

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
              className="gallery-card"
              onClick={() => setDetailId(task.id)}
              role="button"
              tabIndex={0}
              aria-label={`查看任务详情：${truncate(task.prompt || "无提示词", 30)}`}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setDetailId(task.id);
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
                <button
                  className="gallery-card__delete"
                  onClick={(event) => { event.stopPropagation(); setDeleteRemote(false); setDeleteId(task.id); }}
                  onKeyDown={(event) => event.stopPropagation()}
                  aria-label="删除这条记录"
                  title="删除这条记录"
                >
                  <Icon name="trash" size={13} />
                </button>
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
              <span className="delete-option__title">一并删除 Viggle 上的这条任务与视频</span>
              <span className="delete-option__hint">
                会调用上游删除接口，真实删除该账号下的生成记录与产出视频，不可恢复。上游删除失败时本地记录会保留，可重试。
              </span>
            </span>
          </label>
        </Modal>
      )}
    </div>
  );
}
