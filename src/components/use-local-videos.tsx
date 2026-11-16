"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import type { LocalVideoView } from "@/lib/types";
import { useStudio } from "./studio-context";

/** 搜索匹配提示词、任务 ID、上游 ID、账号与文件名。 */
function matches(video: LocalVideoView, keyword: string): boolean {
  if (!keyword) return true;
  const fields = [
    video.task?.prompt,
    video.task?.accountLabel,
    video.task?.remoteId,
    video.taskId,
    video.filename,
  ];
  return fields.some((field) => field?.toLowerCase().includes(keyword));
}

/**
 * 「本地文件」标签页的全部状态。
 * 提到 hook 里是为了让页面顶部（标题 / 刷新 / 多选 / 搜索）与内容区共用同一份状态，
 * 视觉位置才能和历史记录完全一致。
 */
export function useLocalVideos(active: boolean) {
  const { notify } = useStudio();
  const [videos, setVideos] = useState<LocalVideoView[]>([]);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState<LocalVideoView | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<LocalVideoView | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [query, setQuery] = useState("");
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [batchDeleteOpen, setBatchDeleteOpen] = useState(false);
  const [batchDeleting, setBatchDeleting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ videos: LocalVideoView[] }>("/api/videos/local");
      setVideos(data.videos);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  // 切到本地标签页才请求，避免每次打开画廊都多打一次接口
  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const keyword = query.trim().toLowerCase();
  const list = useMemo(() => videos.filter((video) => matches(video, keyword)), [videos, keyword]);
  const allSelected = list.length > 0 && list.every((video) => selectedIds.has(video.taskId));
  const totalSize = videos.reduce((sum, video) => sum + video.size, 0);

  function toggleSelected(taskId: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(taskId)) next.delete(taskId);
      else next.add(taskId);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set() : new Set(list.map((video) => video.taskId)));
  }

  function toggleSelectionMode() {
    if (selectionMode) setSelectedIds(new Set());
    setSelectionMode(!selectionMode);
  }

  function openDetail(video: LocalVideoView) {
    if (selectionMode) toggleSelected(video.taskId);
    else setPlaying(video);
  }

  async function confirmDelete() {
    if (!deleteTarget) return;
    const { taskId } = deleteTarget;
    setDeleting(true);
    try {
      await api(`/api/videos/local/${taskId}`, { method: "DELETE" });
      setVideos((prev) => prev.filter((video) => video.taskId !== taskId));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(taskId);
        return next;
      });
      if (playing?.taskId === taskId) setPlaying(null);
      setDeleteTarget(null);
      notify("本地文件已删除，历史记录保持不变", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setDeleting(false);
    }
  }

  async function confirmBatchDelete() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBatchDeleting(true);
    const removed = new Set<string>();
    let failed = 0;
    for (const taskId of ids) {
      try {
        await api(`/api/videos/local/${taskId}`, { method: "DELETE" });
        removed.add(taskId);
      } catch {
        failed += 1;
      }
    }
    setVideos((prev) => prev.filter((video) => !removed.has(video.taskId)));
    setSelectedIds(new Set());
    setSelectionMode(false);
    setBatchDeleting(false);
    setBatchDeleteOpen(false);
    notify(
      failed > 0
        ? `已删除 ${removed.size} 个本地文件，${failed} 个删除失败`
        : `已删除 ${removed.size} 个本地文件，历史记录保持不变`,
      failed > 0 ? "error" : "ok"
    );
    void load();
  }

  return {
    videos,
    list,
    totalSize,
    loading,
    keyword,
    query,
    setQuery,
    load,
    selectionMode,
    toggleSelectionMode,
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
  };
}

export type LocalVideosState = ReturnType<typeof useLocalVideos>;
