"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon } from "./ui";
import { VideoPlayer } from "./video-player";

export interface GalleryTheaterItem {
  id: string;
  title: string;
  src: string;
  poster?: string;
  meta?: string;
}

type PlayMode = "sequential" | "random";

const SETTINGS_KEY = "viggle.gallery.theater.settings.v1";

/** Fisher-Yates 洗牌：每轮顺序不同，三条以上时也避免跨轮连续重复。 */
function shuffled(values: number[], previous?: number[]): number[] {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const target = Math.floor(Math.random() * (index + 1));
    [result[index], result[target]] = [result[target], result[index]];
  }
  if (previous && result.length > 1) {
    const sameAsPrevious = result.every((value, index) => value === previous[index]);
    // 两条列表无法同时保证换序和不跨轮重复，此时优先保证换序。
    const repeatsPreviousLast =
      result.length > 2 && result[0] === previous[previous.length - 1];
    if (sameAsPrevious || repeatsPreviousLast) {
      [result[0], result[1]] = [result[1], result[0]];
    }
  }
  return result;
}

/** 创作库共用的全屏连播层：云端与本地只负责把当前筛选结果映射成播放项。 */
export function GalleryTheater({
  source,
  items,
  startId,
  onClose,
}: {
  source: "云端" | "本地";
  items: GalleryTheaterItem[];
  /** 从详情打开时定位到当前作品；顶部入口在随机模式下连首条也随机。 */
  startId?: string;
  onClose: () => void;
}) {
  const [mounted, setMounted] = useState(false);
  const [mode, setMode] = useState<PlayMode>("sequential");
  const [loop, setLoop] = useState(false);
  const [order, setOrder] = useState(() => items.map((_, index) => index));
  const [cursor, setCursor] = useState(() => {
    const index = items.findIndex((item) => item.id === startId);
    return index >= 0 ? index : 0;
  });
  /** 同一条重播时也需要重新挂载播放器。 */
  const [runId, setRunId] = useState(0);
  const [finished, setFinished] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const settingsLoadedRef = useRef(false);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  const currentIndex = order[cursor] ?? 0;
  const current = items[currentIndex];

  const goToCursor = useCallback((nextCursor: number) => {
    setCursor(nextCursor);
    setRunId((value) => value + 1);
    setFinished(false);
  }, []);

  const startNextCycle = useCallback(() => {
    if (mode === "random") {
      // 每一轮都基于全部视频重新洗牌，不沿用上一轮顺序。
      setOrder(shuffled(items.map((_, index) => index), order));
    }
    goToCursor(0);
  }, [goToCursor, items, mode, order]);

  const next = useCallback(
    (automatic = false) => {
      if (cursor >= items.length - 1) {
        if (loop) startNextCycle();
        else if (automatic) setFinished(true);
        return;
      }
      goToCursor(cursor + 1);
    },
    [cursor, goToCursor, items.length, loop, startNextCycle]
  );

  const previous = useCallback(() => {
    if (cursor > 0) goToCursor(cursor - 1);
  }, [cursor, goToCursor]);

  function rememberSettings(nextMode: PlayMode, nextLoop: boolean) {
    if (!settingsLoadedRef.current) return;
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify({ mode: nextMode, loop: nextLoop }));
    } catch {
      // 隐私模式或存储已满不影响播放。
    }
  }

  function changeMode(nextMode: PlayMode) {
    if (nextMode === mode) return;
    if (nextMode === "random") {
      const others = items.map((_, index) => index).filter((index) => index !== currentIndex);
      // 当前视频继续播，剩余顺序随机；切模式不会从头 reload 当前视频。
      setOrder([currentIndex, ...shuffled(others)]);
      setCursor(0);
    } else {
      setOrder(items.map((_, index) => index));
      setCursor(currentIndex);
    }
    setMode(nextMode);
    rememberSettings(nextMode, loop);
  }

  function toggleLoop() {
    const enabled = !loop;
    setLoop(enabled);
    rememberSettings(mode, enabled);
    // 播完后才打开循环时，立即按当前模式开始新一轮。
    if (enabled && finished) startNextCycle();
  }

  useEffect(() => {
    setMounted(true);
    try {
      const raw = window.localStorage.getItem(SETTINGS_KEY);
      const saved = raw ? (JSON.parse(raw) as { mode?: unknown; loop?: unknown }) : null;
      if (saved?.mode === "random") {
        // 详情入口保留当前作品；列表顶部入口连首条也随机选择。
        const requestedIndex = items.findIndex((item) => item.id === startId);
        const initialIndex =
          startId && requestedIndex >= 0
            ? requestedIndex
            : Math.floor(Math.random() * items.length);
        const others = items.map((_, index) => index).filter((index) => index !== initialIndex);
        setOrder([initialIndex, ...shuffled(others)]);
        setCursor(0);
        setMode("random");
      }
      if (typeof saved?.loop === "boolean") setLoop(saved.loop);
    } catch {
      // 设置损坏或浏览器禁用存储时使用默认的顺序播放、关闭循环。
    } finally {
      settingsLoadedRef.current = true;
    }

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, []);

  useEffect(() => {
    if (mounted) rootRef.current?.focus();
  }, [mounted]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        // 原生全屏时 Esc 交给浏览器只退出全屏，避免一次按键同时关掉连播层。
        if (document.fullscreenElement) return;
        closeRef.current();
        return;
      }
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.target;
      // 进度条和音量条自身的方向键操作不应触发切换视频。
      if (
        target instanceof HTMLElement &&
        (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName))
      ) {
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        previous();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [next, previous]);

  if (!mounted || !current) return null;

  return createPortal(
    <div
      ref={rootRef}
      className="gallery-theater"
      role="dialog"
      aria-modal="true"
      aria-label={`${source}视频全屏连播`}
      tabIndex={-1}
    >
      <header className="gallery-theater__head">
        <div className="gallery-theater__heading">
          <h2>{source} · 全屏连播</h2>
          <span>{cursor + 1} / {items.length}</span>
        </div>
        <div className="gallery-theater__head-actions">
          <button
            type="button"
            className={`gallery-theater__loop ${loop ? "is-active" : ""}`}
            onClick={toggleLoop}
            aria-pressed={loop}
            aria-label={`列表循环，当前${loop ? "开启" : "关闭"}`}
            title={loop ? "关闭列表循环" : "开启列表循环"}
          >
            <Icon name="refresh" size={13} /> <span>列表循环：{loop ? "开" : "关"}</span>
          </button>
          <div className="gallery-theater__modes" role="group" aria-label="播放顺序">
            <button
              type="button"
              className={`gallery-theater__mode ${mode === "sequential" ? "is-active" : ""}`}
              onClick={() => changeMode("sequential")}
              aria-pressed={mode === "sequential"}
            >
              顺序播放
            </button>
            <button
              type="button"
              className={`gallery-theater__mode ${mode === "random" ? "is-active" : ""}`}
              onClick={() => changeMode("random")}
              aria-pressed={mode === "random"}
            >
              随机播放
            </button>
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="退出全屏连播">
            <Icon name="close" size={17} />
          </button>
        </div>
      </header>

      <main className="gallery-theater__stage">
        <VideoPlayer
          key={`${current.id}:${runId}`}
          src={current.src}
          poster={current.poster}
          autoPlay
          fullscreenTarget={rootRef}
          onEnded={() => next(true)}
        />
        {finished && (
          <div className="gallery-theater__finished">
            <span className="gallery-theater__finished-icon"><Icon name="check" size={24} /></span>
            <h3>播放列表已结束</h3>
            <p>本次连播已结束</p>
            <button type="button" className="btn btn--primary" onClick={startNextCycle}>
              <Icon name="refresh" size={14} /> 从头播放
            </button>
          </div>
        )}
      </main>

      <footer className="gallery-theater__foot">
        <div className="gallery-theater__info">
          <strong title={current.title}>{current.title}</strong>
          {current.meta && <span>{current.meta}</span>}
        </div>
        <span className="gallery-theater__keys">← → 切换 · Esc 退出</span>
        <div className="gallery-theater__nav">
          <button
            type="button"
            className="btn"
            onClick={previous}
            disabled={cursor === 0}
            aria-label="上一个视频"
          >
            上一个
          </button>
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => next()}
            disabled={!loop && cursor >= items.length - 1}
            aria-label="下一个视频"
          >
            下一个
          </button>
        </div>
      </footer>
    </div>,
    document.body
  );
}
