"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "@/lib/api-client";
import { BUSY_QUEUED_TTL_MS, isCreditsExhausted } from "@/lib/constants";
import {
  AUTO_ACCOUNT_VALUE,
  sortAccounts,
  StudioProvider,
  useStudio,
  VIEW_PATH,
  type ViewId,
} from "./studio-context";
import { Icon, SelectMenu, type IconName } from "./ui";

const NAV: Array<{
  id: ViewId;
  label: string;
  icon: IconName;
  title: string;
  subtitle: string;
  /** 只提供页面标题，不在侧边栏渲染（设置页只从顶栏进入） */
  hidden?: boolean;
}> = [
  {
    id: "workspace",
    label: "生成工作台",
    icon: "sparkles",
    title: "生成工作台",
    subtitle: "配置参数、提交任务并实时查看生成结果",
  },
  {
    id: "history",
    label: "创作库",
    icon: "history",
    title: "创作库",
    subtitle: "按账号回看每一次生成记录",
  },
  {
    id: "accounts",
    label: "账号管理",
    icon: "users",
    title: "账号管理",
    subtitle: "保存多个上游账号，随时切换使用额度",
  },
  {
    id: "settings",
    label: "设置",
    icon: "settings",
    title: "设置",
    subtitle: "存储、素材箱与运行信息",
    hidden: true,
  },
];

