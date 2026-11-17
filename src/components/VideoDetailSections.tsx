"use client";

import { useState } from "react";
import { apiJson, errorMessage } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";
import { MODE_META } from "@/lib/constants";
import { formatTime } from "@/lib/format";
import type { GenerationMode, PromptPresetView } from "@/lib/types";
import { useStudio } from "./studio-context";
import { Icon, Modal } from "./ui";

export interface VideoDetailData {
  prompt: string;
  mode: GenerationMode;
  aspectRatio: string;
  duration: number;
  resolution: string;
  qualityType: number;
  accountLabel: string;
  status?: string;
  createdAt: string;
  finishedAt: string | null;
  taskId: string;
  remoteId: string | null;
}

/**
 * 任务详情的主体信息（提示词 / 生成参数 / 记录信息）。
 * 在线历史与本地文件共用同一份组件，保证两处 UI 完全一致。
 */
export function VideoDetailSections({
  data,
  extraRecords = [],
}: {
  data: VideoDetailData;
  /** 额外追加到「记录信息」里的行，例如本地文件的落盘时间与大小 */
  extraRecords?: Array<[string, string]>;
}) {
  const { notify } = useStudio();
  const [presetOpen, setPresetOpen] = useState(false);
  const [presetTitle, setPresetTitle] = useState("");
  const [presetError, setPresetError] = useState<string | null>(null);
  const [savingPreset, setSavingPreset] = useState(false);

  async function copy(value: string, done: string) {
    try {
      await copyText(value);
      notify(done, "ok");
    } catch (err) {
      notify(err instanceof Error ? err.message : String(err), "error");
    }
  }

  /** 打开标题输入框，内容固定用这条作品的提示词；标题留空时由服务端取首行。 */
  function openPresetForm() {
    if (!data.prompt) return;
    setPresetTitle("");
    setPresetError(null);
    setPresetOpen(true);
  }

  async function savePreset() {
    if (savingPreset) return;
    setSavingPreset(true);
    setPresetError(null);
    try {
      const created = await apiJson<PromptPresetView>("/api/prompts", "POST", {
        title: presetTitle,
        content: data.prompt,
      });
      notify(`已添加到预设「${created.title}」`, "ok");
      setPresetOpen(false);
    } catch (err) {
      setPresetError(errorMessage(err));
    } finally {
      setSavingPreset(false);
    }
  }

  const params: Array<[string, string]> = [
    ["生成模式", MODE_META[data.mode]?.label ?? data.mode],
    ["画面比例", data.aspectRatio],
    ["时长", `${data.duration} 秒`],
    ["分辨率", data.resolution],
    ["生成质量", data.qualityType === 0 ? "Flash · 免费" : `Type ${data.qualityType}`],
    ["使用账号", data.accountLabel],
  ];

  const records: Array<[string, string]> = [
    ["创建时间", formatTime(data.createdAt)],
    ["完成时间", formatTime(data.finishedAt)],
    ...extraRecords,
  ];

  return (
    <div className="detail-info">
      <div className="detail-section">
        <div className="detail-section__head">
          <h3 className="detail-section__title">完整提示词</h3>
          {data.prompt && (
            <div className="detail-section__actions">
              <button
                className="btn btn--ghost btn--sm"
                onClick={openPresetForm}
              >
                <Icon name="plus" size={13} />
                添加到预设
              </button>
              <button
                className="btn btn--ghost btn--sm"
                onClick={() => void copy(data.prompt, "提示词已复制")}
              >
                <Icon name="copy" size={13} /> 复制提示词
              </button>
            </div>
          )}
        </div>
        <div className="detail-prompt">{data.prompt || "（无提示词）"}</div>
      </div>

      <div className="detail-section">
        <h3 className="detail-section__title">生成参数</h3>
        <div className="detail-grid">
          {params.map(([label, value]) => (
            <div className="detail-cell" key={label}>
              <span>{label}</span>
              <b title={value}>{value}</b>
            </div>
          ))}
        </div>
      </div>

      <div className="detail-section">
        <h3 className="detail-section__title">记录信息</h3>
        <div className="detail-grid">
          {records.map(([label, value]) => (
            <div className="detail-cell" key={label}>
              <span>{label}</span>
              <b title={value}>{value}</b>
            </div>
          ))}
          <div className="detail-cell detail-cell--wide">
            <span>本地记录 ID</span>
            <b className="mono" title={data.taskId}>
              {data.taskId}
            </b>
          </div>
          <div className="detail-cell detail-cell--wide">
            <span>上游任务 ID</span>
            <b className="mono" title={data.remoteId ?? undefined}>
              {data.remoteId ?? "-"}
            </b>
          </div>
        </div>
      </div>

      {presetOpen && (
        <Modal
          title="添加到提示词预设"
          onClose={() => {
            if (!savingPreset) setPresetOpen(false);
          }}
          footer={
            <>
              <button
                className="btn btn--ghost"
                onClick={() => setPresetOpen(false)}
                disabled={savingPreset}
              >
                取消
              </button>
              <button
                className="btn btn--primary"
                onClick={() => void savePreset()}
                disabled={savingPreset}
              >
                {savingPreset ? <><span className="spinner" /> 保存中…</> : "保存预设"}
              </button>
            </>
          }
        >
          <div className="preset-form">
            <div className="field">
              <label className="field__label" htmlFor="detail-preset-title">标题</label>
              <input
                id="detail-preset-title"
                className="input"
                value={presetTitle}
                maxLength={40}
                placeholder="可选，留空时自动取提示词首行"
                onChange={(event) => setPresetTitle(event.target.value)}
                autoFocus
              />
            </div>
            <p className="preset-form__hint">
              内容将使用这条作品的完整提示词（{data.prompt.length} 字）。
            </p>
            {presetError && <p className="preset-error">{presetError}</p>}
          </div>
        </Modal>
      )}
    </div>
  );
}
