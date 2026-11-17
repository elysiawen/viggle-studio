"use client";

import { useCallback, useEffect, useState } from "react";
import { api, apiJson, errorMessage } from "@/lib/api-client";
import { formatTime } from "@/lib/format";
import type { LocalAssetView } from "@/lib/types";
import { useStudio } from "./studio-context";
import { Icon, Modal } from "./ui";

interface StorageSettingsState {
  autoSave: { video: boolean; asset: boolean };
  encryption: { video: boolean; cover: boolean; asset: boolean; available: boolean };
  storageDir: string;
}

interface SystemInfo {
  version: string;
  mode: string;
  node: string;
  uptimeSec: number;
  databasePath: string;
  storageDir: string;
  baseUrl: string;
  poll: { intervalMs: number; maxAgeMs: number };
  flags: { accessPassword: boolean; storagePassword: boolean };
}

function formatUptime(sec: number): string {
  const days = Math.floor(sec / 86_400);
  const hours = Math.floor((sec % 86_400) / 3_600);
  const minutes = Math.floor((sec % 3_600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟`;
  if (minutes > 0) return `${minutes} 分钟`;
  return `${sec} 秒`;
}

function formatDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} 分钟` : `${Math.round(ms / 1000)} 秒`;
}

/** 素材占用体积，按 1024 进制进位。 */
function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
}

/**
 * 设置页：存储相关开关与目录可写，系统信息只读。
 * 存储设置存于数据库，改完立即生效，无需重启服务。
 */
export function SettingsView() {
  const { notify } = useStudio();
  const [storage, setStorage] = useState<StorageSettingsState | null>(null);
  const [info, setInfo] = useState<SystemInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<
    | "autoSaveAll"
    | "autoSaveVideo"
    | "autoSaveAsset"
    | "encryptAll"
    | "encryptVideo"
    | "encryptCover"
    | "encryptAsset"
    | null
  >(null);
  const [dirInput, setDirInput] = useState("");
  const [savingDir, setSavingDir] = useState(false);
  const [assets, setAssets] = useState<LocalAssetView[]>([]);
  const [assetTotal, setAssetTotal] = useState(0);
  const [assetBytes, setAssetBytes] = useState(0);
  const [assetPage, setAssetPage] = useState(1);
  const [assetHasMore, setAssetHasMore] = useState(false);
  const [assetSelected, setAssetSelected] = useState<string[]>([]);
  const [assetBusy, setAssetBusy] = useState(false);
  /** 多选模式；关闭时点击卡片是放大预览。 */
  const [assetSelectMode, setAssetSelectMode] = useState(false);
  /** 点击素材后放大查看。 */
  const [previewAsset, setPreviewAsset] = useState<LocalAssetView | null>(null);
  /** 重命名弹窗：目标素材与输入值。 */
  const [renameTarget, setRenameTarget] = useState<LocalAssetView | null>(null);
  const [renameName, setRenameName] = useState("");
  const [renameError, setRenameError] = useState<string | null>(null);
  /** 删除确认弹窗：选中项或整个素材箱。 */
  const [assetDeleteTarget, setAssetDeleteTarget] = useState<"selected" | "all" | null>(null);

  const loadAssets = useCallback(
    async (page = 1, append = false) => {
      try {
        const result = await api<{
          items: LocalAssetView[];
          total: number;
          totalBytes: number;
          page: number;
          hasMore: boolean;
        }>(`/api/assets/local?kind=all&page=${page}`);
        setAssets((prev) => (append ? [...prev, ...result.items] : result.items));
        setAssetTotal(result.total);
        setAssetBytes(result.totalBytes);
        setAssetPage(result.page);
        setAssetHasMore(result.hasMore);
      } catch (err) {
        notify(errorMessage(err), "error");
      }
    },
    [notify]
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [settings, system] = await Promise.all([
        api<StorageSettingsState>("/api/storage/settings"),
        api<SystemInfo>("/api/system/info"),
      ]);
      setStorage(settings);
      setDirInput(settings.storageDir);
      setInfo(system);
      void loadAssets();
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [notify, loadAssets]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patchStorage(
    body: Record<string, unknown>,
    key:
      | "autoSaveAll"
      | "autoSaveVideo"
      | "autoSaveAsset"
      | "encryptAll"
      | "encryptVideo"
      | "encryptCover"
      | "encryptAsset",
    message: (next: StorageSettingsState) => string
  ) {
    if (busy) return;
    setBusy(key);
    try {
      const next = await apiJson<StorageSettingsState>("/api/storage/settings", "PATCH", body);
      setStorage(next);
      setDirInput(next.storageDir);
      setInfo((prev) => (prev ? { ...prev, storageDir: next.storageDir } : prev));
      notify(message(next), "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setBusy(null);
    }
  }

  function toggleAllAutoSave() {
    if (!storage) return;
    const on = !(storage.autoSave.video || storage.autoSave.asset);
    void patchStorage(
      { autoSaveVideo: on, autoSaveAsset: on },
      "autoSaveAll",
      () => (on ? "已开启自动存盘：视频与封面一起保存，素材也会入库" : "已关闭自动存盘：之后全部不再保存")
    );
  }

  function toggleAutoSave(target: "video" | "asset") {
    if (!storage) return;
    const field = target === "video" ? "autoSaveVideo" : "autoSaveAsset";
    void patchStorage(
      { [field]: !storage.autoSave[target] },
      field,
      (next) =>
        target === "video"
          ? next.autoSave.video
            ? "已开启视频自动存盘：视频与封面一起保存"
            : "已关闭视频自动存盘：新任务不再保存视频与封面"
          : next.autoSave.asset
            ? "已开启素材自动存盘：上传的素材会存入素材箱"
            : "已关闭素材自动存盘：之后不再存入素材箱"
    );
  }

  function toggleAllEncryption() {
    if (!storage?.encryption.available) return;
    const on = !(storage.encryption.video || storage.encryption.cover || storage.encryption.asset);
    void patchStorage(
      { encryptVideo: on, encryptCover: on, encryptAsset: on },
      "encryptAll",
      () => (on ? "已开启加密存盘：三种类型默认都加密" : "已关闭加密存盘：之后全部按明文存储")
    );
  }

  function toggleEncryption(target: "video" | "cover" | "asset") {
    if (!storage?.encryption.available) return;
    const field = `encrypt${target[0].toUpperCase()}${target.slice(1)}` as
      | "encryptVideo"
      | "encryptCover"
      | "encryptAsset";
    const label = target === "video" ? "视频" : target === "cover" ? "封面" : "素材";
    void patchStorage(
      { [field]: !storage.encryption[target] },
      field,
      (next) =>
        next.encryption[target]
          ? `已开启${label}加密：新文件存为 .ske`
          : `已关闭${label}加密：之后按明文存储`
    );
  }

  async function saveDir() {
    if (!storage || savingDir) return;
    const value = dirInput.trim();
    if (!value || value === storage.storageDir) return;
    setSavingDir(true);
    try {
      const next = await apiJson<StorageSettingsState>("/api/storage/settings", "PATCH", {
        storageDir: value,
      });
      setStorage(next);
      setDirInput(next.storageDir);
      setInfo((prev) => (prev ? { ...prev, storageDir: next.storageDir } : prev));
      notify("存储目录已更新：新任务将保存到新目录", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setSavingDir(false);
    }
  }

  function toggleAsset(id: string) {
    setAssetSelected((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }

  function toggleAssetSelectMode() {
    if (assetSelectMode) {
      setAssetSelected([]);
      setPreviewAsset(null);
    }
    setAssetSelectMode((prev) => !prev);
  }

  /** 确认弹窗里点「删除」后执行：all 为清空整个素材箱。 */
  async function deleteAssets() {
    const target = assetDeleteTarget;
    if (!target || assetBusy) return;
    const all = target === "all";
    if (!all && !assetSelected.length) return;
    setAssetBusy(true);
    try {
      const query = all ? "all=1" : `ids=${encodeURIComponent(assetSelected.join(","))}`;
      const result = await api<{ deleted: number }>(`/api/assets/local?${query}`, {
        method: "DELETE",
      });
      setAssetSelected([]);
      setAssetDeleteTarget(null);
      await loadAssets();
      notify(`已删除 ${result.deleted} 个素材文件`, "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setAssetBusy(false);
    }
  }

  function openRename(asset: LocalAssetView) {
    if (assetBusy) return;
    setRenameTarget(asset);
    setRenameName(asset.originalName);
    setRenameError(null);
  }

  async function submitRename() {
    const target = renameTarget;
    if (!target || assetBusy) return;
    const name = renameName.trim();
    if (!name) {
      setRenameError("请输入文件名");
      return;
    }
    if (name === target.originalName) {
      setRenameTarget(null);
      return;
    }
    setAssetBusy(true);
    try {
      const updated = await apiJson<LocalAssetView>(`/api/assets/local/${target.id}`, "PATCH", { name });
      setAssets((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
      setPreviewAsset((prev) => (prev && prev.id === updated.id ? updated : prev));
      setRenameTarget(null);
      notify(`已重命名为 ${updated.originalName}`, "ok");
    } catch (err) {
      setRenameError(errorMessage(err));
    } finally {
      setAssetBusy(false);
    }
  }

  const autoSaveAny = Boolean(storage && (storage.autoSave.video || storage.autoSave.asset));
  const encryptAny = Boolean(
    storage && (storage.encryption.video || storage.encryption.cover || storage.encryption.asset)
  );

  return (
    <div className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">设置</h1>
          <p className="view__subtitle">本地存储、素材箱与运行环境 · 修改后立即生效，无需重启服务</p>
        </div>
      </div>

      <div className="settings-page">
        <section className="settings-card">
          <header className="settings-card__head">
            <span className="settings-card__icon"><Icon name="database" size={16} /></span>
            <div>
              <h2 className="settings-card__title">存储</h2>
              <p className="settings-card__sub">生成产物的保存位置与方式</p>
            </div>
          </header>
          <div className="settings-card__body">
            <div className="settings-field">
              <label className="settings-field__label" htmlFor="storage-dir">存储目录</label>
              <p className="settings-field__hint">
                切换只影响之后保存的文件；旧文件仍从各自原目录读取，不会迁移或删除。
              </p>
              <div className="settings-field__row">
                <input
                  id="storage-dir"
                  className="input"
                  value={dirInput}
                  onChange={(event) => setDirInput(event.target.value)}
                  spellCheck={false}
                  disabled={loading || savingDir}
                  placeholder="例如 D:\\viggle-storage 或 ./storage"
                />
                <button
                  className={`btn btn--sm ${
                    dirInput.trim() && dirInput.trim() !== storage?.storageDir ? "btn--primary" : ""
                  }`}
                  onClick={() => void saveDir()}
                  disabled={loading || savingDir || !dirInput.trim() || dirInput.trim() === storage?.storageDir}
                >
                  {savingDir ? <span className="spinner" /> : <Icon name="check" size={12} />} 保存
                </button>
              </div>
            </div>
            <div className="settings-toggle settings-encrypt">
              <div className="settings-toggle__text">
                <b>自动存盘</b>
                <p className="settings-toggle__hint">
                  视频与封面始终一起保存，加密方式可在下面单独设置；素材指上传的参考素材自动存入素材箱。
                </p>
                <div className="settings-chips" role="group" aria-label="自动存盘类型">
                  {([
                    { key: "video" as const, label: "视频+封面" },
                    { key: "asset" as const, label: "素材" },
                  ]).map((item) => {
                    const on = storage?.autoSave[item.key] ?? false;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        className={`chip-toggle ${on ? "is-on" : ""}`}
                        aria-pressed={on}
                        disabled={loading || !storage || busy !== null}
                        onClick={() => toggleAutoSave(item.key)}
                      >
                        <span className="chip-toggle__dot" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={autoSaveAny}
                aria-label="自动存盘"
                className={`switch ${autoSaveAny ? "is-on" : ""}`}
                onClick={toggleAllAutoSave}
                disabled={loading || !storage || busy !== null}
              >
                {busy === "autoSaveAll" ? (
                  <span className="spinner switch__spinner" />
                ) : (
                  <span className="switch__thumb" />
                )}
              </button>
            </div>
            {!storage?.encryption.available && !loading && (
              <p className="settings-toggle__hint settings-encrypt-hint">
                未配置 STORAGE_PASSWORD，加密开关不可用。
              </p>
            )}
            <div className="settings-toggle settings-encrypt">
              <div className="settings-toggle__text">
                <b>加密存盘</b>
                <p className="settings-toggle__hint">
                  开启后按下面点亮的类型加密为 .ske；关闭则全部按明文存储。
                </p>
                <div className="settings-chips" role="group" aria-label="加密类型">
                  {([
                    { key: "video" as const, label: "视频" },
                    { key: "cover" as const, label: "封面" },
                    { key: "asset" as const, label: "素材" },
                  ]).map((item) => {
                    const on = storage?.encryption[item.key] ?? false;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        className={`chip-toggle ${on ? "is-on" : ""}`}
                        aria-pressed={on}
                        disabled={loading || !storage || !storage.encryption.available || busy !== null}
                        onClick={() => toggleEncryption(item.key)}
                      >
                        <span className="chip-toggle__dot" />
                        {item.label}
                      </button>
                    );
                  })}
                </div>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={encryptAny}
                aria-label="加密存盘"
                className={`switch ${encryptAny ? "is-on" : ""}`}
                onClick={toggleAllEncryption}
                disabled={loading || !storage || !storage.encryption.available || busy !== null}
              >
                {busy === "encryptAll" ? (
                  <span className="spinner switch__spinner" />
                ) : (
                  <span className="switch__thumb" />
                )}
              </button>
            </div>
          </div>
        </section>

        <section className="settings-card">
          <header className="settings-card__head">
            <span className="settings-card__icon settings-card__icon--violet"><Icon name="info" size={16} /></span>
            <div>
              <h2 className="settings-card__title">系统信息</h2>
              <p className="settings-card__sub">只读 · 当前进程与路径</p>
            </div>
          </header>
          <div className="settings-card__body">
            <div className="settings-info">
              <div className="settings-info__row"><span>应用版本</span><span className="settings-info__value">{info?.version ?? "--"}</span></div>
              <div className="settings-info__row">
                <span>运行环境</span>
                <span className="settings-info__value">{info ? `${info.mode} · Node ${info.node}` : "--"}</span>
              </div>
              <div className="settings-info__row">
                <span>已运行</span>
                <span className="settings-info__value">{info ? formatUptime(info.uptimeSec) : "--"}</span>
              </div>
              <div className="settings-info__row" title={info?.databasePath}>
                <span>数据库</span>
                <span className="settings-info__value">{info?.databasePath ?? "--"}</span>
              </div>
              <div className="settings-info__row" title={info?.storageDir}>
                <span>生效目录</span>
                <span className="settings-info__value">{info?.storageDir ?? "--"}</span>
              </div>
              <div className="settings-info__row" title={info?.baseUrl}>
                <span>上游地址</span>
                <span className="settings-info__value">{info?.baseUrl ?? "--"}</span>
              </div>
              <div className="settings-info__row">
                <span>轮询间隔</span>
                <span className="settings-info__value">{info ? formatDuration(info.poll.intervalMs) : "--"}</span>
              </div>
              <div className="settings-info__row">
                <span>任务最长存活</span>
                <span className="settings-info__value">{info ? formatDuration(info.poll.maxAgeMs) : "--"}</span>
              </div>
              <div className="settings-info__row">
                <span>访问密码</span>
                <span className="settings-info__value">{info ? (info.flags.accessPassword ? "已启用" : "未启用") : "--"}</span>
              </div>
              <div className="settings-info__row">
                <span>加密主密码</span>
                <span className="settings-info__value">{info ? (info.flags.storagePassword ? "已配置" : "未配置") : "--"}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="settings-card settings-card--wide">
          <header className="settings-card__head">
            <span className="settings-card__icon settings-card__icon--cyan"><Icon name="folder" size={16} /></span>
            <div>
              <h2 className="settings-card__title">素材箱</h2>
              <p className="settings-card__sub">上传素材的本地副本 · 保存在存储目录的 assets/ 下</p>
            </div>
          </header>
          <div className="settings-card__body">
            <div className="asset-toolbar">
              <span className="asset-toolbar__meta">
                共 {assetTotal} 个 · 占用 {formatBytes(assetBytes)}
                {assetSelected.length ? ` · 已选 ${assetSelected.length} 个` : ""}
              </span>
              <div className="asset-toolbar__actions">
                <button
                  className={`btn btn--sm ${assetSelectMode ? "btn--active" : ""}`}
                  onClick={toggleAssetSelectMode}
                  disabled={assetBusy || !assets.length}
                  title={assetSelectMode ? "退出多选模式" : "进入多选模式后可批量删除素材"}
                >
                  <Icon name="layers" size={12} /> {assetSelectMode ? "退出多选" : "多选"}
                </button>
                {assetSelectMode && (
                  <>
                    <button
                      className="btn btn--sm"
                      onClick={() => setAssetSelected([])}
                      disabled={assetBusy || !assetSelected.length}
                    >
                      取消选择
                    </button>
                    <button
                      className="btn btn--sm"
                      onClick={() => setAssetDeleteTarget("selected")}
                      disabled={assetBusy || !assetSelected.length}
                    >
                      <Icon name="trash" size={12} /> 删除选中
                    </button>
                  </>
                )}
                <button
                  className="btn btn--sm btn--danger"
                  onClick={() => setAssetDeleteTarget("all")}
                  disabled={assetBusy || !assetTotal}
                >
                  {assetBusy ? <span className="spinner" /> : <Icon name="trash" size={12} />} 清空
                </button>
              </div>
            </div>

            {assets.length ? (
              <div className="library-grid asset-grid">
                {assets.map((asset) => {
                  const active = assetSelected.includes(asset.id);
                  const open = () => {
                    if (assetSelectMode) toggleAsset(asset.id);
                    else setPreviewAsset(asset);
                  };
                  return (
                    <div
                      key={asset.id}
                      role="button"
                      tabIndex={0}
                      className={`library-item ${active ? "is-selected" : ""}`}
                      style={
                        asset.kind === "image"
                          ? { backgroundImage: `url("${asset.url}")` }
                          : undefined
                      }
                      onClick={open}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          open();
                        }
                      }}
                      title={
                        assetSelectMode
                          ? `${asset.originalName} · ${formatBytes(asset.size)}（点击选择）`
                          : `${asset.originalName} · ${formatBytes(asset.size)}（点击放大查看）`
                      }
                      aria-label={
                        assetSelectMode
                          ? `${active ? "取消选择" : "选择"}素材 ${asset.originalName}`
                          : `查看素材 ${asset.originalName}`
                      }
                      aria-pressed={assetSelectMode ? active : undefined}
                    >
                      {assetSelectMode ? (
                        active && (
                          <span className="library-item__check">
                            <Icon name="check" size={14} />
                          </span>
                        )
                      ) : (
                        <>
                          <button
                            type="button"
                            className="asset-rename"
                            onClick={(event) => {
                              event.stopPropagation();
                              openRename(asset);
                            }}
                            disabled={assetBusy}
                            title="重命名素材"
                            aria-label={`重命名素材 ${asset.originalName}`}
                          >
                            <Icon name="edit" size={12} />
                          </button>
                          <a
                            className="asset-download"
                            href={`${asset.url}?download=1`}
                            download={asset.originalName}
                            onClick={(event) => event.stopPropagation()}
                            onKeyDown={(event) => event.stopPropagation()}
                            title="下载素材"
                            aria-label={`下载素材 ${asset.originalName}`}
                          >
                            <Icon name="download" size={12} />
                          </a>
                        </>
                      )}
                      {asset.kind === "video" && (
                        <span className="library-item__placeholder">
                          <Icon name="video" size={22} />
                        </span>
                      )}
                      <span className="library-item__badge">{formatBytes(asset.size)}</span>
                      <span className="library-item__name">{asset.originalName}</span>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="library-empty">素材箱还是空的，上传过的素材会自动出现在这里</div>
            )}

            {assetHasMore && (
              <div className="library-more">
                <button
                  className="btn"
                  onClick={() => void loadAssets(assetPage + 1, true)}
                  disabled={assetBusy}
                >
                  <Icon name="refresh" size={14} /> 加载更多
                </button>
              </div>
            )}
          </div>
        </section>
      </div>

      {previewAsset && (
        <Modal
          title={previewAsset.originalName}
          onClose={() => setPreviewAsset(null)}
          wide
          footer={
            <>
              <a
                className="btn btn--sm"
                href={`/api/assets/local/${previewAsset.id}/file?download=1`}
                download={previewAsset.originalName}
              >
                <Icon name="download" size={12} /> 下载
              </a>
              <button
                className="btn btn--sm"
                onClick={() => openRename(previewAsset)}
                disabled={assetBusy}
              >
                <Icon name="edit" size={12} /> 重命名
              </button>
              <button className="btn" onClick={() => setPreviewAsset(null)}>
                关闭
              </button>
            </>
          }
        >
          <div className="asset-preview">
            {previewAsset.kind === "image" ? (
              <img
                className="asset-preview__media"
                src={previewAsset.url}
                alt={previewAsset.originalName}
              />
            ) : (
              <video
                className="asset-preview__media"
                src={previewAsset.url}
                controls
                autoPlay
                playsInline
              />
            )}
            <p className="asset-preview__meta">
              {formatBytes(previewAsset.size)} · {formatTime(previewAsset.createdAt)}
            </p>
          </div>
        </Modal>
      )}

      {renameTarget && (
        <Modal
          title="重命名素材"
          onClose={() => {
            if (!assetBusy) setRenameTarget(null);
          }}
          footer={
            <>
              <button
                className="btn"
                onClick={() => setRenameTarget(null)}
                disabled={assetBusy}
              >
                取消
              </button>
              <button
                className="btn btn--primary"
                onClick={() => void submitRename()}
                disabled={assetBusy}
              >
                {assetBusy ? <span className="spinner" /> : <Icon name="check" size={13} />} 保存
              </button>
            </>
          }
        >
          <div className="rename-form">
            <label className="field__label" htmlFor="asset-rename">文件名</label>
            <input
              id="asset-rename"
              className="input"
              value={renameName}
              autoFocus
              disabled={assetBusy}
              spellCheck={false}
              onChange={(event) => {
                setRenameName(event.target.value);
                setRenameError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submitRename();
                }
              }}
            />
            <p className="rename-form__hint">
              扩展名会按素材类型自动保留，例如输入「封面」会保存为「封面.
              {renameTarget.originalName.split(".").pop() || (renameTarget.kind === "video" ? "mp4" : "jpg")}
              」。
            </p>
            {renameError && <p className="rename-form__error">{renameError}</p>}
          </div>
        </Modal>
      )}

      {assetDeleteTarget && (
        <Modal
          title={assetDeleteTarget === "all" ? "清空素材箱" : "删除选中素材"}
          onClose={() => {
            if (!assetBusy) setAssetDeleteTarget(null);
          }}
          footer={
            <>
              <button
                className="btn btn--ghost"
                onClick={() => setAssetDeleteTarget(null)}
                disabled={assetBusy}
              >
                取消
              </button>
              <button
                className="btn btn--danger"
                onClick={() => void deleteAssets()}
                disabled={assetBusy}
              >
                {assetBusy ? <span className="spinner" /> : <Icon name="trash" size={14} />} 确认删除
              </button>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--muted)", fontSize: 13, lineHeight: 1.8 }}>
            {assetDeleteTarget === "all"
              ? `将清空素材箱里的 ${assetTotal} 个文件，删除后无法恢复。`
              : `将删除选中的 ${assetSelected.length} 个素材，删除后无法恢复。`}
          </p>
        </Modal>
      )}
    </div>
  );
}
