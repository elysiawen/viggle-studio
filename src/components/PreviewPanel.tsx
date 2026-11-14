"use client";

import { api, errorMessage } from "@/lib/api-client";
import { MODE_META } from "@/lib/constants";
import { formatTime, shortId, truncate } from "@/lib/format";
import { useStudio } from "./studio-context";
import { EmptyState, Icon, ProgressBar, StatusPill } from "./ui";

export function PreviewPanel() {
  const { selectedTask, tasks, notify } = useStudio();
  const task =
    selectedTask ??
    tasks.find((t) => t.status === "running" || t.status === "queued") ??
    tasks[0] ??
    null;

  const showVideo = Boolean(task && task.status === "succeeded" && task.videoUrl);
  const inProgress = Boolean(task && (task.status === "running" || task.status === "queued"));

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
      await navigator.clipboard.writeText(task.id);
      notify("任务 ID 已复制", "ok");
    } catch {
      notify("浏览器未允许访问剪贴板", "error");
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
            <video
              key={task!.id}
              src={task!.videoUrl!}
              poster={task!.coverUrl ?? undefined}
              controls
              playsInline
              preload="metadata"
            />
          ) : (
            <div className="preview-empty">
              <div className="preview-empty__play">
                <Icon name={inProgress ? "film" : "play"} size={22} />
              </div>
              <p>{inProgress ? "视频正在生成" : "生成的视频会显示在这里"}</p>
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

        <div className="meta-list">
          <div className="meta-row"><span>生成模式</span><span>{task ? MODE_META[task.mode].label : "-"}</span></div>
          <div className="meta-row"><span>画面参数</span><span>{task ? `${task.aspectRatio} · ${task.duration}s · ${task.resolution}` : "-"}</span></div>
          <div className="meta-row"><span>使用账号</span><span>{task?.accountLabel ?? "-"}</span></div>
          <div className="meta-row"><span>创建时间</span><span>{task ? formatTime(task.createdAt) : "-"}</span></div>
          <div className="meta-row"><span>任务 ID</span><span className="mono" title={task?.remoteId ?? undefined}>{task ? shortId(task.remoteId ?? task.id, 12) : "-"}</span></div>
        </div>
      </div>
    </section>
  );
}

export function TaskQueue() {
  const { tasks, selectedTask, selectTask, setView } = useStudio();
  const active = tasks.filter((t) => t.status === "running" || t.status === "queued");
  const list = active.slice(0, 12);

  return (
    <section className="panel">
      <div className="panel__head">
        <h2 className="panel__title">任务队列</h2>
        <span className="badge">{active.length} 个进行中</span>
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
                style={task.coverUrl ? { backgroundImage: `url("${task.coverUrl}")` } : undefined}
              >
                {!task.coverUrl && <Icon name="film" size={17} />}
              </div>
              <div className="queue-item__body">
                <div className="queue-item__prompt">{truncate(task.prompt || "（无提示词）", 46)}</div>
                <div className="queue-item__sub">
                  <StatusPill status={task.status} />
                  <span>{task.accountLabel}</span>
                  <span>· {formatTime(task.createdAt)}</span>
                </div>
              </div>
              {task.status === "running" && (
                <div className="queue-item__bar" title={`${task.progress}%`}>
                  <i style={{ width: `${task.progress}%` }} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
