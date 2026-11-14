"use client";

import { useRef, type CSSProperties } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { MODE_META } from "@/lib/constants";
import { formatTime, shortId } from "@/lib/format";
import { useStudio } from "./studio-context";
import { Icon, Modal, ProgressBar, StatusPill } from "./ui";

/** "9:16" → 0.5625；解析失败时回落到 16:9。 */
function aspectRatioValue(value: string): number {
  const [w, h] = value.split(":").map(Number);
  if (!w || !h || !Number.isFinite(w) || !Number.isFinite(h)) return 16 / 9;
  return w / h;
}

/** 历史画廊的任务详情弹窗；数据取自全局 store，SSE 更新会实时反映在这里。 */
export function TaskDetailModal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const { tasks, notify } = useStudio();
  const task = tasks.find((item) => item.id === taskId);
  if (!task) return null;

  const mediaRatio = aspectRatioValue(task.aspectRatio);
  const showVideo = task.status === "succeeded" && Boolean(task.videoUrl);
  const inProgress = task.status === "running" || task.status === "queued";
  const canResume = task.status === "failed" && Boolean(task.remoteId);

  async function copy(value: string, done: string) {
    try {
      await navigator.clipboard.writeText(value);
      notify(done, "ok");
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

  const params: Array<[string, string]> = [
    ["生成模式", MODE_META[task.mode].label],
    ["画面比例", task.aspectRatio],
    ["时长", `${task.duration} 秒`],
    ["分辨率", task.resolution],
    ["生成质量", task.qualityType === 0 ? "Flash · 免费" : `Type ${task.qualityType}`],
    ["使用账号", task.accountLabel],
  ];

  return (
    <Modal
      title="任务详情"
      wide
      headerExtra={<StatusPill status={task.status} />}
      onClose={onClose}
    >
      <div className="detail-layout">
        <div className="detail-media">
          <div
            className="preview-stage"
            key={task.id}
            ref={stageRef}
            style={{ "--media-ratio": String(mediaRatio) } as CSSProperties}
          >
            {showVideo ? (
              <video
                key={task.id}
                src={task.videoUrl!}
                poster={task.coverUrl ?? undefined}
                controls
                playsInline
                preload="metadata"
                onLoadedMetadata={(event) => {
                  const video = event.currentTarget;
                  if (video.videoWidth && video.videoHeight) {
                    stageRef.current?.style.setProperty(
                      "--media-ratio",
                      String(video.videoWidth / video.videoHeight)
                    );
                  }
                }}
              />
            ) : (
              <div className="preview-empty">
                <div className="preview-empty__play">
                  <Icon name={inProgress ? "film" : "play"} size={22} />
                </div>
                <p>{inProgress ? "视频正在生成" : task.status === "failed" ? "生成失败" : "暂无视频"}</p>
                <span>
                  {inProgress
                    ? `${task.stage} · 后台会持续同步进度`
                    : "完成后可在此直接播放与下载"}
                </span>
              </div>
            )}
          </div>

          {inProgress && (
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
              <a className="btn btn--primary" href={`/api/tasks/${task.id}/download`} download>
                <Icon name="download" size={14} /> 下载视频
              </a>
            )}
            {showVideo && (
              <a className="btn" href={task.videoUrl!} target="_blank" rel="noreferrer">
                <Icon name="external" size={14} /> 原始地址
              </a>
            )}
            {canResume && (
              <button className="btn" onClick={() => void resumeTracking()}>
                <Icon name="refresh" size={14} /> 恢复跟踪
              </button>
            )}
            <button className="btn btn--ghost" onClick={() => void copy(task.remoteId ?? task.id, "任务 ID 已复制")}>
              <Icon name="copy" size={14} /> 复制 ID
            </button>
          </div>
        </div>

        <div className="detail-info">
          <div className="detail-section">
            <div className="detail-section__head">
              <h3 className="detail-section__title">完整提示词</h3>
              {task.prompt && (
                <button className="btn btn--ghost btn--sm" onClick={() => void copy(task.prompt, "提示词已复制")}>
                  <Icon name="copy" size={13} /> 复制提示词
                </button>
              )}
            </div>
            <div className="detail-prompt">{task.prompt || "（无提示词）"}</div>
          </div>

          <div className="detail-section">
            <h3 className="detail-section__title">生成参数</h3>
            <div className="detail-grid">
              {params.map(([label, value]) => (
                <div className="detail-cell" key={label}>
                  <span>{label}</span>
                  <b title={value}>{value}</b>
                </div>
              ))}
            </div>
          </div>

          <div className="detail-section">
            <h3 className="detail-section__title">记录信息</h3>
            <div className="meta-list">
              <div className="meta-row"><span>创建时间</span><span>{formatTime(task.createdAt)}</span></div>
              <div className="meta-row"><span>完成时间</span><span>{formatTime(task.finishedAt)}</span></div>
              <div className="meta-row"><span>本地记录 ID</span><span className="mono">{shortId(task.id, 12)}</span></div>
              <div className="meta-row">
                <span>上游任务 ID</span>
                <span className="mono" title={task.remoteId ?? undefined}>
                  {task.remoteId ? shortId(task.remoteId, 18) : "-"}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </Modal>
  );
}
