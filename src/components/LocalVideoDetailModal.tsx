"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import { copyText } from "@/lib/clipboard";
import { aspectRatioValue, formatBytes, formatTime } from "@/lib/format";
import type { LocalVideoView } from "@/lib/types";
import { useStudio } from "./studio-context";
import { Icon, Modal, StatusPill } from "./ui";
import { VideoDetailSections } from "./VideoDetailSections";
import { VideoPlayer } from "./video-player";

/**
 * 本地文件的详情弹窗。
 * 布局与「任务详情」一致：左侧播放器 + 右侧提示词 / 生成参数 / 记录信息，
 * 只是额外多出落盘时间、文件大小与存储方式几行。
 */
export function LocalVideoDetailModal({
  video,
  onClose,
  onDelete,
}: {
  video: LocalVideoView;
  onClose: () => void;
  onDelete: () => void;
}) {
  const stageRef = useRef<HTMLDivElement>(null);
  const { notify } = useStudio();
  /** 与任务详情一样：先只显示落盘封面，点了才挂 <video> 触发真正的视频请求 */
  const [playing, setPlaying] = useState(false);
  useEffect(() => {
    setPlaying(false);
  }, [video.taskId]);

  const src = `/api/videos/local/${video.taskId}`;
  const mediaRatio = aspectRatioValue(video.task?.aspectRatio ?? "16:9");

  async function copy(value: string, done: string) {
    try {
      await copyText(value);
      notify(done, "ok");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  return (
    <Modal
      title="本地文件详情"
      wide
      headerExtra={<StatusPill status={video.task?.status ?? "succeeded"} />}
      onClose={onClose}
    >
      <div className="detail-layout">
        <div className="detail-media">
          <div
            className="preview-stage"
            ref={stageRef}
            style={{ "--media-ratio": String(mediaRatio) } as CSSProperties}
          >
            {playing ? (
              <VideoPlayer
                key={video.taskId}
                src={src}
                poster={video.coverUrl ?? undefined}
                autoPlay
                onRatio={(ratio) =>
                  stageRef.current?.style.setProperty("--media-ratio", String(ratio))
                }
              />
            ) : (
              <button
                type="button"
                className="preview-cover"
                onClick={() => setPlaying(true)}
                aria-label="播放本地视频"
              >
                {video.coverUrl ? (
                  <img src={video.coverUrl} alt="" loading="lazy" />
                ) : (
                  <span className="preview-cover__placeholder">
                    <Icon name="film" size={22} />
                  </span>
                )}
                <span className="preview-cover__play">
                  <Icon name="play" size={18} />
                </span>
              </button>
            )}
          </div>

          <div className="result-actions">
            <a className="btn btn--primary" href={`${src}?download=1`} download>
              <Icon name="download" size={14} /> 下载视频
            </a>
            <button className="btn btn--ghost" onClick={() => void copy(video.task?.remoteId ?? video.taskId, "任务 ID 已复制")}>
              <Icon name="copy" size={14} /> 复制 ID
            </button>
            <button className="btn btn--danger" onClick={onDelete}>
              <Icon name="trash" size={14} /> 删除本地文件
            </button>
          </div>
        </div>

        <VideoDetailSections
          data={{
            prompt: video.task?.prompt ?? "",
            mode: video.task?.mode ?? "text",
            aspectRatio: video.task?.aspectRatio ?? "16:9",
            duration: video.task?.duration ?? 0,
            resolution: video.task?.resolution ?? "-",
            qualityType: video.task?.qualityType ?? 0,
            accountLabel: video.task?.accountLabel ?? "（历史记录已删除）",
            createdAt: video.task?.createdAt ?? video.savedAt,
            finishedAt: video.task?.finishedAt ?? null,
            taskId: video.taskId,
            remoteId: video.task?.remoteId ?? null,
          }}
          extraRecords={[
            ["落盘时间", formatTime(video.savedAt)],
            ["文件大小", formatBytes(video.size)],
            ["存储方式", video.encrypted ? "SKE 加密（.ske）" : "明文"],
          ]}
        />
      </div>
    </Modal>
  );
}
