"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ASPECT_RATIOS, STATUS_META } from "@/lib/constants";

export type IconName =
  | "sparkles" | "grid" | "history" | "users" | "info" | "plus" | "upload"
  | "play" | "download" | "external" | "trash" | "check" | "refresh" | "close"
  | "alert" | "image" | "video" | "bolt" | "shield" | "layers" | "clock"
  | "copy" | "database" | "terminal" | "text" | "link" | "film" | "search";

const PATHS: Record<IconName, ReactNode> = {
  sparkles: <><path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" /><path d="M19 16l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" /></>,
  grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>,
  history: <><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  info: <><circle cx="12" cy="12" r="9" /><path d="M12 16v-4" /><path d="M12 8h.01" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  upload: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M17 8l-5-5-5 5" /><path d="M12 3v12" /></>,
  play: <polygon points="7 4 20 12 7 20 7 4" />,
  download: <><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></>,
  external: <><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /><path d="M15 3h6v6" /><path d="M10 14L21 3" /></>,
  trash: <><path d="M3 6h18" /><path d="M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" /></>,
  check: <path d="M20 6L9 17l-5-5" />,
  refresh: <><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></>,
  close: <path d="M18 6L6 18M6 6l12 12" />,
  alert: <><path d="M10.3 3.9L1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>,
  image: <><rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="M21 15l-5-5L5 21" /></>,
  video: <><rect x="2" y="5" width="15" height="14" rx="2" /><path d="M17 10l5-3v10l-5-3" /></>,
  bolt: <path d="M13 2L3 14h8l-1 8 10-12h-8l1-8z" />,
  shield: <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />,
  layers: <><path d="M12 2L2 7l10 5 10-5-10-5z" /><path d="M2 17l10 5 10-5" /><path d="M2 12l10 5 10-5" /></>,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  copy: <><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  database: <><ellipse cx="12" cy="5" rx="9" ry="3" /><path d="M21 12c0 1.7-4 3-9 3s-9-1.3-9-3" /><path d="M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5" /></>,
  terminal: <><path d="M4 17l6-6-6-6" /><path d="M12 19h8" /></>,
  text: <path d="M4 6h16M4 12h16M4 18h10" />,
  link: <><path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.5 1.5" /><path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.5-1.5" /></>,
  film: <><rect x="2" y="3" width="20" height="18" rx="2" /><path d="M7 3v18M17 3v18M2 9h5M2 15h5M17 9h5M17 15h5" /></>,
  search: <><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.6-3.6" /></>,
};

export function Icon({
  name,
  size = 16,
  className,
}: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}

export function StatusPill({ status, label }: { status: string; label?: string }) {
  const meta = STATUS_META[status] ?? { label: status, tone: "neutral" };
  const dotClass =
    status === "succeeded" ? "dot--ok" : status === "failed" ? "dot--off" : status === "running" ? "dot--warn" : "";
  return (
    <span className={`status-pill status-pill--${meta.tone}`}>
      <span className={`dot ${dotClass}`} />
      {label ?? meta.label}
    </span>
  );
}

export function ProgressBar({ value }: { value: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={value} aria-valuemin={0} aria-valuemax={100}>
      <div className="progress__fill" style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
    </div>
  );
}

export function EmptyState({
  icon,
  title,
  subtitle,
  action,
}: {
  icon: IconName;
  title: string;
  subtitle: string;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-state__icon"><Icon name={icon} size={24} /></div>
      <p>{title}</p>
      <span>{subtitle}</span>
      {action}
    </div>
  );
}

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide = false,
  headerExtra,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  headerExtra?: ReactNode;
}) {
  const [mounted, setMounted] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    setMounted(true);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closeRef.current();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  useEffect(() => {
    if (mounted) dialogRef.current?.focus();
  }, [mounted]);

  // 必须挂到 body：.view 上的入场动画会留下 transform，
  // 使 position:fixed 以 .view 而非视口为定位基准，遮罩会被裁切、弹窗被顶栏压住。
  if (!mounted) return null;

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal${wide ? " modal--wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
      >
        <div className="modal__head">
          <div className="modal__head-left">
            <h2 className="modal__title">{title}</h2>
            {headerExtra}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="close" size={15} />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>,
    document.body
  );
}

const RATIO_SHAPE_AREA = 220;

