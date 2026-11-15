"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";
import { aspectRatioValue } from "@/lib/format";
import { useStudio } from "./studio-context";
import { Icon, Modal, ProgressBar, StatusPill } from "./ui";
import { VideoDetailSections } from "./VideoDetailSections";

/** 历史画廊的任务详情弹窗；数据取自全局 store，SSE 更新会实时反映在这里。 */
export function TaskDetailModal({ taskId, onClose }: { taskId: string; onClose: () => void }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const { tasks, notify } = useStudio();
  /** 先只显示封面，点了才挂 <video>，避免打开弹窗就预加载 /stream */
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    setPlaying(false);
  }, [taskId]);

  const task = tasks.find((item) => item.id === taskId);
  if (!task) return null;

  const mediaRatio = aspectRatioValue(task.aspectRatio);
  const showVideo = task.status === "succeeded" && Boolean(task.videoUrl);
  const inProgress = task.status === "running" || task.status === "queued";
  const canResume = task.status === "failed" && Boolean(task.remoteId);

  async function copy(value: string, done: string) {
    try {
      await copyText(value);
      notify(done, "ok");
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
              playing ? (
                <video
                  key={task.id}
                  src={`/api/tasks/${task.id}/stream`}
                  poster={task.coverUrl ? `/api/tasks/${task.id}/cover` : undefined}
                  controls
                  playsInline
                  ref={(el) => {
                    if (el) void el.play().catch(() => {});
                  }}
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
                <button
                  type="button"
                  className="preview-cover"
                  onClick={() => setPlaying(true)}
                  aria-label="播放视频"
                >
                  {task.coverUrl ? (
                    <img src={`/api/tasks/${task.id}/cover`} alt="" loading="lazy" />
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
              <a className="btn" href={`/api/tasks/${task.id}/source`} target="_blank" rel="noreferrer">
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

        <VideoDetailSections
          data={{
            prompt: task.prompt,
            mode: task.mode,
            aspectRatio: task.aspectRatio,
            duration: task.duration,
            resolution: task.resolution,
            qualityType: task.qualityType,
            accountLabel: task.accountLabel,
            createdAt: task.createdAt,
            finishedAt: task.finishedAt,
            taskId: task.id,
            remoteId: task.remoteId,
          }}
        />
      </div>
    </Modal>
  );
}
