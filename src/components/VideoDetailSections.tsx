"use client";

import { useCallback, useEffect, useState } from "react";
import { api, apiJson, errorMessage } from "@/lib/api-client";
import { copyText } from "@/lib/clipboard";
import { MODE_META } from "@/lib/constants";
import { formatTime } from "@/lib/format";
import type {
  GenerationMode,
  LocalAssetView,
  PromptPresetView,
  TaskAssetView,
} from "@/lib/types";
import { useStudio } from "./studio-context";
import { Icon, Modal } from "./ui";
import { useAutoLoadMore } from "./use-auto-load-more";

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
  /** 这条作品用到的素材；null 表示还在加载，纯文生视频为空数组。 */
  const [assets, setAssets] = useState<TaskAssetView[] | null>(null);
  /** 手动关联弹窗：从本地素材箱里挑回上游已删除的原素材。 */
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerItems, setPickerItems] = useState<LocalAssetView[]>([]);
  const [pickerPage, setPickerPage] = useState(1);
  const [pickerHasMore, setPickerHasMore] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [pickerLoadingMore, setPickerLoadingMore] = useState(false);
  const [picked, setPicked] = useState<string[]>([]);
  const [linking, setLinking] = useState(false);

  useEffect(() => {
    let alive = true;
    setAssets(null);
    if (!data.taskId) {
      setAssets([]);
      return;
    }
    api<{ assets: TaskAssetView[] }>(`/api/tasks/${data.taskId}/assets`)
      .then((result) => {
        if (alive) setAssets(result.assets);
      })
      .catch(() => {
        // 历史记录可能刚被删除，详情照常展示，只是没有素材
        if (alive) setAssets([]);
      });
    return () => {
      alive = false;
    };
  }, [data.taskId]);

  const loadLocalPage = useCallback(
    async (page: number, append: boolean) => {
      if (append) setPickerLoadingMore(true);
      else setPickerLoading(true);
      try {
        const result = await api<{
          items: LocalAssetView[];
          page: number;
          hasMore: boolean;
        }>(`/api/assets/local?kind=all&page=${page}`);
        setPickerItems((prev) => (append ? [...prev, ...result.items] : result.items));
        setPickerPage(result.page);
        setPickerHasMore(result.hasMore);
      } catch (err) {
        notify(errorMessage(err), "error");
      } finally {
        setPickerLoading(false);
        setPickerLoadingMore(false);
      }
    },
    [notify]
  );

  useEffect(() => {
    if (!pickerOpen) return;
    setPickerItems([]);
    setPicked([]);
    setPickerPage(1);
    setPickerHasMore(false);
    void loadLocalPage(1, false);
  }, [pickerOpen, loadLocalPage]);

  const pickerSentinelRef = useAutoLoadMore({
    enabled: pickerHasMore && !pickerLoading,
    busy: pickerLoadingMore,
    onLoad: () => void loadLocalPage(pickerPage + 1, true),
  });

  function togglePicked(id: string) {
    setPicked((prev) =>
      prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]
    );
  }

  /** 把选中的本地素材挂到这条任务上，之后详情和「复用」都会带上它们。 */
  async function linkAssets() {
    if (!picked.length || linking) return;
    setLinking(true);
    try {
      const result = await apiJson<{ assets: TaskAssetView[] }>(
        `/api/tasks/${data.taskId}/assets`,
        "POST",
        { localAssetIds: picked }
      );
      setAssets(result.assets);
      notify(`已关联 ${picked.length} 个本地素材`, "ok");
      setPickerOpen(false);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setLinking(false);
    }
  }

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

  // 参考素材按出现顺序编号，首尾帧直接标注角色；手动关联的单独编号
  let referenceCount = 0;
  let manualCount = 0;
  const assetItems = (assets ?? []).map((asset) => ({
    ...asset,
    label: asset.manual && asset.role === "reference"
      ? `关联 ${(manualCount += 1)}`
      : asset.role === "first"
        ? "首帧"
        : asset.role === "last"
          ? "尾帧"
          : `参考 ${(referenceCount += 1)}`,
  }));

  return (
    <div className="detail-info">
      <div className="detail-section">
        <div className="detail-section__head">
          <h3 className="detail-section__title">使用素材</h3>
          {assetItems.length > 0 && (
            <span className="detail-section__meta">{assetItems.length} 个</span>
          )}
        </div>
        {assets === null ? (
          // 素材还在加载，先不显示“没有素材”，避免打开详情时闪一下
          <p className="detail-section__empty">正在加载素材…</p>
        ) : assetItems.length ? (
          <div className="asset-thumbs">
            {assetItems.map((asset, index) => (
              <figure className="asset-thumb" key={`${asset.role}-${index}`}>
                <div className="asset-thumb__media" title={asset.filename}>
                  {asset.previewUrl ? (
                    <img src={asset.previewUrl} alt={asset.filename} loading="lazy" />
                  ) : (
                    <span className="asset-thumb__placeholder">
                      <Icon name={asset.kind === "video" ? "video" : "image"} size={18} />
                    </span>
                  )}
                  {asset.kind === "video" && <span className="asset-thumb__tag">视频</span>}
                </div>
                <figcaption>{asset.label}</figcaption>
              </figure>
            ))}
          </div>
        ) : (
          <div className="detail-section__empty detail-section__empty--action">
            <span>这条作品没有使用素材</span>
            <button className="btn btn--ghost btn--sm" onClick={() => setPickerOpen(true)}>
              <Icon name="link" size={13} /> 手动关联
            </button>
          </div>
        )}
      </div>
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

      {pickerOpen && (
        <Modal
          title="手动关联素材"
          wide
          onClose={() => {
            if (!linking) setPickerOpen(false);
          }}
          footer={
            <>
              <span className="library-footer__hint">
                {picked.length
                  ? `已选 ${picked.length} 个`
                  : "从本地素材箱里挑出这条作品当初用到的素材"}
              </span>
              <button
                className="btn btn--ghost"
                onClick={() => setPickerOpen(false)}
                disabled={linking}
              >
                取消
              </button>
              <button
                className="btn btn--primary"
                onClick={() => void linkAssets()}
                disabled={linking || !picked.length}
              >
                {linking ? <span className="spinner" /> : <Icon name="link" size={14} />} 关联
              </button>
            </>
          }
        >
          {pickerLoading ? (
            <div className="library-empty"><span className="spinner" /> 正在读取素材…</div>
          ) : pickerItems.length === 0 ? (
            <div className="library-empty">
              本地素材箱还是空的，上传过的图片和视频会自动存到这里
            </div>
          ) : (
            <div className="library-grid">
              {pickerItems.map((item) => {
                const active = picked.includes(item.id);
                return (
                  <button
                    key={item.id}
                    type="button"
                    className={`library-item ${active ? "is-selected" : ""}`}
                    onClick={() => togglePicked(item.id)}
                    title={item.originalName}
                    aria-label={`选择素材 ${item.originalName}`}
                    aria-pressed={active}
                  >
                    {item.coverUrl || item.kind === "image" ? (
                      <img
                        className="library-item__thumb"
                        src={item.coverUrl ?? item.url}
                        alt=""
                        loading="lazy"
                        decoding="async"
                        aria-hidden="true"
                      />
                    ) : (
                      <span className="library-item__placeholder">
                        <Icon name="video" size={22} />
                      </span>
                    )}
                    {active && (
                      <span className="library-item__check"><Icon name="check" size={14} /></span>
                    )}
                    <span className="library-item__name">{item.originalName}</span>
                  </button>
                );
              })}
              <div ref={pickerSentinelRef} className="library-grid__sentinel" aria-hidden="true" />
            </div>
          )}
          {pickerHasMore && (
            <div className="library-more">
              <button
                className="btn"
                onClick={() => void loadLocalPage(pickerPage + 1, true)}
                disabled={pickerLoadingMore || pickerLoading}
              >
                {pickerLoadingMore ? <span className="spinner" /> : <Icon name="refresh" size={14} />}
                加载更多
              </button>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
