"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage } from "@/lib/api-client";
import { MAX_REFERENCE_MEDIA } from "@/lib/constants";
import type { LibraryAssetView } from "@/lib/types";
import { useStudio } from "./studio-context";
import { Icon, Modal } from "./ui";

type LibraryKind = "image" | "video";

interface LibraryPage {
  items: LibraryAssetView[];
  hasMore: boolean;
  page: number;
}

export function LibraryPicker({ onClose }: { onClose: () => void }) {
  const { drafts, addLibraryAssets, notify, me } = useStudio();
  const [kind, setKind] = useState<LibraryKind>("image");
  const [items, setItems] = useState<LibraryAssetView[]>([]);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [adding, setAdding] = useState(false);
  const requestRef = useRef(0);

  const used = drafts.filter((d) => d.role === "reference").length;
  const room = Math.max(0, MAX_REFERENCE_MEDIA - used);

  const load = useCallback(
    async (nextKind: LibraryKind, nextPage: number, append: boolean) => {
      const requestId = ++requestRef.current;
      if (append) setLoadingMore(true);
      else setLoading(true);
      try {
        const result = await api<LibraryPage>(
          `/api/assets/library?kind=${nextKind}&page=${nextPage}`
        );
        if (requestId !== requestRef.current) return;
        setItems((prev) => (append ? [...prev, ...result.items] : result.items));
        setPage(result.page);
        setHasMore(result.hasMore);
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
    setItems([]);
    setSelected([]);
    setHasMore(false);
    setPage(1);
    void load(kind, 1, false);
    return () => {
      // 切换分类或关闭弹窗时，让仍在飞行的请求结果失效。
      requestRef.current += 1;
    };
  }, [kind, load]);

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
      await addLibraryAssets(kind, selected, page);
      onClose();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setAdding(false);
    }
  }

  return (
    <Modal
      title="素材箱"
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
          来自「{me?.activeAccount?.label ?? "--"}」· 已加载 {items.length} 个
        </span>
      </div>

      {loading ? (
        <div className="library-empty"><span className="spinner" /> 正在读取素材库…</div>
      ) : items.length === 0 ? (
        <div className="library-empty">
          这个账号的{kind === "image" ? "图片" : "视频"}素材库还没有内容
        </div>
      ) : (
        <div className="library-grid">
          {items.map((item) => {
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
        </div>
      )}

      {items.length > 0 && hasMore && (
        <div className="library-more">
          <button
            className="btn"
            onClick={() => void load(kind, page + 1, true)}
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
