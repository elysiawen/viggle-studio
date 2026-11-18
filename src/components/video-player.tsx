"use client";

import { useCallback, useEffect, useRef, useState, type RefObject } from "react";
import { Icon } from "./ui";

/** 秒数格式化为 m:ss，时长未知时显示 0:00。 */
function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, "0")}`;
}

/** 音量记在本地，换视频、刷新页面后都沿用上一次的档位。 */
const VOLUME_KEY = "viggle-studio:volume";

function readStoredVolume(): number {
  try {
    const raw = window.localStorage.getItem(VOLUME_KEY);
    if (raw === null) return 1;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
  } catch {
    return 1;
  }
}

function storeVolume(value: number) {
  try {
    window.localStorage.setItem(VOLUME_KEY, String(value));
  } catch {
    // 本地存储不可用时只影响记忆，不影响本次播放
  }
}

export interface VideoPlayerProps {
  src: string;
  poster?: string;
  /** 挂载后立即播放；由用户点击触发的场景不会被浏览器拦截。 */
  autoPlay?: boolean;
  /** 拿到真实画面比例后回调，便于外层容器按视频比例调整。 */
  onRatio?: (ratio: number) => void;
  /** 当前视频自然播完，供全屏连播切换下一条。 */
  onEnded?: () => void;
  /** 原生全屏使用外层容器时，切换播放器不会退出全屏。 */
  fullscreenTarget?: RefObject<HTMLElement | null>;
}

/**
 * 自绘视频播放器：替换浏览器原生控制条，播放/进度/静音/全屏都与站内深色风格一致。
 * 外层需要提供定位容器（如 .preview-stage），组件本身绝对铺满。
 */
export function VideoPlayer({
  src,
  poster,
  autoPlay,
  onRatio,
  onEnded,
  fullscreenTarget,
}: VideoPlayerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [waiting, setWaiting] = useState(true);
  const [duration, setDuration] = useState(0);
  const [current, setCurrent] = useState(0);

  const toggle = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) void video.play().catch(() => {});
    else video.pause();
  }, []);

  // 先恢复上次的音量，再触发自动播放，避免一上来就按默认音量出声。
  useEffect(() => {
    const stored = readStoredVolume();
    setVolume(stored);
    setMuted(stored === 0);
    const video = videoRef.current;
    if (video) {
      video.volume = stored;
      video.muted = stored === 0;
    }
  }, []);

  useEffect(() => {
    if (!autoPlay) return;
    const video = videoRef.current;
    if (video) void video.play().catch(() => {});
  }, [autoPlay, src]);

  function seek(value: number) {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = value;
    setCurrent(value);
  }

  function toggleMute() {
    const video = videoRef.current;
    if (!video) return;
    if (video.muted || video.volume === 0) {
      // 从 0 音量恢复时给一个可听见的默认值，避免点了没反应
      if (video.volume === 0) {
        video.volume = 0.6;
        setVolume(0.6);
        storeVolume(0.6);
      }
      video.muted = false;
    } else {
      video.muted = true;
    }
    setMuted(video.muted);
  }

  /** 拖动音量条：非零音量顺带取消静音，拖到 0 自动静音。 */
  function changeVolume(value: number) {
    const video = videoRef.current;
    if (!video) return;
    video.volume = value;
    video.muted = value === 0;
    setVolume(value);
    setMuted(video.muted);
    storeVolume(value);
  }

  function toggleFullscreen() {
    const target = fullscreenTarget?.current ?? wrapRef.current;
    if (!target) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else if (target.requestFullscreen) void target.requestFullscreen().catch(() => {});
  }

  const percent = duration > 0 ? Math.min(100, (current / duration) * 100) : 0;

  return (
    <div className="vplayer" ref={wrapRef}>
      <video
        ref={videoRef}
        className="vplayer__video"
        src={src}
        poster={poster}
        playsInline
        preload="auto"
        onClick={toggle}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          const value = Number.isFinite(video.duration) ? video.duration : 0;
          setDuration(value);
          if (video.videoWidth && video.videoHeight) {
            onRatio?.(video.videoWidth / video.videoHeight);
          }
        }}
        onDurationChange={(event) => {
          const value = Number.isFinite(event.currentTarget.duration)
            ? event.currentTarget.duration
            : 0;
          setDuration(value);
        }}
        onTimeUpdate={(event) => setCurrent(event.currentTarget.currentTime)}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onEnded={(event) => {
          setPlaying(false);
          setCurrent(event.currentTarget.duration || 0);
          onEnded?.();
        }}
      />

      {waiting && (
        <span className="vplayer__spinner">
          <span className="spinner" />
        </span>
      )}

      {!playing && !waiting && (
        <button type="button" className="vplayer__big" onClick={toggle} aria-label="播放视频">
          <Icon name="play" size={20} />
        </button>
      )}

      <div className="vplayer__bar">
        <button
          type="button"
          className="vplayer__btn"
          onClick={toggle}
          aria-label={playing ? "暂停" : "播放"}
        >
          <Icon name={playing ? "pause" : "play"} size={15} />
        </button>
        <span className="vplayer__time">{formatTime(current)}</span>
        <input
          className="vplayer__range"
          type="range"
          min={0}
          max={duration || 0}
          step={0.05}
          value={Math.min(current, duration || 0)}
          onChange={(event) => seek(Number(event.target.value))}
          style={{
            background: `linear-gradient(to right, var(--lime) ${percent}%, rgba(255, 255, 255, 0.2) ${percent}%)`,
          }}
          aria-label="播放进度"
        />
        <span className="vplayer__time">{formatTime(duration)}</span>
        <div className="vplayer__volume">
          <button
            type="button"
            className="vplayer__btn"
            onClick={toggleMute}
            aria-label={muted ? "取消静音" : "静音"}
          >
            <Icon name={muted || volume === 0 ? "volumeX" : "volume"} size={15} />
          </button>
          <input
            className="vplayer__volume-range"
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={muted ? 0 : volume}
            onChange={(event) => changeVolume(Number(event.target.value))}
            style={{
              background: `linear-gradient(to right, rgba(255,255,255,0.9) ${(muted ? 0 : volume) * 100}%, rgba(255, 255, 255, 0.2) ${(muted ? 0 : volume) * 100}%)`,
            }}
            aria-label="音量"
          />
        </div>
        <button type="button" className="vplayer__btn" onClick={toggleFullscreen} aria-label="全屏">
          <Icon name="expand" size={15} />
        </button>
      </div>
    </div>
  );
}
