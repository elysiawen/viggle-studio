"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
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
  | { kind: "batchDelete" }
  | { kind: "import" }
  | { kind: "export" }
  | null;

/** 状态胶囊；传了 onVerify 就变成可点的校验入口 */
function statusBadge(
  status: AccountView["status"],
  options?: { onVerify?: () => void; disabled?: boolean }
) {
  const tone = status === "valid" ? "badge--lime" : status === "invalid" ? "badge--danger" : "";
  const content = (
    <>
      {status === "valid" && <Icon name="check" size={11} />}
      {status === "invalid" && <Icon name="alert" size={11} />}
      {status === "valid" ? "可用" : status === "invalid" ? "已失效" : "未校验"}
    </>
  );

  if (!options?.onVerify) return <span className={`badge ${tone}`}>{content}</span>;

  return (
    <button
      type="button"
      className={`badge badge--action ${tone}`}
      onClick={(event) => {
        event.stopPropagation();
        options.onVerify?.();
      }}
      disabled={options.disabled}
      title="点击校验该账号"
    >
      {content}
    </button>
  );
}

type AddAccountMode = "create" | "import";

/** 客户机上的「续期助手」默认监听地址（双击 renew-agent.bat 启动） */
const AGENT_URL = "http://127.0.0.1:3021";

/** 添加与导入合并成一个滑块式分段控件。 */
function AccountAddSwitch({
  value,
  onChange,
}: {
  value: AddAccountMode;
  onChange: (mode: AddAccountMode) => void;
}) {
  return (
    <div className="account-add-switch" role="group" aria-label="添加或导入账号">
      <button
        type="button"
        className={`account-add-switch__item ${value === "create" ? "is-active" : ""}`}
        aria-pressed={value === "create"}
        onClick={() => onChange("create")}
      >
        <Icon name="plus" size={14} /> 添加账号
      </button>
      <button
        type="button"
        className={`account-add-switch__item ${value === "import" ? "is-active" : ""}`}
        aria-pressed={value === "import"}
        onClick={() => onChange("import")}
      >
        <Icon name="upload" size={14} /> 导入账号
      </button>
    </div>
  );
}

