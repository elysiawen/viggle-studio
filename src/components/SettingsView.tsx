"use client";

import { useCallback, useEffect, useState } from "react";
import { api, apiJson, errorMessage } from "@/lib/api-client";
import { useStudio } from "./studio-context";
import { Icon } from "./ui";

interface StorageSettingsState {
  autoSave: boolean;
  encryption: { enabled: boolean; available: boolean };
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

/** 开关行：左侧标题与说明，右侧滑动开关。 */
function ToggleRow({
  title,
  description,
  on,
  disabled,
  busy,
  onToggle,
}: {
  title: string;
  description: string;
  on: boolean;
  disabled?: boolean;
  busy?: boolean;
  onToggle: () => void;
}) {
  return (
    <div className="settings-row">
      <div className="settings-row__text">
        <b>{title}</b>
        <p className="form-hint">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={title}
        className={`switch ${on ? "is-on" : ""}`}
        onClick={onToggle}
        disabled={disabled || busy}
      >
        {busy ? (
          <span className="spinner switch__spinner" />
        ) : (
          <span className="switch__thumb" />
        )}
      </button>
    </div>
  );
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
  const [busy, setBusy] = useState<"autoSave" | "encrypt" | null>(null);
  const [dirInput, setDirInput] = useState("");
  const [savingDir, setSavingDir] = useState(false);

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
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setLoading(false);
    }
  }, [notify]);

  useEffect(() => {
    void load();
  }, [load]);

  async function patchStorage(
    body: Record<string, unknown>,
    key: "autoSave" | "encrypt",
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

  function toggleAutoSave() {
    if (!storage) return;
    void patchStorage(
      { autoSave: !storage.autoSave },
      "autoSave",
      (next) => (next.autoSave ? "已开启自动存盘" : "已关闭自动存盘：新任务不再自动下载")
    );
  }

  function toggleEncryption() {
    if (!storage?.encryption.available) return;
    void patchStorage(
      { encrypt: !storage.encryption.enabled },
      "encrypt",
      (next) =>
        next.encryption.enabled ? "已开启加密落盘：新任务存为 .ske" : "已关闭加密落盘：新任务按明文存储"
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

  return (
    <div className="view">
      <div className="view__head">
        <div>
          <h1 className="view__title">设置</h1>
          <p className="view__subtitle">存储相关的开关与目录保存在数据库，修改后立即生效，无需重启服务</p>
        </div>
      </div>

      <div className="settings-layout">
        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">存储设置</h2>
          </div>
          <div className="panel__body">
            <ToggleRow
              title="自动存盘"
              description="任务生成成功后自动下载视频与封面。关闭后可以通过补存脚本或手动方式保存。"
              on={storage?.autoSave ?? false}
              disabled={loading || !storage}
              busy={busy === "autoSave"}
              onToggle={toggleAutoSave}
            />
            <ToggleRow
              title="加密存盘"
              description={
                storage?.encryption.available
                  ? "开启后新保存的文件加密为 .ske（Sakura Encryptor），已存在的文件不受影响。"
                  : "未配置 STORAGE_PASSWORD，无法开启加密存盘。"
              }
              on={storage?.encryption.enabled ?? false}
              disabled={loading || !storage || !storage.encryption.available}
              busy={busy === "encrypt"}
              onToggle={toggleEncryption}
            />

            <div className="settings-row settings-row--stack">
              <div className="settings-row__text">
                <b>存储目录</b>
                <p className="form-hint">
                  切换只影响之后保存的文件；旧文件仍从各自原目录读取，不会迁移或删除。
                </p>
              </div>
              <div className="settings-dir">
                <input
                  className="input"
                  value={dirInput}
                  onChange={(event) => setDirInput(event.target.value)}
                  spellCheck={false}
                  disabled={loading || savingDir}
                  placeholder="例如 D:\\viggle-storage 或 ./storage"
                  aria-label="存储目录"
                />
                <button
                  className="btn btn--sm"
                  onClick={() => void saveDir()}
                  disabled={loading || savingDir || !dirInput.trim() || dirInput.trim() === storage?.storageDir}
                >
                  {savingDir ? <span className="spinner" /> : <Icon name="check" size={12} />} 保存
                </button>
              </div>
            </div>
          </div>
        </section>

        <section className="panel">
          <div className="panel__head">
            <h2 className="panel__title">系统信息</h2>
          </div>
          <div className="panel__body">
            <div className="meta-list" style={{ marginTop: 0 }}>
              <div className="meta-row"><span>应用版本</span><span className="mono">{info?.version ?? "--"}</span></div>
              <div className="meta-row">
                <span>运行环境</span>
                <span className="mono">{info ? `${info.mode} · Node ${info.node}` : "--"}</span>
              </div>
              <div className="meta-row">
                <span>已运行</span>
                <span>{info ? formatUptime(info.uptimeSec) : "--"}</span>
              </div>
              <div className="meta-row" title={info?.databasePath}>
                <span>数据库</span>
                <span className="mono">{info?.databasePath ?? "--"}</span>
              </div>
              <div className="meta-row" title={info?.storageDir}>
                <span>生效目录</span>
                <span className="mono">{info?.storageDir ?? "--"}</span>
              </div>
              <div className="meta-row"><span>上游地址</span><span className="mono">{info?.baseUrl ?? "--"}</span></div>
              <div className="meta-row">
                <span>轮询间隔</span>
                <span>{info ? formatDuration(info.poll.intervalMs) : "--"}</span>
              </div>
              <div className="meta-row">
                <span>任务最长存活</span>
                <span>{info ? formatDuration(info.poll.maxAgeMs) : "--"}</span>
              </div>
              <div className="meta-row">
                <span>访问密码</span>
                <span>{info ? (info.flags.accessPassword ? "已启用" : "未启用") : "--"}</span>
              </div>
              <div className="meta-row">
                <span>加密主密码</span>
                <span>{info ? (info.flags.storagePassword ? "已配置" : "未配置") : "--"}</span>
              </div>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
