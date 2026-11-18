"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { MAX_REFERENCE_MEDIA } from "@/lib/constants";
import type { LibraryAssetView, LocalAssetView } from "@/lib/types";
import { useStudio } from "./studio-context";
import { Icon, Modal } from "./ui";
import { useAutoLoadMore } from "./use-auto-load-more";

type LibraryKind = "image" | "video";
type Tab = "local" | "cloud";

interface CloudPage {
  items: LibraryAssetView[];
  hasMore: boolean;
  page: number;
}

interface LocalPage {
  items: LocalAssetView[];
  total: number;
  totalBytes: number;
  page: number;
  hasMore: boolean;
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

export function LibraryPicker({ onClose }: { onClose: () => void }) {
  const { drafts, addLibraryAssets, addLocalAssets, notify, me, ensureAutoAccount } = useStudio();
  const [tab, setTab] = useState<Tab>("local");
  const [kind, setKind] = useState<LibraryKind>("image");
  // 本地素材箱只保留图片/视频混合列表；这里按切换的分类过滤展示。
  const [localItems, setLocalItems] = useState<LocalAssetView[]>([]);
  const [localTotal, setLocalTotal] = useState(0);
  const [localBytes, setLocalBytes] = useState(0);
  const [localPage, setLocalPage] = useState(1);
  const [localHasMore, setLocalHasMore] = useState(false);
  const [cloudItems, setCloudItems] = useState<LibraryAssetView[]>([]);
  const [cloudPage, setCloudPage] = useState(1);
  const [cloudHasMore, setCloudHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const requestRef = useRef(0);

  const used = drafts.filter((d) => d.role === "reference").length;
  const room = Math.max(0, MAX_REFERENCE_MEDIA - used);

  const loadLocal = useCallback(
    async (nextKind: LibraryKind, nextPage: number, append: boolean) => {
      const requestId = ++requestRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const result = await api<LocalPage>(`/api/assets/local?kind=${nextKind}&page=${nextPage}`);
        if (requestId !== requestRef.current) return;
        setLocalItems((prev) => (append ? [...prev, ...result.items] : result.items));
        setLocalTotal(result.total);
        setLocalBytes(result.totalBytes);
        setLocalPage(result.page);
        setLocalHasMore(result.hasMore);
      } catch (err) {
        if (requestId === requestRef.current) notify(errorMessage(err), "error");
      } finally {
        if (requestId === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [notify]
  );

  const loadCloud = useCallback(
    async (nextKind: LibraryKind, nextPage: number, append: boolean) => {
      const requestId = ++requestRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const result = await api<CloudPage>(`/api/assets/library?kind=${nextKind}&page=${nextPage}`);
        if (requestId !== requestRef.current) return;
        setCloudItems((prev) => (append ? [...prev, ...result.items] : result.items));
        setCloudPage(result.page);
        setCloudHasMore(result.hasMore);
      } catch (err) {
        if (requestId === requestRef.current) notify(errorMessage(err), "error");
      } finally {
        if (requestId === requestRef.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [notify]
  );

  useEffect(() => {
    let cancelled = false;
    setSelected([]);
    setLoadingMore(false);
    setLoading(true);
    if (tab === "local") {
      setLocalItems([]);
      setLocalPage(1);
      setLocalHasMore(false);
    } else {
      setCloudItems([]);
      setCloudPage(1);
      setCloudHasMore(false);
    }

    // 本地素材箱不依赖账号，没有可用账号时也应该能正常浏览；只有云端素材库需要先定号。
    if (tab === "local") {
      void loadLocal(kind, 1, false);
    } else {
      void (async () => {
        try {
          await ensureAutoAccount();
          if (cancelled) return;
          void loadCloud(kind, 1, false);
        } catch (err) {
          if (!cancelled) {
            setLoading(false);
            notify(errorMessage(err), "error");
          }
        }
      })();
    }

    return () => {
      cancelled = true;
      // 切换分类 / 标签页或关闭弹窗时，让仍在飞行的请求结果失效。
      requestRef.current += 1;
    };
  }, [tab, kind, loadLocal, loadCloud, ensureAutoAccount, notify]);

  function switchTab(next: Tab) {
    if (next === tab) return;
    setTab(next);
  }

  function toggle(id: string) {
    setSelected((prev) =>
      prev.includes(id)
        ? prev.filter((item) => item !== id)
        : prev.length < room
          ? [...prev, id]
          : prev
    );
  }

  async function confirm() {
    if (!selected.length || adding) return;
    setAdding(true);
    try {
      if (tab === "local") {
        addLocalAssets(localItems.filter((item) => selected.includes(item.id)));
      } else {
        await addLibraryAssets(kind, selected, cloudPage);
      }
      onClose();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setAdding(false);
    }
  }

  const hasMore = tab === "local" ? localHasMore : cloudHasMore;
  const count = tab === "local" ? localItems.length : cloudItems.length;
  const isEmpty = tab === "local" ? localItems.length === 0 && !loading : cloudItems.length === 0 && !loading;
  const gridSentinelRef = useAutoLoadMore({
    enabled: hasMore && !loading,
    busy: loadingMore,
    onLoad: () => {
      if (tab === "local") void loadLocal(kind, localPage + 1, true);
      else void loadCloud(kind, cloudPage + 1, true);
    },
  });

  return (
    <Modal
      title="选择素材"
      wide
      onClose={onClose}
      footer={
        <>
          <span className="library-footer__hint">
            {selected.length ? `已选 ${selected.length} 个` : `还可添加 ${room} 个`}
          </span>
          <button className="btn btn--ghost" onClick={onClose} disabled={adding}>取消</button>
          <button
            className="btn btn--primary"
            onClick={() => void confirm()}
            disabled={adding || !selected.length}
          >
            {adding ? <span className="spinner" /> : <Icon name="plus" size={14} />} 加入生成
          </button>
        </>
      }
    >
      <div className="library-tabs">
        <button
          className={`filter-chip ${tab === "local" ? "is-active" : ""}`}
          onClick={() => switchTab("local")}
        >
          <Icon name="folder" size={13} /> 本地素材箱
        </button>
        <button
          className={`filter-chip ${tab === "cloud" ? "is-active" : ""}`}
          onClick={() => switchTab("cloud")}
        >
          <Icon name="cloud" size={13} /> 账号素材库
        </button>
        <span className="library-tabs__divider" />
        <button
          className={`filter-chip ${kind === "image" ? "is-active" : ""}`}
          onClick={() => setKind("image")}
        >
          <Icon name="image" size={13} /> 图片
        </button>
        <button
          className={`filter-chip ${kind === "video" ? "is-active" : ""}`}
          onClick={() => setKind("video")}
        >
          <Icon name="video" size={13} /> 视频
        </button>
        <span className="library-tabs__hint">
          {tab === "local"
            ? `共 ${localTotal} 个 · 占用 ${formatBytes(localBytes)}`
            : `来自「${me?.activeAccount?.label ?? "--"}」· 已加载 ${count} 个`}
        </span>
      </div>

      {loading ? (
        <div className="library-empty"><span className="spinner" /> 正在读取素材…</div>
      ) : isEmpty ? (
        <div className="library-empty">
          {tab === "local"
            ? "本地素材箱还是空的，上传过的图片和视频会自动存到这里"
            : `这个账号的${kind === "image" ? "图片" : "视频"}素材库还没有内容`}
        </div>
      ) : (
        <div className="library-grid">
          {tab === "local"
            ? localItems.map((item) => {
                const active = selected.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`library-item ${active ? "is-selected" : ""}`}
                    onClick={() => toggle(item.id)}
                    title={item.originalName}
                    aria-label={`选择素材 ${item.originalName}`}
                    aria-pressed={active}
                  >
                    {item.coverUrl || item.kind === "image" ? (
                      <img
                        className="library-item__thumb"
                        src={item.coverUrl ?? item.url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="library-item__placeholder"><Icon name="video" size={22} /></span>
                    )}
                    <span className="library-item__badge">{formatBytes(item.size)}</span>
                    {active && <span className="library-item__check"><Icon name="check" size={14} /></span>}
                    <span className="library-item__name">{item.originalName}</span>
                  </button>
                );
              })
            : cloudItems.map((item) => {
                const active = selected.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`library-item ${active ? "is-selected" : ""}`}
                    style={item.previewUrl ? { backgroundImage: `url("${item.previewUrl}")` } : undefined}
                    onClick={() => toggle(item.id)}
                    title={item.name}
                    aria-label={`选择素材 ${item.name}`}
                    aria-pressed={active}
                  >
                    {item.kind === "video" && <span className="library-item__badge">VIDEO</span>}
                    {active && <span className="library-item__check"><Icon name="check" size={14} /></span>}
                    <span className="library-item__name">{item.name}</span>
                  </button>
                );
              })}
          <div ref={gridSentinelRef} className="library-grid__sentinel" aria-hidden="true" />
        </div>
      )}

      {count > 0 && hasMore && (
        <div className="library-more">
          <button
            className="btn"
            onClick={() =>
              tab === "local"
                ? void loadLocal(kind, localPage + 1, true)
                : void loadCloud(kind, cloudPage + 1, true)
            }
            disabled={loadingMore || loading}
          >
            {loadingMore ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
            加载更多
          </button>
        </div>
      )}
    </Modal>
  );
}