function Shell({ children }: { children: ReactNode }) {
  const {
    view,
    loading,
    me,
    accounts,
    accountSort,
    setAccountSort,
    accountMode,
    setAccountMode,
    tasks,
    toasts,
    dismissToast,
    notify,
    activateAccount,
  } = useStudio();

  const [authEnabled, setAuthEnabled] = useState(false);
  /** 内容区滚下去一段距离后，右下角出现「回到顶部」按钮。 */
  const [showScrollTop, setShowScrollTop] = useState(false);
  const contentRef = useRef<HTMLElement>(null);

  useEffect(() => {
    fetch("/api/auth/status")
      .then((res) => res.json() as Promise<{ enabled?: boolean }>)
      .then((data) => setAuthEnabled(Boolean(data.enabled)))
      .catch(() => {});
  }, []);

  async function logout() {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } finally {
      window.location.replace("/login");
    }
  }

  // 内容区是同一个滚动容器，切换视图后要回到顶部，否则手机上会停在上一页的位置。
  // 但创作库内部自己管理三个 tab 各自的滚动位置，进来时由 HistoryGallery 恢复，这里跳过。
  useEffect(() => {
    if (view === "history") return;
    contentRef.current?.scrollTo({ top: 0 });
  }, [view]);

  // 监听同一个滚动容器，超过半屏后才显示回顶按钮，避免短页面也常驻。
  useEffect(() => {
    const node = contentRef.current;
    if (!node) return;
    const onScroll = () => {
      setShowScrollTop(node.scrollTop > Math.max(320, node.clientHeight * 0.6));
    };
    onScroll();
    node.addEventListener("scroll", onScroll, { passive: true });
    return () => node.removeEventListener("scroll", onScroll);
  }, []);

  const current = NAV.find((item) => item.id === view) ?? NAV[0];
  const active = accounts.find((a) => a.isActive);
  const running = tasks.filter(
    (t) => t.status === "preparing" || t.status === "running" || t.status === "queued"
  ).length;
  /** 自动模式顶栏：正在跑任务的账号数。
      queued 超过阈值视为僵尸任务，不再占用账号（与后端选号逻辑保持一致）。 */
  const busyQueuedSince = Date.now() - BUSY_QUEUED_TTL_MS;
  const busyAccounts = accounts.filter((account) =>
    tasks.some(
      (t) =>
        t.accountId === account.id &&
        // 选号中的任务挂的还是占位账号，还没真正占用它
        ((t.status === "preparing" && t.stage !== "选号中") ||
          t.status === "running" ||
          (t.status === "queued" && new Date(t.createdAt).getTime() >= busyQueuedSince))
    )
  ).length;
  /** 自动模式顶栏：今天免费额度已用完的账号数。
      只统计已被校验确认、且还没到刷新时刻的账号（与账号管理页的「积分已用完」标记一致）。 */
  const now = new Date();
  const exhaustedAccounts = accounts.filter((a) =>
    isCreditsExhausted(a.creditsResetAt ? new Date(a.creditsResetAt) : null, now)
  ).length;

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand__mark">V</span>
          <span className="brand__text">
            <span className="brand__name">VIGGLE</span>
            <span className="brand__tag">STUDIO / 1.0</span>
          </span>
        </div>

        <div className="sidebar__label">工作区</div>
        <nav className="nav" aria-label="主导航">
          {NAV.filter((item) => !item.hidden).map((item) => {
            const count =
              item.id === "accounts"
                ? accounts.length
                : item.id === "history"
                  ? tasks.length
                  : item.id === "workspace" && running > 0
                    ? running
                    : null;
            return (
              <Link
                key={item.id}
                href={VIEW_PATH[item.id]}
                className={`nav-item ${view === item.id ? "is-active" : ""}`}
                aria-current={view === item.id ? "page" : undefined}
              >
                <span className="nav-item__icon"><Icon name={item.icon} size={17} /></span>
                <span className="nav-item__label">{item.label}</span>
                {count !== null && <span className="nav-item__count">{count}</span>}
              </Link>
            );
          })}
        </nav>

        {/* 桌面端把设置与登出放在侧栏底部，样式与上方导航保持一致 */}
        <div className="sidebar__footer">
          <div className="sidebar-actions">
            <Link
              href={VIEW_PATH.settings}
              className={`nav-item ${view === "settings" ? "is-active" : ""}`}
            >
              <span className="nav-item__icon"><Icon name="settings" size={17} /></span>
              <span className="nav-item__label">设置</span>
            </Link>
            {authEnabled && (
              <button className="nav-item" onClick={() => void logout()}>
                <span className="nav-item__icon"><Icon name="logout" size={17} /></span>
                <span className="nav-item__label">退出登录</span>
              </button>
            )}
          </div>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <div className="topbar__left">
            <div className="topbar__title">{current.title}</div>
            <div className="topbar__sub">{current.subtitle}</div>
          </div>
          <div className="topbar__right">
            {me?.stale && <span className="badge badge--danger">积分数据为缓存</span>}
            {accountMode === "auto" ? (
              <>
                <span className="credit-chip" title="正在生成任务的账号数">
                  <Icon name="video" size={13} />
                  <span className="credit-chip__label">忙碌</span>
                  <b>{busyAccounts}</b>
                </span>
                <span className="credit-chip" title="今天免费额度已用完的账号数">
                  <Icon name="alert" size={13} />
                  <span className="credit-chip__label">今日额度用完</span>
                  <b>{exhaustedAccounts}</b>
                </span>
              </>
            ) : (
              <span className="credit-chip">
                <Icon name="bolt" size={13} />
                <span className="credit-chip__label">免费积分</span>
                <b>{me?.profile?.freeCredits ?? "--"}</b>
              </span>
            )}
            <div className={`account-switch ${accountMode === "auto" ? "is-auto" : ""}`}>
              <SelectMenu
                leading={
                  <span className="account-switch__avatar">
                    {accountMode === "auto" ? (
                      <Icon name="sparkles" size={14} />
                    ) : (
                      (active?.label || "?").slice(0, 1).toUpperCase()
                    )}
                  </span>
                }
                ariaLabel={accountMode === "auto" ? "切换账号，当前为自动模式" : "切换账号"}
                menuTitle="切换账号"
                menuHeader={
                  <div className="account-sort" role="group" aria-label="排序方式">
                    <span>排序</span>
                    <button
                      type="button"
                      className={accountSort === "default" ? "is-active" : ""}
                      aria-pressed={accountSort === "default"}
                      onClick={() => setAccountSort("default")}
                    >
                      默认
                    </button>
                    <button
                      type="button"
                      className={accountSort === "credits" ? "is-active" : ""}
                      aria-pressed={accountSort === "credits"}
                      onClick={() => setAccountSort("credits")}
                    >
                      按积分
                    </button>
                  </div>
                }
                variant="bare"
                minWidth={220}
                value={accountMode === "auto" ? AUTO_ACCOUNT_VALUE : active?.id ?? ""}
                disabled={accounts.length === 0}
                options={
                  accounts.length === 0
                    ? [{ value: "", label: "未添加账号" }]
                    : [
                        {
                          value: AUTO_ACCOUNT_VALUE,
                          label: "自动",
                          meta: <span className="badge badge--lime">AUTO</span>,
                        },
                        ...sortAccounts(accounts, accountSort).map((account) => ({
                          value: account.id,
                          label: account.label,
                          meta: (
                            <>
                              <Icon name="bolt" size={12} />
                              {typeof account.freeCredits === "number" ? account.freeCredits : "--"}
                            </>
                          ),
                        })),
                      ]
                }
                onChange={(id) => {
                  if (id === AUTO_ACCOUNT_VALUE) {
                    void setAccountMode("auto").catch((err) => notify(errorMessage(err), "error"));
                  } else if (id) {
                    void activateAccount(id).catch((err) => notify(errorMessage(err), "error"));
                  }
                }}
              />
            </div>
            <Link
              href={VIEW_PATH.settings}
              className="icon-btn topbar__mobile-only"
              aria-label="设置"
              title="设置"
            >
              <Icon name="settings" size={15} />
            </Link>
            {authEnabled && (
              <button
                className="icon-btn topbar__mobile-only"
                onClick={() => void logout()}
                aria-label="退出登录"
                title="退出登录"
              >
                <Icon name="logout" size={15} />
              </button>
            )}
          </div>
        </header>

        <main ref={contentRef} className={`content ${view === "workspace" ? "content--workspace" : ""}`}>
          {loading ? (
            <div className="empty-state" style={{ paddingTop: 120 }}>
              <span className="spinner" style={{ width: 24, height: 24, color: "var(--lime)" }} />
              <p>正在初始化工作台</p>
              <span>加载账号、任务与实时连接…</span>
            </div>
          ) : (
            children
          )}
        </main>
      </div>

      {showScrollTop && (
        <button
          type="button"
          className="scroll-top"
          onClick={() => contentRef.current?.scrollTo({ top: 0, behavior: "smooth" })}
          aria-label="回到顶部"
          title="回到顶部"
        >
          <Icon name="chevron" size={16} />
        </button>
      )}

      <div className="toast-stack" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast--${toast.tone} ${toast.leaving ? "is-leaving" : ""}`}>
            <Icon name={toast.tone === "ok" ? "check" : toast.tone === "error" ? "alert" : "info"} size={15} />
            <span className="grow">{toast.message}</span>
            <button
              className="icon-btn"
              style={{ width: 20, height: 20, border: 0, background: "transparent" }}
              onClick={() => dismissToast(toast.id)}
              aria-label="关闭提示"
            >
              <Icon name="close" size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** 工作台外壳：Provider 挂在这里，路由切换时不会重建 SSE / 全局状态。 */
export function StudioShell({ children }: { children: ReactNode }) {
  return (
    <StudioProvider>
      <Shell>{children}</Shell>
    </StudioProvider>
  );
}