export function AccountsView() {
  const {
    accounts,
    accountSort,
    setAccountSort,
    createAccount,
    updateAccount,
    deleteAccount,
    deleteAccounts,
    activateAccount,
    verifyAccount,
    verifyAllAccounts,
    accountMode,
    setAccountMode,
    notify,
  } = useStudio();

  const [modal, setModal] = useState<ModalState>(null);
  const [label, setLabel] = useState("");
  const [token, setToken] = useState("");
  const [note, setNote] = useState("");
  const [loginEmail, setLoginEmail] = useState("");
  const [loginPassword, setLoginPassword] = useState("");
  /** 续期凭据是可选信息，默认折叠，避免干扰只贴 JWT 的用法 */
  const [showRenewFields, setShowRenewFields] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set<string>());
  const [importText, setImportText] = useState("");
  const [parsed, setParsed] = useState<CookieProfileImport | null>(null);
  const [selectedImport, setSelectedImport] = useState<Set<string>>(() => new Set<string>());
  const [importBusy, setImportBusy] = useState(false);
  const [exportBusy, setExportBusy] = useState<ExportFormat | null>(null);
  const [addMode, setAddMode] = useState<AddAccountMode>("create");
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchIds, setBatchIds] = useState<string[] | null>(null);
  const [batchStartedAt, setBatchStartedAt] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const batchTotal = batchIds?.length ?? 0;
  const batchTarget = batchIds ? new Set(batchIds) : null;
  /** 服务端每批校验完会广播账号快照，用 lastCheckedAt 统计已完成数量。 */
  const verifiedCount = batchStartedAt && batchTarget
    ? accounts.filter(
        (account) =>
          batchTarget.has(account.id) &&
          account.lastCheckedAt && Date.parse(account.lastCheckedAt) >= batchStartedAt - 1000
      ).length
    : 0;
  const allSelected = accounts.length > 0 && selectedIds.size === accounts.length;
  const importAccounts = parsed?.accounts ?? [];
  const allImportSelected =
    importAccounts.length > 0 && importAccounts.every((account) => selectedImport.has(account.token));

  /** 账号在别处被删除时清理失效选中项；列表清空时自动退出多选。 */
  useEffect(() => {
    if (!accounts.length) {
      if (selectionMode) setSelectionMode(false);
      if (selectedIds.size) setSelectedIds(new Set<string>());
      return;
    }
    const existing = new Set(accounts.map((account) => account.id));
    setSelectedIds((prev) => {
      const next = new Set([...prev].filter((id) => existing.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [accounts, selectionMode, selectedIds.size]);

  async function verifySelected() {
    if (batchBusy) return;
    const ids = [...selectedIds];
    if (!ids.length) return notify("请先选择要校验的账号", "error");
    setBatchBusy(true);
    setBatchIds(ids);
    setBatchStartedAt(Date.now());
    try {
      const result = await verifyAllAccounts(ids);
      notify(
        `校验完成 · ${result.total} 个账号 · 可用 ${result.valid} · 失效 ${result.invalid}` +
          (result.skipped ? ` · 无法解密 ${result.skipped}` : ""),
        "ok"
      );
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBatchBusy(false);
      setBatchIds(null);
      setBatchStartedAt(null);
    }
  }

  function openAdd(mode: AddAccountMode) {
    setAddMode(mode);
    setImportText("");
    setParsed(null);
    setSelectedImport(new Set<string>());
    open(mode === "create" ? { kind: "create" } : { kind: "import" });
  }

  /** 弹窗内切换添加 / 导入，不重置已输入内容。 */
  function switchAddMode(mode: AddAccountMode) {
    setAddMode(mode);
    setModal({ kind: mode });
  }

  function toggleSelectionMode() {
    setSelectionMode((prev) => !prev);
    setSelectedIds(new Set<string>());
  }

  function toggleSelected(id: string) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function toggleSelectAll() {
    setSelectedIds(allSelected ? new Set<string>() : new Set(accounts.map((account) => account.id)));
  }

  async function confirmBatchDelete() {
    const ids = [...selectedIds];
    if (!ids.length) return;
    setBusy(true);
    try {
      await deleteAccounts(ids);
      setModal(null);
      setSelectedIds(new Set<string>());
      setSelectionMode(false);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(false);
    }
  }

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
      setLoginEmail(modalState.account.loginEmail ?? "");
      setLoginPassword("");
      // 已经存过凭据的账号默认展开，方便直接点续期
      setShowRenewFields(Boolean(modalState.account.loginEmail || modalState.account.hasPassword));
    } else {
      setLabel("");
      setNote("");
      setToken("");
      setLoginEmail("");
      setLoginPassword("");
      setShowRenewFields(false);
    }
    if (modalState?.kind === "import") {
      setImportText("");
      setParsed(null);
      setSelectedImport(new Set<string>());
    }
    setModal(modalState);
  }

  /** 解析结果默认全选，用户可在预览里取消部分账号。 */
  function applyParsed(next: CookieProfileImport | null) {
    setParsed(next);
    setSelectedImport(new Set<string>(next?.accounts.map((account) => account.token) ?? []));
  }

  function toggleImportToken(token: string) {
    setSelectedImport((prev) => {
      const next = new Set(prev);
      if (next.has(token)) next.delete(token);
      else next.add(token);
      return next;
    });
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
      applyParsed(parseText(content));
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
    const picked = parsed
      ? result.accounts.filter((account) => selectedImport.has(account.token))
      : result.accounts;
    if (!picked.length) return notify("请选择要导入的账号", "error");
    setImportBusy(true);
    try {
      const { result: outcome } = await api<{
        result: { created: string[]; skipped: Array<{ label: string; reason: string }> };
      }>("/api/accounts/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts: picked }),
      });
      notify(
        `已导入 ${outcome.created.length} 个 Viggle 账号` +
          (outcome.skipped.length ? `，跳过 ${outcome.skipped.length} 个已存在或无效的账号` : ""),
        "ok"
      );
      setModal(null);
      setImportText("");
      setParsed(null);
      setSelectedImport(new Set<string>());
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setImportBusy(false);
    }
  }

  async function submit(): Promise<boolean> {
    if (!modal || (modal.kind !== "create" && modal.kind !== "edit")) return false;
    if (!label.trim()) {
      notify("请填写账号名称", "error");
      return false;
    }
    if (modal.kind === "create" && !token.trim()) {
      notify("请粘贴 JWT", "error");
      return false;
    }

    setBusy(true);
    try {
      const input: AccountInput = {
        label: label.trim(),
        note: note.trim(),
        loginEmail: loginEmail.trim(),
      };
      if (token.trim()) input.token = token.trim();
      // 密码留空表示不修改已保存的值
      if (loginPassword.trim()) input.loginPassword = loginPassword;
      if (modal.kind === "create") await createAccount({ ...input, token: token.trim() });
      else await updateAccount(modal.account.id, input);
      setModal(null);
      return true;
    } catch (err) {
      notify(errorMessage(err), "error");
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** 通知客户机上的续期助手；返回是否成功（false 通常是助手没启动） */
  async function notifyAgent(accountId: string): Promise<boolean> {
    try {
      const res = await fetch(`${AGENT_URL}/renew`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ accountId }),
        signal: AbortSignal.timeout(4000),
      });
      if (res.ok) return true;
      if (res.status === 409) {
        notify("续期助手正在处理上一个账号，请先在浏览器里完成它", "error");
        return false;
      }
      return false;
    } catch {
      return false;
    }
  }

  /** 卡片上直接续期：账密之前已经存过，不用进编辑页 */
  async function renewOnly(account: AccountView) {
    if (!account.loginEmail || !account.hasPassword) {
      notify("这个账号还没存登录邮箱/密码，请先点「编辑」填一下", "error");
      return;
    }
    setBusy(true);
    try {
      const ok = await notifyAgent(account.id);
      if (!ok) {
        notify("续期助手没启动：请在客户机上双击「renew-agent.bat」后再点续期", "error");
        return;
      }
      notify("已通知续期助手，请在弹出的 Chrome 里点「登录」并完成人机验证", "ok");
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

  /** 添加与编辑共用同一套表单。 */
  function accountForm(isEdit: boolean) {
    return (
      <>
        <div className="form-row">
          <label className="form-label" htmlFor="account-label">账号名称</label>
          <input id="account-label" className="input" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="例如：主账号 / 备用额度" />
        </div>
        <div className="form-row">
          <label className="form-label" htmlFor="account-token">
            JWT {isEdit && <span className="dim">（留空表示不修改）</span>}
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
        <div className="form-collapse">
          <button
            type="button"
            className="form-collapse__toggle"
            onClick={() => setShowRenewFields((prev) => !prev)}
            aria-expanded={showRenewFields}
          >
            <Icon name={showRenewFields ? "close" : "plus"} size={12} />
            续期登录凭据<span className="dim">（可选）</span>
            <span className="dim">
              {showRenewFields ? "点击收起" : "填了才能在网页上点「续期」一键登录"}
            </span>
          </button>

          {showRenewFields && (
            <>
              <div className="form-row">
                <label className="form-label" htmlFor="account-login-email">续期登录邮箱</label>
                <input
                  id="account-login-email"
                  className="input"
                  value={loginEmail}
                  onChange={(e) => setLoginEmail(e.target.value)}
                  placeholder="viggle.ai 的登录邮箱"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
              <div className="form-row">
                <label className="form-label" htmlFor="account-login-password">
                  续期登录密码{" "}
                  {isEdit && modal?.kind === "edit" && modal.account.hasPassword && (
                    <span className="dim">（已保存，留空表示不修改）</span>
                  )}
                </label>
                <input
                  id="account-login-password"
                  className="input"
                  type="password"
                  value={loginPassword}
                  onChange={(e) => setLoginPassword(e.target.value)}
                  placeholder={isEdit ? "留空表示不修改" : "viggle.ai 的登录密码"}
                  autoComplete="new-password"
                />
                <p className="form-hint">
                  密码用 AES-256-GCM 加密存进 SQLite，界面永不回显。点「续期」时只下发给客户机上的助手，
                  由它在真实 Chrome 里自动填写——你只需要点「登录」并完成人机验证。
                </p>
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  function importPanel() {
    return (
      <>
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
            onClick={() => applyParsed(parseText(importText))}
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
          onChange={(event) => { setImportText(event.target.value); applyParsed(null); }}
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
            {importAccounts.length > 0 && (
              <>
                <div className="import-preview__head">
                  <span className="dim">选择要导入的账号（已选 {selectedImport.size} 个）</span>
                  <button
                    className="btn btn--sm btn--ghost"
                    onClick={() =>
                      setSelectedImport(
                        allImportSelected
                          ? new Set<string>()
                          : new Set(importAccounts.map((account) => account.token))
                      )
                    }
                    disabled={importBusy}
                  >
                    {allImportSelected ? "取消全选" : "全选"}
                  </button>
                </div>
                <div className="import-preview">
                  {importAccounts.map((item) => (
                    <label className="import-preview__row import-preview__row--select" key={item.token}>
                      <input
                        className="import-preview__check"
                        type="checkbox"
                        checked={selectedImport.has(item.token)}
                        onChange={() => toggleImportToken(item.token)}
                        disabled={importBusy}
                      />
                      <span className="grow">{item.label}</span>
                      <span className="dim">未校验</span>
                    </label>
                  ))}
                </div>
              </>
            )}
          </>
        )}
        <p className="form-hint" style={{ marginTop: 14 }}>
          导入后不会自动请求上游校验，可在账号卡片上点「校验」逐个确认；已存在的 JWT 会自动跳过。
        </p>
      </>
    );
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
          {accounts.length > 0 && (
            <button
              className={`btn ${selectionMode ? "btn--active" : ""}`}
              onClick={toggleSelectionMode}
              disabled={busy}
              title="多选账号后，可批量校验或删除选中的账号"
            >
              <Icon name="layers" size={15} /> {selectionMode ? "退出多选" : "多选"}
            </button>
          )}
          <button className="btn" onClick={() => open({ kind: "export" })}>
            <Icon name="download" size={15} /> 导出账号
          </button>
          <button className="btn btn--primary" onClick={() => openAdd("create")}>
            <Icon name="plus" size={15} /> 添加账号
          </button>
        </div>
      </div>

      {accounts.length > 0 && (
        <>
          {selectionMode && (
            <div className="account-selection-bar">
              <button className="filter-chip" onClick={toggleSelectAll}>
                {allSelected ? "取消全选" : "全选"}
              </button>
              <span className="account-selection-bar__count">
                已选 {selectedIds.size} / {accounts.length} 个账号
              </span>
              <div className="account-selection-bar__actions">
                <button
                  className="btn btn--sm"
                  onClick={() => void verifySelected()}
                  disabled={batchBusy || busy || selectedIds.size === 0}
                  title="只校验选中的账号（只读，不消耗额度）"
                >
                  {batchBusy ? <span className="spinner" /> : <Icon name="refresh" size={12} />}
                  {batchBusy ? `校验中 ${verifiedCount}/${batchTotal}` : `校验选中 (${selectedIds.size})`}
                </button>
                <button
                  className="btn btn--sm btn--danger"
                  onClick={() => open({ kind: "batchDelete" })}
                  disabled={batchBusy || busy || selectedIds.size === 0}
                >
                  <Icon name="trash" size={12} /> 删除选中 ({selectedIds.size})
                </button>
              </div>
            </div>
          )}
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
            <button
              className={`filter-chip ${accountMode === "auto" ? "is-active" : ""}`}
              onClick={() => void setAccountMode(accountMode === "auto" ? "manual" : "auto")}
              title="生成时自动使用积分充足的账号"
            >
              <Icon name="sparkles" size={13} />
              自动选号 {accountMode === "auto" ? "已开启" : "已关闭"}
            </button>
          </div>
          {accountMode === "auto" && (
            <p className="form-hint" style={{ margin: "-6px 0 16px" }}>
              生成前会遍历所有账号，实时校验积分并切换到第一个够用的账号；已有上传素材时锁定上传时的账号，避免素材跨账号失效。刚校验过且积分不足的账号 5 分钟内跳过重复校验。
            </p>
          )}
        </>
      )}

      {accounts.length === 0 ? (
        <div className="panel">
          <EmptyState
            icon="users"
            title="还没有保存任何账号"
            subtitle="添加第一个 Viggle 账号，或直接导入 Cookie 导出文件里的 Viggle 账号"
            action={
              <div className="view__head__actions" style={{ marginTop: 8, justifyContent: "center" }}>
                <button className="btn btn--primary" onClick={() => openAdd("create")}>
                  <Icon name="plus" size={14} /> 添加账号
                </button>
                <button className="btn" onClick={() => openAdd("import")}>
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
            const selected = selectedIds.has(account.id);
            return (
              <article
                key={account.id}
                className={`account-card ${account.isActive ? "is-active" : ""} ${selected ? "is-selected" : ""} ${selectionMode ? "is-selectable" : ""}`}
                onClick={selectionMode ? (event) => {
                  if (event.target instanceof Element && event.target.closest("input, button, a, label")) return;
                  toggleSelected(account.id);
                } : undefined}
                title={selectionMode ? (selected ? "点击取消选择" : "点击选择该账号") : undefined}
              >
                <div className="account-card__top">
                  {selectionMode && (
                    <input
                      className="account-card__checkbox"
                      type="checkbox"
                      checked={selected}
                      onChange={() => toggleSelected(account.id)}
                      onClick={(event) => event.stopPropagation()}
                      aria-label={`选择账号 ${account.label}`}
                    />
                  )}
                  <span className="account-card__avatar">{account.label.slice(0, 1).toUpperCase()}</span>
                  <div className="account-card__identity">
                    <div className="account-card__name" title={account.label}>{account.label}</div>
                    {secondary !== account.label && (
                      <div className="account-card__email" title={secondary}>{secondary}</div>
                    )}
                  </div>
                  <div className="account-card__badges">
                    <div className="account-card__badge-row">
                      {statusBadge(account.status, {
                        onVerify: () =>
                          void verifyAccount(account.id).catch((e) => notify(errorMessage(e), "error")),
                        disabled: selectionMode || busy || batchBusy,
                      })}
                      {!selectionMode && (
                        <button
                          className="account-card__delete"
                          onClick={() => open({ kind: "delete", account })}
                          aria-label="删除账号"
                          title="删除账号"
                        >
                          <Icon name="trash" size={12} />
                        </button>
                      )}
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

                {selectionMode ? (
                  <div className="account-card__select-hint">
                    <Icon name={selected ? "check" : "info"} size={12} />
                    {selected ? "已选中，可使用上方批量操作" : "点击卡片即可选中"}
                  </div>
                ) : (
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
                      onClick={() => void renewOnly(account)}
                      disabled={busy}
                      title="打开浏览器自动登录，只需点登录 + 过人机验证"
                    >
                      <Icon name="clock" size={12} /> 续期
                    </button>
                    <button className="btn btn--sm btn--ghost" onClick={() => open({ kind: "edit", account })}>
                      <Icon name="terminal" size={12} /> 编辑
                    </button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {(modal?.kind === "create" || modal?.kind === "import") && (
        <Modal
          title={addMode === "create" ? "添加账号" : "导入 Cookie 文件"}
          onClose={() => setModal(null)}
          footer={
            addMode === "create" ? (
              <>
                <button className="btn btn--ghost" onClick={() => setModal(null)} disabled={busy}>取消</button>
                <button className="btn btn--primary" onClick={() => void submit()} disabled={busy}>
                  {busy ? <><span className="spinner" /> 保存中…</> : <><Icon name="check" size={14} /> 保存</>}
                </button>
              </>
            ) : (
              <>
                <button className="btn btn--ghost" onClick={() => setModal(null)} disabled={importBusy}>取消</button>
                <button
                  className="btn btn--primary"
                  onClick={() => void submitImport()}
                  disabled={importBusy || (parsed ? selectedImport.size === 0 : !importText.trim())}
                >
                  {importBusy ? <span className="spinner" /> : <Icon name="upload" size={14} />}
                  {parsed ? `导入 ${selectedImport.size} 个账号` : "解析并导入"}
                </button>
              </>
            )
          }
        >
          <AccountAddSwitch value={addMode} onChange={switchAddMode} />
          {addMode === "create" ? accountForm(false) : importPanel()}
        </Modal>
      )}

      {modal?.kind === "edit" && (
        <Modal
          title="编辑账号"
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
          {accountForm(true)}
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

      {modal?.kind === "batchDelete" && (
        <Modal
          title="批量删除账号"
          onClose={() => setModal(null)}
          footer={
            <>
              <button className="btn btn--ghost" onClick={() => setModal(null)} disabled={busy}>取消</button>
              <button className="btn btn--danger" onClick={() => void confirmBatchDelete()} disabled={busy}>
                {busy ? <span className="spinner" /> : <Icon name="trash" size={14} />}
                删除 {selectedIds.size} 个账号
              </button>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.8 }}>
            将删除选中的 {selectedIds.size} 个账号及其全部任务与素材记录，操作不可撤销。
            当前正在生成的任务也会一并移除；若包含当前使用账号，会自动切换到剩余账号。
          </p>
          <div className="import-preview" style={{ marginTop: 12 }}>
            {accounts.filter((account) => selectedIds.has(account.id)).slice(0, 5).map((account) => (
              <div className="import-preview__row" key={account.id}>
                <span className="grow">{account.label}</span>
                {account.isActive && <span className="dim">当前使用</span>}
              </div>
            ))}
          </div>
          {selectedIds.size > 5 && (
            <p className="form-hint" style={{ marginTop: 8 }}>另有 {selectedIds.size - 5} 个账号未列出</p>
          )}
        </Modal>
      )}
    </div>
  );
}
