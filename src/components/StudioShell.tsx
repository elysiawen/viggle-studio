"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { errorMessage } from "@/lib/api-client";
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
    label: "历史画廊",
    icon: "history",
    title: "历史画廊",
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
    connected,
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
    refreshAll,
  } = useStudio();

  const [authEnabled, setAuthEnabled] = useState(false);
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
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 });
  }, [view]);

  const current = NAV.find((item) => item.id === view) ?? NAV[0];
  const active = accounts.find((a) => a.isActive);
  const running = tasks.filter((t) => t.status === "running" || t.status === "queued").length;

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

        <div className="sidebar__footer">
          <div className="status-card">
            <div className="status-card__row">
              <span className={`dot ${connected ? "dot--ok" : "dot--off"}`} />
              <span>实时连接</span>
              <strong className="grow" style={{ textAlign: "right" }}>
                {connected ? "已连接" : "未连接"}
              </strong>
            </div>
            <div className="status-card__row">
              <span className="dot dot--ok" />
              <span>上游模式</span>
              <strong className="grow" style={{ textAlign: "right" }}>
                {me?.provider.label ?? "—"}
              </strong>
            </div>
            <div className="status-card__row">
              <span className="dot" />
              <span>活跃任务</span>
              <strong className="grow" style={{ textAlign: "right" }}>{running}</strong>
            </div>
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
            <span className="badge badge--violet">
              <Icon name="link" size={12} />
              {me?.provider.label ?? "加载中"}
            </span>
            {me?.stale && <span className="badge badge--danger">积分数据为缓存</span>}
            <span className="credit-chip">
              <Icon name="bolt" size={13} />
              <span className="credit-chip__label">免费积分</span>
              <b>{me?.profile?.freeCredits ?? "--"}</b>
            </span>
            <div className="account-switch">
              <SelectMenu
                leading={
                  <span className="account-switch__avatar">
                    {(active?.label || "?").slice(0, 1).toUpperCase()}
                  </span>
                }
                ariaLabel="切换账号"
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
                          label: `自动 · ${active?.label ?? "待选号"}`,
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
              className="icon-btn"
              aria-label="设置"
              title="设置"
            >
              <Icon name="settings" size={15} />
            </Link>
            <button
              className="icon-btn"
              onClick={() => void refreshAll().catch((err) => notify(errorMessage(err), "error"))}
              aria-label="刷新数据"
              title="刷新数据"
            >
              <Icon name="refresh" size={15} />
            </button>
            {authEnabled && (
              <button
                className="icon-btn"
                onClick={() => void logout()}
                aria-label="退出登录"
                title="退出登录"
              >
                <Icon name="shield" size={15} />
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
