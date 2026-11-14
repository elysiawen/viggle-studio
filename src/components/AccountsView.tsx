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

function statusBadge(status: AccountView["status"]) {
  if (status === "valid") return <span className="badge badge--lime"><Icon name="check" size={11} /> 可用</span>;
  if (status === "invalid") return <span className="badge badge--danger"><Icon name="alert" size={11} /> 已失效</span>;
  return <span className="badge">未校验</span>;
}

type AddAccountMode = "create" | "import";

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
  const [busy, setBusy] = useState(false);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set<string>());
  const [importText, setImportText] = useState("");
  const [parsed, setParsed] = useState<CookieProfileImport | null>(null);
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
                      {statusBadge(account.status)}
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
                      onClick={() => void verifyAccount(account.id).catch((e) => notify(errorMessage(e), "error"))}
                    >
                      <Icon name="refresh" size={12} /> 校验
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
                  disabled={importBusy || (!parsed?.accounts.length && !importText.trim())}
                >
                  {importBusy ? <span className="spinner" /> : <Icon name="upload" size={14} />}
                  导入 {parsed?.accounts.length ?? 0} 个账号
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
