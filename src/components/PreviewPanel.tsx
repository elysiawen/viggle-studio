"use client";

import { useEffect, useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";
import { MODE_META } from "@/lib/constants";
import { formatTime, shortId, truncate } from "@/lib/format";
import { useStudio } from "./studio-context";
import { EmptyState, Icon, Modal, ProgressBar, StatusPill } from "./ui";
import { VideoPlayer } from "./video-player";

export function PreviewPanel() {
  const { selectedTask, tasks, notify } = useStudio();
  const task =
    selectedTask ??
    tasks.find((t) => t.status === "preparing" || t.status === "running" || t.status === "queued") ??
    tasks[0] ??
    null;

  const showVideo = Boolean(task && task.status === "succeeded" && task.videoUrl);
  const inProgress = Boolean(
    task && (task.status === "preparing" || task.status === "running" || task.status === "queued")
  );

  /** 默认只显示封面图，点了才挂 <video> —— 否则 preload 会立刻请求 /stream */
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    setPlaying(false);
  }, [task?.id]);

  async function refreshTask() {
    if (!task) return;
    try {
      await api(`/api/tasks/${task.id}/refresh`, { method: "POST" });
      notify("已刷新任务状态", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  async function copyId() {
    if (!task) return;
    try {
      await copyText(task.id);
      notify("任务 ID 已复制", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  async function resumeTracking() {
    if (!task) return;
    try {
      await api(`/api/tasks/${task.id}/resume`, { method: "POST" });
      notify("已恢复跟踪，正在重新同步上游状态", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">实时预览</h2>
        {task ? <StatusPill status={task.status} /> : <span className="badge">待生成</span>}
      </div>
      <div className="panel__body">
        <div className="preview-stage">
          {showVideo ? (
            playing ? (
              <VideoPlayer
                key={task!.id}
                src={`/api/tasks/${task!.id}/stream`}
                poster={task!.coverUrl ? `/api/tasks/${task!.id}/cover` : undefined}
                autoPlay
              />
            ) : (
              <button
                type="button"
                className="preview-cover"
                onClick={() => setPlaying(true)}
                aria-label="播放视频"
              >
                {task!.coverUrl ? (
                  <img src={`/api/tasks/${task!.id}/cover`} alt="" loading="lazy" />
                ) : (
                  <span className="preview-cover__placeholder"><Icon name="film" size={22} /></span>
                )}
                <span className="preview-cover__play"><Icon name="play" size={18} /></span>
              </button>
            )
          ) : (
            <div className="preview-empty">
              <div className="preview-empty__play">
                <Icon name={inProgress ? "film" : "play"} size={22} />
              </div>
              <p>{inProgress ? "任务处理中" : "生成的视频会显示在这里"}</p>
              <span>
                {inProgress
                  ? `${task!.stage} · 完成后自动播放`
                  : "5s · 768p · MP4 · 提交任务后实时更新"}
              </span>
            </div>
          )}
        </div>

        {inProgress && task && (
          <div className="progress-block">
            <div className="progress-block__head">
              <span>{task.stage}</span>
              <b>{task.progress}%</b>
            </div>
            <ProgressBar value={task.progress} />
          </div>
        )}

        <div className="result-actions">
          {showVideo && (
            <a className="btn btn--primary" href={`/api/tasks/${task!.id}/download`} download>
              <Icon name="download" size={14} /> 下载视频
            </a>
          )}
          {task && inProgress && (
            <button className="btn" onClick={() => void refreshTask()}>
              <Icon name="refresh" size={14} /> 刷新状态
            </button>
          )}
          {task?.status === "failed" && task.remoteId && (
            <button className="btn" onClick={() => void resumeTracking()}>
              <Icon name="refresh" size={14} /> 恢复跟踪
            </button>
          )}
          {task && (
            <button className="btn btn--ghost" onClick={() => void copyId()}>
              <Icon name="copy" size={14} /> 复制 ID
            </button>
          )}
        </div>

        <div className="preview-meta">
          <div className="preview-meta__item">
            <span>生成模式</span>
            <b>{task ? MODE_META[task.mode].label : "-"}</b>
          </div>
          <div className="preview-meta__item">
            <span>画面参数</span>
            <b>{task ? `${task.aspectRatio} · ${task.duration}s · ${task.resolution}` : "-"}</b>
          </div>
          <div className="preview-meta__item">
            <span>使用账号</span>
            <b title={task?.accountLabel}>{task?.accountLabel ?? "-"}</b>
          </div>
          <div className="preview-meta__item">
            <span>创建时间</span>
            <b>{task ? formatTime(task.createdAt) : "-"}</b>
          </div>
          <div className="preview-meta__item preview-meta__item--wide">
            <span>任务 ID</span>
            <b className="mono" title={task?.remoteId ?? undefined}>
              {task ? shortId(task.remoteId ?? task.id, 18) : "-"}
            </b>
          </div>
        </div>
      </div>
    </section>
  );
}

export function TaskQueue({ all = false }: { all?: boolean } = {}) {
  const { tasks, selectedTask, selectTask, setView, retryTask, deleteTask, notify } = useStudio();
  const [retryingId, setRetryingId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);
  // 进行中的任务，以及失败后仍留在队列里的任务：
  // 失败任务要一直看得见（含错误原因），能重试的才显示重试按钮，
  // 直到用户在创作库里删掉这条记录。
  const active = tasks.filter(
    (t) =>
      t.status === "preparing" ||
      t.status === "queued" ||
      t.status === "running" ||
      t.status === "failed"
  );
  // 侧栏只留 12 条：进行中的任务必须优先展示，不能被一堆旧失败记录挤掉。
  const ongoing = active.filter(
    (t) => t.status === "preparing" || t.status === "queued" || t.status === "running"
  );
  const failures = active.filter((t) => t.status === "failed");
  // 独立的队列标签页展示全部。
  const list = all ? active : [...ongoing, ...failures].slice(0, 12);

  async function retry(id: string) {
    if (retryingId) return;
    setRetryingId(id);
    try {
      await retryTask(id);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setRetryingId(null);
    }
  }

  async function remove(id: string) {
    if (deletingId) return;
    setDeletingId(id);
    try {
      await deleteTask(id);
      setDeleteTarget(null);
      notify("已删除该任务", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <>
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">任务队列</h2>
        <span className="badge">{active.length} 个待处理</span>
      </div>
      {list.length === 0 ? (
        <EmptyState icon="layers" title="暂无进行中的任务" subtitle="提交生成后，进行中的任务会实时出现在这里" />
      ) : (
        <div className="queue">
          {list.map((task) => (
            <div
              key={task.id}
              className={`queue-item ${selectedTask?.id === task.id ? "is-selected" : ""}`}
              onClick={() => { selectTask(task.id); setView("workspace"); }}
              role="button"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  selectTask(task.id);
                  setView("workspace");
                }
              }}
            >
              <div
                className="queue-item__thumb"
                style={
                  task.coverUrl
                    ? { backgroundImage: `url("/api/tasks/${task.id}/cover")` }
                    : undefined
                }
              >
                {!task.coverUrl && <Icon name="film" size={17} />}
              </div>
              <div className="queue-item__body">
                <div className="queue-item__prompt">{truncate(task.prompt || "（无提示词）", 46)}</div>
                <div className="queue-item__sub">
                  <StatusPill status={task.status} label={task.stage} />
                  <span>{task.accountLabel}</span>
                  <span>· {formatTime(task.createdAt)}</span>
                </div>
                {task.status === "failed" && task.errorMessage && (
                  <div className="queue-item__error" title={task.errorMessage}>
                    {truncate(task.errorMessage, 40)}
                    {!task.retryable && " · 不可重试"}
                  </div>
                )}
              </div>
              {task.status === "failed" ? (
                <div className="queue-item__actions">
                  {task.retryable && (
                    <button
                      className="btn btn--sm queue-item__retry"
                      disabled={retryingId !== null || deletingId !== null}
                      onClick={(event) => {
                        event.stopPropagation();
                        void retry(task.id);
                      }}
                    >
                      {retryingId === task.id ? <span className="spinner" /> : <Icon name="refresh" size={12} />}
                      重试
                    </button>
                  )}
                  <button
                    className="btn btn--sm btn--danger"
                    disabled={retryingId !== null || deletingId !== null}
                    onClick={(event) => {
                      event.stopPropagation();
                      setDeleteTarget(task.id);
                    }}
                    title="删除这条失败记录"
                  >
                    {deletingId === task.id ? <span className="spinner" /> : <Icon name="trash" size={12} />}
                    删除
                  </button>
                </div>
              ) : (
                task.status === "running" && (
                  <div className="queue-item__bar" title={`${task.progress}%`}>
                    <i style={{ width: `${task.progress}%` }} />
                  </div>
                )
              )}
            </div>
          ))}
        </div>
      )}
    </section>

    {deleteTarget && (() => {
      const pending = tasks.find((t) => t.id === deleteTarget);
      return (
        <Modal
          title="删除这条失败记录"
          onClose={() => !deletingId && setDeleteTarget(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setDeleteTarget(null)} disabled={deletingId !== null}>
                取消
              </button>
              <button
                className="btn btn--danger"
                disabled={deletingId !== null}
                onClick={() => void remove(deleteTarget)}
              >
                {deletingId === deleteTarget ? <span className="spinner" /> : <Icon name="trash" size={14} />}
                删除
              </button>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.8 }}>
            {pending
              ? `将删除这条失败任务的本地记录（${truncate(pending.prompt || "(无提示词)", 60)}）。`
              : "将删除这条失败任务的本地记录。"}
            操作不可撤销；本次只删本地，不会影响 Viggle 上游。
          </p>
        </Modal>
      );
    })()}
    </>
  );
}
