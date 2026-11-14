"use client";

import { useRef, useState, type ChangeEvent } from "react";
import type { ExportFormat } from "@/lib/account-export";
import { api, errorMessage } from "@/lib/api-client";
import { parseCookieProfiles, type CookieProfileImport } from "@/lib/cookie-profile";
import { formatTime } from "@/lib/format";
import type { AccountView } from "@/lib/types";
import { sortAccounts, useStudio, type AccountInput } from "./studio-context";
import { EmptyState, Icon, Modal } from "./ui";

type ModalState =
  | { kind: "create" }
  | { kind: "edit"; account: AccountView }
  | { kind: "delete"; account: AccountView }
  | { kind: "import" }
  | { kind: "export" }
  | null;

function statusBadge(status: AccountView["status"]) {
  if (status === "valid") return <span className="badge badge--lime"><Icon name="check" size={11} /> 可用</span>;
  if (status === "invalid") return <span className="badge badge--danger"><Icon name="alert" size={11} /> 已失效</span>;
  return <span className="badge">未校验</span>;
}

export function AccountsView() {
  const {
    accounts,
    accountSort,
    setAccountSort,
    createAccount,
    updateAccount,
    deleteAccount,
    activateAccount,
    verifyAccount,
    notify,
  } = useStudio();

  const [modal, setModal] = useState<ModalState>(null);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [importText, setImportText] = useState("");
  const [parsed, setParsed] = useState<CookieProfileImport | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState<ExportFormat | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  async function download(format: ExportFormat) {
    setExportBusy(format);
    try {
      const result = await api<{
        filename: string;
        count: number;
        skipped: number;
        data: unknown;
      }>(`/api/accounts/export?format=${format}`);
      if (result.count === 0) return notify("还没有可导出的账号", "error");

      const blob = new Blob([JSON.stringify(result.data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);

      notify(
        `已导出 ${result.count} 个账号` +
          (result.skipped ? `，${result.skipped} 个凭据无法解密已跳过` : ""),
        "ok"
      );
      setModal(null);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setExportBusy(null);
    }
  }

  function open(modalState: ModalState) {
    if (modalState?.kind === "edit") {
      setLabel(modalState.account.label);
      setNote(modalState.account.note ?? "");
      setToken("");
    } else {
      setLabel("");
      setNote("");
      setToken("");
    }
    if (modalState?.kind === "import") {
      setImportText("");
      setParsed(null);
    }
    setModal(modalState);
  }

  function parseText(value: string): CookieProfileImport | null {
    if (!value.trim()) return null;
    try {
      return parseCookieProfiles(JSON.parse(value) as unknown);
    } catch (err) {
      notify(err instanceof Error ? err.message : "JSON 解析失败", "error");
      return null;
    }
  }

  async function onPickFile(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    const file = input.files?.[0];
    if (!file) return;
    try {
      const content = await file.text();
      setImportText(content);
      setParsed(parseText(content));
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      // 允许连续选择同一个文件
      input.value = "";
    }
  }

  async function submitImport() {
    const result = parsed ?? parseText(importText);
    if (!result?.accounts.length) return notify("没有可导入的 Viggle 账号", "error");
    setImportBusy(true);
    try {
      const { result: outcome } = await api<{
        result: { created: string[]; skipped: Array<{ label: string; reason: string }> };
      }>("/api/accounts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: result.accounts }),
      });
      notify(
        `已导入 ${outcome.created.length} 个 Viggle 账号` +
          (outcome.skipped.length ? `，跳过 ${outcome.skipped.length} 个已存在或无效的账号` : ""),
        "ok"
      );
      setModal(null);
      setImportText("");
      setParsed(null);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setImportBusy(false);
    }
  }

  async function submit() {
    if (!modal || (modal.kind !== "create" && modal.kind !== "edit")) return;
    if (!label.trim()) return notify("请填写账号名称", "error");
    if (modal.kind === "create" && !token.trim()) return notify("请粘贴 JWT", "error");

    setBusy(true);
    try {
      const input: AccountInput = { label: label.trim(), note: note.trim() };
      if (token.trim()) input.token = token.trim();
      if (modal.kind === "create") await createAccount({ ...input, token: token.trim() });
      else await updateAccount(modal.account.id, input);
      setModal(null);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  async function confirmDelete(account: AccountView) {
    setBusy(true);
    try {
      await deleteAccount(account.id);
      setModal(null);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">账号管理</h1>
          <p className="view__subtitle">
            每个账号一条上游 JWT，经 AES-256-GCM 加密后保存在本地 SQLite；切换账号即切换使用的额度
          </p>
        </div>
        <div className="view__head__actions">
          <button className="btn" onClick={() => open({ kind: "export" })}>
            <Icon name="download" size={15} /> 导出账号
          </button>
          <button className="btn" onClick={() => open({ kind: "import" })}>
            <Icon name="upload" size={15} /> 导入 Cookie 文件
          </button>
          <button className="btn btn--primary" onClick={() => open({ kind: "create" })}>
            <Icon name="plus" size={15} /> 添加账号
          </button>
        </div>
      </div>

      {accounts.length > 0 && (
        <div className="account-sort-bar">
          <span className="account-sort-bar__label">排序</span>
          <button
            className={`filter-chip ${accountSort === "default" ? "is-active" : ""}`}
            onClick={() => setAccountSort("default")}
          >
            默认排序
          </button>
          <button
            className={`filter-chip ${accountSort === "credits" ? "is-active" : ""}`}
            onClick={() => setAccountSort("credits")}
          >
            按积分排序
          </button>
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon="users"
            title="还没有保存任何账号"
            subtitle="添加第一个 Viggle 账号，或直接导入 Cookie 导出文件里的 Viggle 账号"
            action={
              <div className="view__head__actions" style={{ marginTop: 8, justifyContent: "center" }}>
                <button className="btn btn--primary" onClick={() => open({ kind: "create" })}>
                  <Icon name="plus" size={14} /> 添加账号
                </button>
                <button className="btn" onClick={() => open({ kind: "import" })}>
                  <Icon name="upload" size={14} /> 导入 Cookie 文件
                </button>
              </div>
            }
          />
        </div>
      ) : (
        <div className="account-list">
          {sortAccounts(accounts, accountSort).map((account) => {
            const secondary = account.nickname || account.email || "尚未校验";
            return (
              <article key={account.id} className={`account-card ${account.isActive ? "is-active" : ""}`}>
                <div className="account-card__top">
                  <span className="account-card__avatar">{account.label.slice(0, 1).toUpperCase()}</span>
                  <div className="account-card__identity">
                    <div className="account-card__name" title={account.label}>{account.label}</div>
                    {secondary !== account.label && (
                      <div className="account-card__email" title={secondary}>{secondary}</div>
                    )}
                  </div>
                  <div className="account-card__badges">
                    <div className="account-card__badge-row">
                      {statusBadge(account.status)}
                      <button
                        className="account-card__delete"
                        onClick={() => open({ kind: "delete", account })}
                        aria-label="删除账号"
                        title="删除账号"
                      >
                        <Icon name="trash" size={12} />
                      </button>
                    </div>
                    {account.isActive && <span className="badge badge--lime">当前使用</span>}
                  </div>
                </div>

                <div className="account-card__grid">
                  <div className="account-card__cell">
                    <span>免费积分</span>
                    <b>{account.freeCredits ?? "--"}</b>
                  </div>
                  <div className="account-card__cell">
                    <span>最后校验</span>
                    <b>{formatTime(account.lastCheckedAt)}</b>
                  </div>
                </div>

                <div className="meta-list" style={{ marginTop: 14 }}>
                  <div className="meta-row"><span>JWT</span><span className="mono">{account.tokenMask}</span></div>
                  <div className="meta-row"><span>创建于</span><span>{formatTime(account.createdAt)}</span></div>
                  {account.note && <div className="meta-row"><span>备注</span><span>{account.note}</span></div>}
                </div>

                <div className="account-card__actions">
                  {!account.isActive && (
                    <button
                      className="btn btn--sm btn--primary"
                      onClick={() => void activateAccount(account.id).catch((e) => notify(errorMessage(e), "error"))}
                    >
                      <Icon name="check" size={12} /> 切换
                    </button>
                  )}
                  <button
                    className="btn btn--sm"
                    onClick={() => void verifyAccount(account.id).catch((e) => notify(errorMessage(e), "error"))}
                  >
                    <Icon name="refresh" size={12} /> 校验
                  </button>
                  <button className="btn btn--sm btn--ghost" onClick={() => open({ kind: "edit", account })}>
                    <Icon name="terminal" size={12} /> 编辑
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      )}

      {(modal?.kind === "create" || modal?.kind === "edit") && (
        <Modal
          title={modal.kind === "create" ? "添加上游账号" : "编辑账号"}
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setModal(null)} disabled={busy}>取消</button>
              <button className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
                {busy ? <><span className="spinner" /> 保存中…</> : <><Icon name="check" size={14} /> 保存</>}
              </button>
            </>
          }
        >
          <div className="form-row">
            <label className="form-label" htmlFor="account-label">账号名称</label>
            <input id="account-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：主账号 / 备用额度" />
          </div>
          <div className="form-row">
            <label className="form-label" htmlFor="account-token">
              JWT {modal.kind === "edit" && <span className="dim">（留空表示不修改）</span>}
            </label>
            <textarea
              id="account-token"
              className="textarea"
              rows={3}
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="eyJhbGciOi... 或带 Bearer 前缀 / JSON 字符串"
            />
            <p className="form-hint">
              从已登录的 viggle.ai 页面控制台执行 <code className="mono">localStorage.getItem(&quot;viggleToken&quot;)</code> 复制。
              凭据只在本机加密保存，不会回显到界面。
            </p>
          </div>
          <div className="form-row">
            <label className="form-label" htmlFor="account-note">备注（可选）</label>
            <input id="account-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} placeholder="额度来源、到期日等" />
          </div>
        </Modal>
      )}

      {modal?.kind === "export" && (
        <Modal
          title="导出账号"
          onClose={() => setModal(null)}
          footer={
            <button className="btn btn--ghost" onClick={() => setModal(null)} disabled={!!exportBusy}>
              关闭
            </button>
          }
        >
          <p className="export-warning">
            导出文件包含 <strong>全部账号的明文 JWT</strong>，等同于账号凭据。请妥善保管，不要分享或提交到仓库；
            用完建议删除。
          </p>
          <p className="import-hint">共 {accounts.length} 个已保存账号，选择一种格式下载：</p>
          <div className="export-options">
            <button
              className="export-option"
              onClick={() => void download("cookie-profile")}
              disabled={!!exportBusy}
            >
              <span className="export-option__title">
                {exportBusy === "cookie-profile" ? <span className="spinner" /> : <Icon name="download" size={13} />}
                Cookie 软件格式
              </span>
              <span className="export-option__hint">
                与 cookie-profile-switcher 导出文件同构，只写 viggle.ai 的 profile，
                可被该软件或本项目的「导入 Cookie 文件」读回。文件名 cookie-profiles-*.json。
              </span>
            </button>
            <button
              className="export-option"
              onClick={() => void download("studio")}
              disabled={!!exportBusy}
            >
              <span className="export-option__title">
                {exportBusy === "studio" ? <span className="spinner" /> : <Icon name="download" size={13} />}
                项目备份格式
              </span>
              <span className="export-option__hint">
                本项目自有格式（app = viggle-studio），除 JWT 外还保留名称、备注、状态、邮箱、积分与创建时间，
                同样可通过「导入 Cookie 文件」恢复。文件名 viggle-studio-accounts-*.json。
              </span>
            </button>
          </div>
        </Modal>
      )}

      {modal?.kind === "import" && (
        <Modal
          title="从 Cookie 导出文件导入"
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setModal(null)} disabled={importBusy}>取消</button>
              <button
                className="btn btn--primary"
                onClick={() => void submitImport()}
                disabled={importBusy || (!parsed?.accounts.length && !importText.trim())}
              >
                {importBusy ? <span className="spinner" /> : <Icon name="upload" size={14} />}
                导入 {parsed?.accounts.length ?? 0} 个账号
              </button>
            </>
          }
        >
          <p className="import-hint">
            支持两种文件：本项目「导出账号」生成的两种备份（Cookie 软件格式 / 项目格式），
            以及 cookie-profile-switcher 一类插件的导出文件。插件格式<strong>只导入 viggle.ai 的 profile</strong>，
            从 <code className="mono">localStorage.viggleToken</code> 提取 JWT，其它站点自动忽略。
            文件只在本机读取，凭据加密后存入本地 SQLite，不会回显。
          </p>
          <div className="import-actions">
            <button className="btn" onClick={() => fileRef.current?.click()} disabled={importBusy}>
              <Icon name="upload" size={14} /> 选择 .json 文件
            </button>
            <button
              className="btn btn--ghost"
              onClick={() => setParsed(parseText(importText))}
              disabled={importBusy || !importText.trim()}
            >
              <Icon name="check" size={14} /> 解析预览
            </button>
            <span className="dim">也可直接粘贴 JSON</span>
          </div>
          <textarea
            className="textarea mono"
            rows={4}
            value={importText}
            onChange={(event) => { setImportText(event.target.value); setParsed(null); }}
            placeholder='{"app":"cookie-profile-switcher","profiles":[...]}'
          />
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(event) => void onPickFile(event)}
          />

          {parsed && (
            <>
              <div className="import-stats">
                <span>共 {parsed.totalProfiles} 条记录</span>
                <span className="badge badge--lime">Viggle {parsed.accounts.length} 个</span>
                {parsed.otherSites > 0 && <span className="badge">其它站点 {parsed.otherSites} 个已忽略</span>}
                {parsed.skipped > 0 && <span className="badge">无有效 JWT {parsed.skipped} 个</span>}
              </div>
              {parsed.accounts.length > 0 && (
                <div className="import-preview">
                  {parsed.accounts.map((item, index) => (
                    <div className="import-preview__row" key={`${item.label}-${index}`}>
                      <Icon name="check" size={12} />
                      <span className="grow">{item.label}</span>
                      <span className="dim">未校验</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
          <p className="form-hint" style={{ marginTop: 14 }}>
            导入后不会自动请求上游校验，可在账号卡片上点「校验」逐个确认；已存在的 JWT 会自动跳过。
          </p>
        </Modal>
      )}

      {modal?.kind === "delete" && (
        <Modal
          title="删除账号"
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setModal(null)} disabled={busy}>取消</button>
              <button className="btn btn--danger" onClick={() => void confirmDelete(modal.account)} disabled={busy}>
                {busy ? <span className="spinner" /> : <Icon name="trash" size={14} />} 确认删除
              </button>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.8 }}>
            将删除「{modal.account.label}」及其全部任务与素材记录，操作不可撤销。当前正在生成的任务也会一并移除。
          </p>
        </Modal>
      )}
    </div>
  );
}
