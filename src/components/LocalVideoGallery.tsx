"use client";

import { useCallback, useEffect, useState } from "react";
import { api, apiJson, errorMessage } from "@/lib/api-client";
import { formatBytes, formatTime, relativeTime, truncate } from "@/lib/format";
import type { LocalVideoView } from "@/lib/types";
import { LocalVideoDetailModal } from "./LocalVideoDetailModal";
import { useStudio } from "./studio-context";
import { EmptyState, Icon, Modal } from "./ui";

/** 卡片标题：能对上记录用提示词，对不上就退回任务 ID。 */
function titleOf(video: LocalVideoView): string {
  return video.task?.prompt?.trim() || `任务 ${video.taskId.slice(0, 8)}`;
}

/**
 * 画廊「本地文件」标签页。
 * 删除只作用于磁盘文件，历史记录与上游视频各自独立，互不牵连。
 */
export function LocalVideoGallery() {
  const { notify } = useStudio();
  const [videos, setVideos] = useState<LocalVideoView[]>([]);
  const [loading, setLoading] = useState(true);
  const [playing, setPlaying] = useState<LocalVideoView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LocalVideoView | null>(null);
  const [deleting, setDeleting] = useState(false);
  /** 落盘加密开关：主密码在服务端 env，前端只知道开关与是否可用。 */
  const [encryption, setEncryption] = useState<{ enabled: boolean; available: boolean } | null>(null);
  const [toggling, setToggling] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [data, state] = await Promise.all([
        api<{ videos: LocalVideoView[] }>("/api/videos/local"),
        api<{ enabled: boolean; available: boolean }>("/api/storage/encryption").catch(() => null),
      ]);
      setVideos(data.videos);
      if (state) setEncryption(state);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function confirmDelete() {
    if (!deleteTarget) return;
    const { taskId } = deleteTarget;
    setDeleting(true);
    try {
      await api(`/api/videos/local/${taskId}`, { method: "DELETE" });
      setVideos((prev) => prev.filter((video) => video.taskId !== taskId));
      if (playing?.taskId === taskId) setPlaying(null);
      setDeleteTarget(null);
      notify("本地文件已删除，历史记录保持不变", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setDeleting(false);
    }
  }

  async function toggleEncryption() {
    if (!encryption || toggling) return;
    const enabled = !encryption.enabled;
    setToggling(true);
    try {
      const state = await apiJson<{ enabled: boolean; available: boolean }>(
        "/api/storage/encryption",
        "PATCH",
        { enabled }
      );
      setEncryption(state);
      notify(
        state.enabled ? "已开启加密落盘：新任务将存为 .ske 文件" : "已关闭加密落盘：新任务按明文存储",
        "ok"
      );
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setToggling(false);
    }
  }

  const totalSize = videos.reduce((sum, video) => sum + video.size, 0);

  return (
    <div>
      <div className="local-toolbar">
        <span className="local-toolbar__meta">
          {videos.length
            ? `${videos.length} 个本地视频 · 共 ${formatBytes(totalSize)}`
            : "本地暂无已落盘的视频"}
        </span>
        <div className="local-toolbar__actions">
          {encryption && (
            <button
              className={`btn btn--sm ${encryption.enabled ? "btn--active" : "btn--ghost"}`}
              onClick={() => void toggleEncryption()}
              disabled={!encryption.available || toggling}
              aria-pressed={encryption.enabled}
              title={
                encryption.available
                  ? "切换后只影响新落盘的文件，已有文件保持不变"
                  : "未配置 STORAGE_PASSWORD，无法开启加密落盘"
              }
            >
              {toggling ? <span className="spinner" /> : <Icon name="shield" size={14} />}
              加密落盘：{encryption.enabled ? "开" : "关"}
            </button>
          )}
          <button className="btn btn--sm" onClick={() => void load()} disabled={loading}>
            {loading ? <span className="spinner" /> : <Icon name="refresh" size={14} />} 刷新
          </button>
        </div>
      </div>

      {videos.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon="database"
            title={loading ? "正在读取本地目录" : "本地暂无视频"}
            subtitle={
              loading
                ? "扫描落盘目录中…"
                : "任务生成成功会自动下载到这里；目录与开关见 VIDEO_STORAGE_DIR / VIDEO_AUTO_SAVE"
            }
          />
        </div>
      ) : (
        <div className="gallery">
          {videos.map((video) => (
            <article
              key={video.taskId}
              className="gallery-card"
              role="button"
              tabIndex={0}
              aria-label={`播放本地视频：${truncate(titleOf(video), 30)}`}
              onClick={() => setPlaying(video)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  setPlaying(video);
                }
              }}
            >
              <div className="gallery-card__cover">
                {video.coverUrl ? (
                  <img
                    className="local-video__thumb"
                    src={video.coverUrl}
                    alt=""
                    loading="lazy"
                    aria-hidden="true"
                  />
                ) : (
                  <video
                    className="local-video__thumb"
                    src={`/api/videos/local/${video.taskId}`}
                    preload="metadata"
                    muted
                    playsInline
                    aria-hidden="true"
                  />
                )}
                <span className="gallery-card__play">
                  <Icon name="play" size={15} />
                </span>
                <button
                  className="gallery-card__delete"
                  onClick={(event) => {
                    event.stopPropagation();
                    setDeleteTarget(video);
                  }}
                  onKeyDown={(event) => event.stopPropagation()}
                  aria-label="删除本地文件"
                  title="只删除本地文件"
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
              <div className="gallery-card__body">
                <div className="gallery-card__prompt">{truncate(titleOf(video), 90)}</div>
                <div className="gallery-card__row">
                  {video.encrypted && (
                    <span className="local-badge" title="Sakura Encryptor（.ske）加密存储">
                      SKE
                    </span>
                  )}
                  <span className="gallery-card__time">{formatBytes(video.size)}</span>
                  <span className="gallery-card__time" title={formatTime(video.savedAt)}>
                    {relativeTime(video.savedAt)}
                  </span>
                </div>
                <div className="gallery-card__row gallery-card__row--sub">
                  <span className="gallery-card__account" title={video.task?.accountLabel}>
                    {video.task?.accountLabel ?? "仅本地文件"}
                  </span>
                  <span
                    className="gallery-card__spec"
                    title={
                      video.task
                        ? `${video.task.aspectRatio} · ${video.task.duration}s · ${video.task.resolution}`
                        : undefined
                    }
                  >
                    {video.task
                      ? `${video.task.duration}s · ${video.task.resolution}`
                      : "无记录信息"}
                  </span>
                </div>
              </div>
            </article>
          ))}
        </div>
      )}

      {playing && (
        <LocalVideoDetailModal
          video={playing}
          onClose={() => setPlaying(null)}
          onDelete={() => {
            setDeleteTarget(playing);
            setPlaying(null);
          }}
        />
      )}

      {deleteTarget && (
        <Modal
          title="删除本地文件"
          onClose={() => setDeleteTarget(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setDeleteTarget(null)} disabled={deleting}>
                取消
              </button>
              <button className="btn btn--danger" onClick={() => void confirmDelete()} disabled={deleting}>
                {deleting ? <span className="spinner" /> : <Icon name="trash" size={14} />}
                删除本地文件
              </button>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.8 }}>
            只删除磁盘上的这个视频文件（{formatBytes(deleteTarget.size)}）。
            历史记录和 Viggle 上游视频都会保留，之后仍可在「历史记录」里重新下载；本地文件删除后无法从本机恢复。
          </p>
        </Modal>
      )}
    </div>
  );
}
