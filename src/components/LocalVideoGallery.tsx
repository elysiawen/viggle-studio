"use client";

import { formatBytes, formatTime, relativeTime, truncate } from "@/lib/format";
import type { LocalVideoView } from "@/lib/types";
import { LocalVideoDetailModal } from "./LocalVideoDetailModal";
import { EmptyState, Icon, Modal } from "./ui";
import type { LocalVideosState } from "./use-local-videos";

/** 卡片标题：能对上记录用提示词，对不上就退回任务 ID。 */
function titleOf(video: LocalVideoView): string {
  return video.task?.prompt?.trim() || `任务 ${video.taskId.slice(0, 8)}`;
}

/**
 * 画廊「本地文件」标签页的内容区。
 * 顶部标题与操作按钮由父组件（HistoryGallery）渲染，这里只负责列表与弹窗，
 * 保证两个标签页的操作区位置完全一致。状态来自 useLocalVideos。
 */
export function LocalVideoGallery({ local }: { local: LocalVideosState }) {
  const {
    videos,
    list,
    totalSize,
    loading,
    keyword,
    query,
    setQuery,
    selectionMode,
    selectedIds,
    toggleSelected,
    toggleSelectAll,
    allSelected,
    openDetail,
    playing,
    setPlaying,
    deleteTarget,
    setDeleteTarget,
    confirmDelete,
    deleting,
    batchDeleteOpen,
    setBatchDeleteOpen,
    confirmBatchDelete,
    batchDeleting,
  } = local;

  return (
    <div>
      <div className="local-toolbar">
        <span className="local-toolbar__meta">
          {loading && !videos.length
            ? "正在读取本地记录…"
            : videos.length
              ? `共 ${videos.length} 个文件 · 占用 ${formatBytes(totalSize)}`
              : "共 0 个文件"}
        </span>
      </div>

      {selectionMode && list.length > 0 && (
        <div className="account-selection-bar">
          <button className="filter-chip" onClick={toggleSelectAll}>
            {allSelected ? "取消全选" : "全选"}
          </button>
          <span className="account-selection-bar__count">
            已选 {selectedIds.size} / {list.length} 个文件
          </span>
          <div className="account-selection-bar__actions">
            <button
              className="btn btn--sm btn--danger"
              onClick={() => setBatchDeleteOpen(true)}
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
              title="没有匹配的本地文件"
              subtitle={`没有找到包含「${query.trim()}」的本地文件`}
              action={
                <button className="btn" onClick={() => setQuery("")}>
                  <Icon name="close" size={14} /> 清空搜索
                </button>
              }
            />
          ) : (
            <EmptyState
              icon="database"
              title={loading ? "正在读取本地记录" : "本地暂无视频"}
              subtitle={
                loading
                  ? "读取本地落盘记录中…"
                  : "任务生成成功会自动下载到这里；自动存盘、加密与存储目录见设置页"
              }
            />
          )}
        </div>
      ) : (
        <div className="gallery">
          {list.map((video) => (
            <article
              key={video.taskId}
              className={`gallery-card ${selectionMode ? "is-selectable" : ""} ${
                selectedIds.has(video.taskId) ? "is-selected" : ""
              }`}
              role="button"
              tabIndex={0}
              aria-label={
                selectionMode
                  ? `${selectedIds.has(video.taskId) ? "取消选择" : "选择"}本地文件：${truncate(titleOf(video), 30)}`
                  : `查看本地文件详情：${truncate(titleOf(video), 30)}`
              }
              aria-pressed={selectionMode ? selectedIds.has(video.taskId) : undefined}
              onClick={() => openDetail(video)}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  openDetail(video);
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
                {selectionMode ? (
                  <input
                    className="gallery-card__check"
                    type="checkbox"
                    checked={selectedIds.has(video.taskId)}
                    onChange={() => toggleSelected(video.taskId)}
                    onClick={(event) => event.stopPropagation()}
                    aria-label={`选择本地文件：${truncate(titleOf(video), 30)}`}
                  />
                ) : (
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
                )}
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

      {batchDeleteOpen && (
        <Modal
          title={`删除 ${selectedIds.size} 个本地文件`}
          onClose={() => setBatchDeleteOpen(false)}
          footer={
            <>
              <button
                className="btn btn--ghost"
                onClick={() => setBatchDeleteOpen(false)}
                disabled={batchDeleting}
              >
                取消
              </button>
              <button
                className="btn btn--danger"
                onClick={() => void confirmBatchDelete()}
                disabled={batchDeleting}
              >
                {batchDeleting ? <span className="spinner" /> : <Icon name="trash" size={14} />}
                删除选中文件
              </button>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.8 }}>
            只删除选中 {selectedIds.size} 个文件的本地副本与封面。
            历史记录和 Viggle 上游视频都会保留，之后仍可在「历史记录」里重新下载；本地文件删除后无法从本机恢复。
          </p>
        </Modal>
      )}
    </div>
  );
}