function ratioShape(ratio: string): { width: number; height: number } {
  const [w, h] = ratio.split(":").map(Number);
  if (!w || !h) return { width: 18, height: 14 };
  const scale = Math.sqrt(RATIO_SHAPE_AREA / (w * h));
  return {
    width: Math.round(w * scale * 10) / 10,
    height: Math.round(h * scale * 10) / 10,
  };
}

export interface SelectOption {
  value: string;
  label: string;
  shape?: { width: number; height: number };
  /** 选项右侧的补充内容，例如「闪电图标 + 剩余点数」 */
  meta?: ReactNode;
}

/** 全站统一的自定义下拉；菜单挂到 body，避免被滚动容器裁切。 */
export function SelectMenu({
  id,
  value,
  options,
  onChange,
  menuTitle,
  menuHeader,
  ariaLabel,
  disabled = false,
  variant = "field",
  minWidth = 180,
}: {
  id?: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  menuTitle?: string;
  /** 菜单标题下方的自定义区域，例如排序切换（点击不会关闭菜单）。 */
  menuHeader?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  variant?: "field" | "bare";
  minWidth?: number;
}) {
  const [mounted, setMounted] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    left: number;
    width: number;
    top?: number;
    bottom?: number;
  }>({ left: 0, width: minWidth });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => { setMounted(true); }, []);

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (!triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    // 移动端地址栏收起 / 软键盘弹出只改变视口高度，不应误关正在使用的菜单。
    let lastWidth = window.innerWidth;
    const onResize = () => {
      if (window.innerWidth === lastWidth) return;
      lastWidth = window.innerWidth;
      setOpen(false);
    };
    const onScroll = (event: Event) => {
      // 菜单本身是可滚动的 fixed 浮层（账号多时需要滚动），捕获阶段同样会收到它的
      // scroll 事件；不能把「滚动选项列表」误当成「页面滚动」而把菜单关掉。
      const target = event.target;
      if (target instanceof Node && menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open]);

  function toggle() {
    if (open) { setOpen(false); return; }
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const estimatedHeight = Math.min(320, options.length * 38 + 40 + (menuHeader ? 38 : 0));
    const flip = rect.bottom + estimatedHeight + 8 > window.innerHeight;
    const width = Math.min(Math.max(rect.width, minWidth), Math.max(160, window.innerWidth - 16));
    setPosition({
      left: Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)),
      width,
      ...(flip ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 }),
    });
    setOpen(true);
  }

  const current = options.find((option) => option.value === value);

  return (
    <div className={`select-menu select-menu--${variant}`}>
      <button
        id={id}
        ref={triggerRef}
        type="button"
        className={`select-trigger ${open ? "is-open" : ""}`}
        onClick={toggle}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
      >
        <span className="select-trigger__value">{current?.label ?? value}</span>
        <span className="select-trigger__aside">
          {current?.shape && <span className="ratio-shape" style={current.shape} aria-hidden="true" />}
          <span className="select-caret" aria-hidden="true">▾</span>
        </span>
      </button>
      {mounted && open && createPortal(
        <div
          ref={menuRef}
          className="select-menu__list"
          role="listbox"
          aria-label={ariaLabel ?? menuTitle}
          style={position}
        >
          {menuTitle && <div className="select-menu__label">{menuTitle}</div>}
          {menuHeader && <div className="select-menu__header">{menuHeader}</div>}
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={`select-option ${option.value === value ? "is-active" : ""}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
                triggerRef.current?.focus();
              }}
            >
              <span className="select-option__label">{option.label}</span>
              {option.meta && <span className="select-option__meta">{option.meta}</span>}
              {option.shape && <span className="ratio-shape" style={option.shape} aria-hidden="true" />}
            </button>
          ))}
        </div>,
        document.body
      )}
    </div>
  );
}

/** 画面比例选择器：用等面积矩形示意每个选项的宽高比。 */
export function AspectRatioPicker({
  value,
  onChange,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  id?: string;
}) {
  const options = ASPECT_RATIOS.map((item) => ({
    value: item,
    label: item,
    shape: ratioShape(item),
  }));
  return (
    <SelectMenu
      id={id}
      value={value}
      options={options}
      onChange={onChange}
      menuTitle="画面比例"
      ariaLabel="画面比例"
    />
  );
}
