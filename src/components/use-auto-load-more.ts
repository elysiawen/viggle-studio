"use client";

import { useEffect, useRef } from "react";

/** 哨兵进入视口前多少像素就开始预加载下一页。 */
const ROOT_MARGIN = "200px 0px";

/**
 * 「滚到底自动加载」：把返回的 ref 挂到列表末尾的哨兵元素上。
 * 列表在弹窗内滚动、或像设置页那样跟随页面滚动都能触发；
 * 一页内容不足一屏时会继续加载，直到没有下一页。
 * 「加载更多」按钮保留作为兜底（例如请求失败后手动重试）。
 */
export function useAutoLoadMore({
  enabled,
  busy,
  onLoad,
}: {
  /** 还有下一页，且当前不在整体加载中。 */
  enabled: boolean;
  /** 追加加载进行中，避免重复请求。 */
  busy: boolean;
  onLoad: () => void;
}) {
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const loadRef = useRef(onLoad);
  loadRef.current = onLoad;
  /** 同一次可见状态里只触发一次请求。 */
  const lockRef = useRef(false);

  // 请求结束（成功或失败）后解锁，下次滚到底还能继续加载。
  useEffect(() => {
    if (!busy) lockRef.current = false;
  }, [busy]);

  // busy 变化时重建观察器：追加完一页后如果哨兵仍然可见，会继续加载下一页。
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node || !enabled) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        if (!enabledRef.current || busyRef.current || lockRef.current) return;
        lockRef.current = true;
        loadRef.current();
      },
      { rootMargin: ROOT_MARGIN }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [enabled, busy]);

  return sentinelRef;
}
