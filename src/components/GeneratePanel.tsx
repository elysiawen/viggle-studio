"use client";

import { useEffect, useRef, useState } from "react";
import { api, apiJson, errorMessage } from "@/lib/api-client";
import { formatTime } from "@/lib/format";
import {
  DURATIONS,
  FREE_TIER,
  MAX_REFERENCE_MEDIA,
  MODE_META,
  QUALITY_TYPES,
  RESOLUTIONS,
} from "@/lib/constants";
import type { GenerationMode, PromptPresetView } from "@/lib/types";
import { LibraryPicker } from "./LibraryPicker";
import { useStudio } from "./studio-context";
import { AspectRatioPicker, Icon, Modal, SelectMenu, type IconName } from "./ui";

const MODE_ICONS: Record<GenerationMode, IconName> = {
  references: "image",
  frames: "layers",
  text: "text",
};

/** 素材上传状态角标：本地素材箱选的素材在点击生成后才上传。 */
function UploadStatus({ busy }: { busy: boolean }) {
  if (!busy) return <span className="thumb__status">待上传</span>;
  return (
    <span className="thumb__status is-busy">
      <span className="spinner" /> 上传中
    </span>
  );
}

export function GeneratePanel() {
  const {
    mode,
    setMode,
    drafts,
    addFiles,
    removeDraft,
    generate,
    submitting,
    me,
    notify,
    setView,
    accountMode,
    generateForm,
    setGenerateForm,
  } = useStudio();

  const { prompt, aspectRatio, duration, resolution, qualityType } = generateForm;
  const [dragging, setDragging] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  const [promptEditorOpen, setPromptEditorOpen] = useState(false);
  /** 预设弹窗：打开时才拉取列表，避免首屏多一次请求。 */
  const [presetOpen, setPresetOpen] = useState(false);
  const [presets, setPresets] = useState<PromptPresetView[]>([]);
  const [presetLoading, setPresetLoading] = useState(false);
  const [presetBusy, setPresetBusy] = useState(false);
  /** 预设弹窗内的新建 / 保存表单；false 时展示已存列表。 */
  const [presetFormOpen, setPresetFormOpen] = useState(false);
  const [presetTitle, setPresetTitle] = useState("");
  const [presetContent, setPresetContent] = useState("");
  const [presetError, setPresetError] = useState<string | null>(null);
  /** 非空表示正在编辑已有预设，空表示新建。 */
  const [presetEditTarget, setPresetEditTarget] = useState<PromptPresetView | null>(null);
  /** 删除确认：非空时再叠一层确认窗口。 */
  const [presetDeleteTarget, setPresetDeleteTarget] = useState<PromptPresetView | null>(null);
  /** 拖动排序：记录起点与当前悬停位置，松手时保存顺序。 */
  const [presetDragIndex, setPresetDragIndex] = useState<number | null>(null);
  const [presetOverIndex, setPresetOverIndex] = useState<number | null>(null);
  /** 鼠标端用 HTML5 拖拽；触屏端改用指针事件，避免长按触发浏览器原生拖动。 */
  const [mouseDraggable, setMouseDraggable] = useState(false);

  const refInput = useRef<HTMLInputElement>(null);
  const startInput = useRef<HTMLInputElement>(null);
  const endInput = useRef<HTMLInputElement>(null);
  /** 触屏拖动的目标列表，用来按指针纵坐标换算落点。 */
  const presetListRef = useRef<HTMLUListElement>(null);

  const references = drafts.filter((d) => d.role === "reference");
  const first = drafts.find((d) => d.role === "first");
  const last = drafts.find((d) => d.role === "last");
  const uploading = drafts.some((d) => d.uploading);
  const noAccount = !me?.activeAccount;
  /** 来自本地素材箱的素材没有上游 ID，点生成时才由后端上传。 */
  const isPendingUpload = (draft: { id: string | null; localAssetId?: string | null }) =>
    !draft.id && !!draft.localAssetId;

  useEffect(() => {
    setMouseDraggable(
      typeof window !== "undefined" && window.matchMedia("(hover: hover) and (pointer: fine)").matches
    );
  }, []);

  async function onGenerate() {
    if (!prompt.trim()) return notify("请先输入提示词", "error");
    try {
      await generate({ prompt: prompt.trim(), aspectRatio, duration, resolution, qualityType });
      setGenerateForm({ prompt: "" });
    } catch (err) {
      notify(errorMessage(err), "error");
    }
  }

  function openLibrary() {
    setLibraryOpen(true);
  }

  async function openPresets() {
    setPresetOpen(true);
    setPresetFormOpen(false);
    setPresetLoading(true);
    try {
      const result = await api<{ presets: PromptPresetView[] }>("/api/prompts");
      setPresets(result.presets);
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setPresetLoading(false);
    }
  }

  /** 打开新建表单；「保存当前提示词」会预填内容，「新建预设」则为空。 */
  function openPresetForm(initialContent: string) {
    setPresetEditTarget(null);
    setPresetFormOpen(true);
    setPresetTitle("");
    setPresetContent(initialContent);
    setPresetError(null);
  }

  /** 打开编辑表单，预填已有标题与内容。 */
  function openPresetEdit(item: PromptPresetView) {
    setPresetEditTarget(item);
    setPresetFormOpen(true);
    setPresetTitle(item.title);
    setPresetContent(item.content);
    setPresetError(null);
  }

  function closePresetForm() {
    setPresetFormOpen(false);
    setPresetEditTarget(null);
  }

  /** 提交表单；新建时内容与标题重复会复用已有记录，编辑时保存到原记录。 */
  async function submitPreset() {
    if (presetBusy) return;
    const content = presetContent.trim();
    if (!content) {
      setPresetError("预设内容不能为空");
      return;
    }
    setPresetBusy(true);
    setPresetError(null);
    try {
      if (presetEditTarget) {
        const updated = await apiJson<PromptPresetView>(
          `/api/prompts/${presetEditTarget.id}`,
          "PATCH",
          { title: presetTitle, content }
        );
        setPresets((prev) => prev.map((item) => (item.id === updated.id ? updated : item)));
        notify("预设已更新", "ok");
      } else {
        const created = await apiJson<PromptPresetView>("/api/prompts", "POST", {
          title: presetTitle,
          content,
        });
        setPresets((prev) =>
          prev.some((item) => item.id === created.id) ? prev : [created, ...prev]
        );
        notify("已保存提示词预设", "ok");
      }
      closePresetForm();
      setPresetTitle("");
      setPresetContent("");
    } catch (err) {
      setPresetError(errorMessage(err));
    } finally {
      setPresetBusy(false);
    }
  }

  /** 拖动结束后按新顺序落库；失败时回读服务端顺序，避免本地与服务端不一致。 */
  async function movePreset(from: number, to: number) {
    if (from === to || from < 0 || to < 0) return;
    const next = [...presets];
    const [moved] = next.splice(from, 1);
    if (!moved) return;
    next.splice(to, 0, moved);
    setPresets(next);
    try {
      await apiJson("/api/prompts/order", "PATCH", { ids: next.map((item) => item.id) });
    } catch (err) {
      notify(errorMessage(err), "error");
      try {
        const result = await api<{ presets: PromptPresetView[] }>("/api/prompts");
        setPresets(result.presets);
      } catch {
        // 回读也失败时保留本地顺序，下次打开预设弹窗会重新拉取
      }
    }
  }

  /** 触屏拖动：按指针所在位置找到目标行，手指抬起时落库。 */
  function presetIndexAt(clientY: number): number | null {
    const list = presetListRef.current;
    if (!list || !list.children.length) return null;
    const items = Array.from(list.children) as HTMLElement[];
    let index = items.findIndex((el) => {
      const rect = el.getBoundingClientRect();
      return clientY >= rect.top && clientY <= rect.bottom;
    });
    if (index === -1) {
      // 落在首行之上或末行之下时夹到两端
      index = clientY < items[0].getBoundingClientRect().top ? 0 : items.length - 1;
    }
    return index;
  }

  function endPresetDrag(commit: boolean) {
    if (commit && presetDragIndex !== null && presetOverIndex !== null) {
      void movePreset(presetDragIndex, presetOverIndex);
    }
    setPresetDragIndex(null);
    setPresetOverIndex(null);
  }

  async function deletePreset(id: string) {
    if (presetBusy) return;
    setPresetBusy(true);
    try {
      await api(`/api/prompts/${id}`, { method: "DELETE" });
      setPresets((prev) => prev.filter((item) => item.id !== id));
      setPresetDeleteTarget(null);
      notify("已删除提示词预设", "ok");
    } catch (err) {
      notify(errorMessage(err), "error");
    } finally {
      setPresetBusy(false);
    }
  }

  function applyPreset(item: PromptPresetView) {
    setGenerateForm({ prompt: item.content });
    setPresetOpen(false);
    notify("已套用提示词预设", "ok");
  }

  return (
    <section className="panel">
      <div className="panel__body">
        <div className="generate-scroll">
        <div className="section-label">
          生成模式 <span>{MODE_META[mode].short}</span>
        </div>
        <div className="segmented" role="tablist" aria-label="生成模式">
          {(Object.keys(MODE_META) as GenerationMode[]).map((key) => (
            <button
              key={key}
              role="tab"
              aria-selected={mode === key}
              className={`segment ${mode === key ? "is-active" : ""}`}
              onClick={() => setMode(key)}
            >
              <Icon name={MODE_ICONS[key]} size={14} />
              {MODE_META[key].label}
            </button>
          ))}
        </div>
        <p className="mode-hint">{MODE_META[mode].description}</p>

        {noAccount && (
          <div className="alert alert--info" style={{ marginBottom: 16 }}>
            <Icon name="info" size={15} />
            <span className="grow">还没有激活的账号，添加后即可开始生成。</span>
            <button className="btn btn--sm" onClick={() => setView("accounts")}>去添加</button>
          </div>
        )}

        {mode === "references" && (
          <>
            <input
              ref={refInput}
              type="file"
              multiple
              hidden
              accept="image/jpeg,image/png,image/webp,video/mp4,video/quicktime"
              onChange={(event) => {
                if (event.target.files) void addFiles(event.target.files);
                event.target.value = "";
              }}
            />
            <div className="reference-bar">
              <span className="reference-bar__label">
                参考素材 <span>{references.length}/{MAX_REFERENCE_MEDIA}</span>
              </span>
              <button
                type="button"
                className="btn btn--sm"
                onClick={() => void openLibrary()}
                disabled={references.length >= MAX_REFERENCE_MEDIA}
                title="从素材箱选择已上传的图片 / 视频"
              >
                <Icon name="grid" size={14} /> 从素材箱选择
              </button>
            </div>
            <div
              className={`dropzone ${dragging ? "is-drag" : ""}`}
              role="button"
              tabIndex={0}
              onClick={() => refInput.current?.click()}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  refInput.current?.click();
                }
              }}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => {
                event.preventDefault();
                setDragging(false);
                if (event.dataTransfer.files.length) void addFiles(event.dataTransfer.files);
              }}
            >
              {references.map((draft) => (
                <div
                  key={draft.key}
                  className={`thumb ${draft.uploading ? "is-uploading" : ""} ${
                    isPendingUpload(draft) ? "is-pending" : ""
                  }`}
                  style={{ backgroundImage: `url("${draft.previewUrl}")` }}
                  onClick={(event) => event.stopPropagation()}
                >
                  {draft.uploading && <div className="thumb__veil"><span className="spinner" /></div>}
                  {isPendingUpload(draft) && <UploadStatus busy={submitting} />}
                  {draft.isVideo && <span className="thumb__badge">VIDEO</span>}
                  {!draft.uploading && (
                    <button
                      className="thumb__remove"
                      onClick={(event) => { event.stopPropagation(); removeDraft(draft.key); }}
                      aria-label="移除素材"
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </div>
              ))}
              {references.length < MAX_REFERENCE_MEDIA && (
                <button
                  type="button"
                  className="dropzone__add"
                  onClick={(event) => { event.stopPropagation(); refInput.current?.click(); }}
                  onKeyDown={(event) => event.stopPropagation()}
                  aria-label="添加参考素材"
                >
                  <Icon name="plus" size={18} />
                </button>
              )}
              {references.length === 0 && (
                <div className="dropzone__empty">
                  <span className="dropzone__title">上传参考图片 / 视频</span>
                  <span className="dropzone__sub">点击选择或拖拽文件到这里</span>
                </div>
              )}
            </div>
            <p className="upload-hint">最多 {MAX_REFERENCE_MEDIA} 个 · JPG / PNG / WebP / MP4 / MOV · 图片 ≤10MB，视频 ≤20MB</p>
          </>
        )}

        {mode === "frames" && (
          <>
            <input
              ref={startInput}
              type="file"
              hidden
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                if (event.target.files?.[0]) void addFiles([event.target.files[0]], "start");
                event.target.value = "";
              }}
            />
            <input
              ref={endInput}
              type="file"
              hidden
              accept="image/jpeg,image/png,image/webp"
              onChange={(event) => {
                if (event.target.files?.[0]) void addFiles([event.target.files[0]], "end");
                event.target.value = "";
              }}
            />
            <div className="frame-grid">
              {([
                { key: "first" as const, label: "首帧", hint: "必填", item: first, input: startInput },
                { key: "last" as const, label: "尾帧", hint: "可选", item: last, input: endInput },
              ]).map((slot) => (
                <div
                  key={slot.key}
                  className={`frame-slot ${slot.item ? "has-image" : ""} ${
                    slot.item?.uploading ? "is-uploading" : ""
                  } ${slot.item && isPendingUpload(slot.item) ? "is-pending" : ""}`}
                  style={slot.item ? { backgroundImage: `url("${slot.item.previewUrl}")` } : undefined}
                  role="button"
                  tabIndex={0}
                  onClick={() => slot.input.current?.click()}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      slot.input.current?.click();
                    }
                  }}
                >
                  {!slot.item && (
                    <>
                      <span className="frame-slot__label"><Icon name="plus" size={14} /> {slot.label}</span>
                      <span className="frame-slot__hint">{slot.hint}</span>
                    </>
                  )}
                  {slot.item?.uploading && <div className="thumb__veil"><span className="spinner" /></div>}
                  {slot.item && isPendingUpload(slot.item) && <UploadStatus busy={submitting} />}
                  {slot.item && !slot.item.uploading && (
                    <button
                      className="frame-slot__remove"
                      onClick={(event) => { event.stopPropagation(); removeDraft(slot.item!.key); }}
                      aria-label={`移除${slot.label}`}
                    >
                      <Icon name="close" size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
            <p className="upload-hint">首帧为起始画面，尾帧用于约束结束画面 · 仅支持图片</p>
          </>
        )}

        {mode === "text" && (
          <div className="text-mode">
            <Icon name="sparkles" size={18} />
            <span>纯文本模式无需上传素材，直接用提示词描述你想生成的画面。</span>
          </div>
        )}

        <div className="field">
          <div className="field__label-row">
            <label className="field__label" htmlFor="prompt">提示词</label>
            <div className="prompt-actions">
              <button type="button" className="prompt-expand-trigger" onClick={() => void openPresets()}>
                <Icon name="layers" size={12} /> 预设
              </button>
              <button
                type="button"
                className="prompt-expand-trigger"
                onClick={() => setPromptEditorOpen(true)}
              >
                <Icon name="external" size={12} /> 全屏输入
              </button>
            </div>
          </div>
          <textarea
            id="prompt"
            className="textarea"
            rows={4}
            placeholder="描述你想生成的视频，例如：A cute orange cat walking on a sunny beach, cinematic lighting"
            value={prompt}
            onChange={(event) => setGenerateForm({ prompt: event.target.value })}
          />
          <div className="textarea__meta">
            {prompt.length} 字
          </div>
        </div>
        </div>

        <div className="generate-dock">
        <div className="param-grid">
          <div className="param">
            <label className="param__label" htmlFor="aspect">画面比例</label>
            <AspectRatioPicker
              id="aspect"
              value={aspectRatio}
              onChange={(value) => setGenerateForm({ aspectRatio: value })}
            />
          </div>
          <div className="param">
            <label className="param__label" htmlFor="duration">时长</label>
            <SelectMenu
              id="duration"
              value={String(duration)}
              options={DURATIONS.map((value) => ({ value: String(value), label: `${value} 秒` }))}
              onChange={(value) => setGenerateForm({ duration: Number(value) })}
              menuTitle="时长"
              ariaLabel="时长"
            />
          </div>
          <div className="param">
            <label className="param__label" htmlFor="resolution">分辨率</label>
            <SelectMenu
              id="resolution"
              value={resolution}
              options={RESOLUTIONS.map((value) => ({ value, label: value }))}
              onChange={(value) => setGenerateForm({ resolution: value })}
              menuTitle="分辨率"
              ariaLabel="分辨率"
            />
          </div>
          <div className="param">
            <label className="param__label" htmlFor="quality">生成质量</label>
            <SelectMenu
              id="quality"
              value={String(qualityType)}
              options={QUALITY_TYPES.map((item) => ({ value: String(item.value), label: item.label }))}
              onChange={(value) => setGenerateForm({ qualityType: Number(value) })}
              menuTitle="生成质量"
              ariaLabel="生成质量"
            />
          </div>
        </div>

        <button
          className="generate-btn"
          onClick={() => void onGenerate()}
          disabled={submitting || uploading || noAccount}
        >
          {submitting ? <><span className="spinner" /> 提交中…</> : <><Icon name="sparkles" size={17} /> GENERATE</>}
        </button>
        <p className="generate-note">
          {accountMode === "auto"
            ? `自动模式：生成前实时校验，自动使用积分 ≥ ${FREE_TIER.creditsPerGeneration} 的账号`
            : "免费额度：5 秒 · 768p · Flash · 约 2 次/天"}
        </p>
        </div>
      </div>
      {promptEditorOpen && (
        <Modal
          title="全屏输入提示词"
          wide
          headerExtra={<span className="prompt-fullscreen__count">{prompt.length} 字</span>}
          onClose={() => setPromptEditorOpen(false)}
          footer={
            <button className="btn btn--primary" onClick={() => setPromptEditorOpen(false)}>完成</button>
          }
        >
          <div className="prompt-fullscreen">
            <textarea
              className="textarea prompt-fullscreen__textarea"
              aria-label="全屏输入提示词"
              placeholder="描述你想生成的视频，支持输入较长的分镜、动作和画面细节。"
              value={prompt}
              onChange={(event) => setGenerateForm({ prompt: event.target.value })}
              autoFocus
            />
          </div>
        </Modal>
      )}
      {presetOpen && (
        <Modal
          title="提示词预设"
          headerExtra={<span className="prompt-fullscreen__count">{presets.length} 条</span>}
          onClose={() => {
            // 叠在上面的表单 / 确认框开着时，Esc 与点遮罩只关最上面那层。
            if (presetDeleteTarget) {
              setPresetDeleteTarget(null);
              return;
            }
            if (presetFormOpen) {
              closePresetForm();
              return;
            }
            setPresetOpen(false);
          }}
        >
          <div className="preset-panel">
            <div className="preset-toolbar">
              <button
                className="btn btn--primary"
                onClick={() => openPresetForm(prompt)}
                disabled={!prompt.trim()}
              >
                <Icon name="plus" size={14} /> 保存当前提示词
              </button>
              <button className="btn btn--ghost" onClick={() => openPresetForm("")}>
                <Icon name="edit" size={14} /> 新建预设
              </button>
            </div>
            {presetLoading ? (
              <p className="preset-empty">正在读取预设…</p>
            ) : presets.length ? (
              <ul className="preset-list" ref={presetListRef}>
                {presets.map((item, index) => (
                  <li
                    key={item.id}
                    className={`preset-item ${presetDragIndex === index ? "is-dragging" : ""} ${
                      presetOverIndex === index && presetDragIndex !== index ? "is-over" : ""
                    }`}
                    draggable={mouseDraggable && !presetBusy}
                    onDragStart={(event) => {
                      setPresetDragIndex(index);
                      event.dataTransfer.effectAllowed = "move";
                      // Firefox 只有写入数据才会真正开始拖动
                      event.dataTransfer.setData("text/plain", item.id);
                    }}
                    onDragOver={(event) => {
                      event.preventDefault();
                      event.dataTransfer.dropEffect = "move";
                      setPresetOverIndex(index);
                    }}
                    onDragLeave={(event) => {
                      // 指针在卡片内部的子元素间移动时也会触发 dragleave，这里忽略
                      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
                      setPresetOverIndex((prev) => (prev === index ? null : prev));
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      const from = presetDragIndex;
                      setPresetDragIndex(null);
                      setPresetOverIndex(null);
                      if (from !== null) void movePreset(from, index);
                    }}
                    onDragEnd={() => {
                      setPresetDragIndex(null);
                      setPresetOverIndex(null);
                    }}
                  >
                    <div className="preset-item__card">
                      <button className="preset-item__apply" onClick={() => applyPreset(item)}>
                        <span className="preset-item__head">
                          <span
                            className="preset-item__grip"
                            title="拖动排序"
                            onPointerDown={(event) => {
                              // 鼠标继续走 HTML5 拖拽，这里只处理触屏
                              if (event.pointerType === "mouse") return;
                              event.preventDefault();
                              event.currentTarget.setPointerCapture(event.pointerId);
                              setPresetDragIndex(index);
                              setPresetOverIndex(index);
                            }}
                            onPointerMove={(event) => {
                              if (presetDragIndex === null) return;
                              const target = presetIndexAt(event.clientY);
                              if (target !== null) setPresetOverIndex(target);
                            }}
                            onPointerUp={() => endPresetDrag(true)}
                            onPointerCancel={() => endPresetDrag(false)}
                            onClick={(event) => event.stopPropagation()}
                          >
                            <Icon name="grip" size={12} />
                          </span>
                          <span className="preset-item__title">{item.title}</span>
                          <span className="preset-item__time">{formatTime(item.createdAt)}</span>
                        </span>
                        <span className="preset-item__text">{item.content}</span>
                      </button>
                      <div className="preset-item__actions">
                        <button
                          className="preset-item__action"
                          disabled={presetBusy}
                          onClick={() => openPresetEdit(item)}
                        >
                          <Icon name="edit" size={12} /> 编辑
                        </button>
                        <button
                          className="preset-item__action preset-item__action--danger"
                          disabled={presetBusy}
                          onClick={() => setPresetDeleteTarget(item)}
                        >
                          <Icon name="trash" size={12} /> 删除
                        </button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="preset-empty">还没有预设，点上面的按钮新建一条。</p>
            )}
          </div>
        </Modal>
      )}
      {presetOpen && presetFormOpen && (
        <Modal
          title={presetEditTarget ? "编辑提示词预设" : "新建提示词预设"}
          onClose={closePresetForm}
          footer={
            <>
              <button
                className="btn btn--ghost"
                onClick={closePresetForm}
                disabled={presetBusy}
              >
                取消
              </button>
              <button
                className="btn btn--primary"
                onClick={() => void submitPreset()}
                disabled={presetBusy || !presetContent.trim()}
              >
                {presetBusy ? (
                  <><span className="spinner" /> 保存中…</>
                ) : presetEditTarget ? (
                  "保存修改"
                ) : (
                  "保存预设"
                )}
              </button>
            </>
          }
        >
          <div className="preset-form">
            <div className="field">
              <label className="field__label" htmlFor="preset-title">标题</label>
              <input
                id="preset-title"
                className="input"
                value={presetTitle}
                maxLength={40}
                placeholder="可选，留空时自动取内容首行"
                onChange={(event) => setPresetTitle(event.target.value)}
                autoFocus
              />
            </div>
            <div className="field">
              <label className="field__label" htmlFor="preset-content">内容</label>
              <textarea
                id="preset-content"
                className="textarea preset-form__content"
                value={presetContent}
                maxLength={2000}
                placeholder="写出这个预设要填进提示词的内容"
                onChange={(event) => setPresetContent(event.target.value)}
              />
            </div>
            {presetError && <p className="preset-error">{presetError}</p>}
          </div>
        </Modal>
      )}
      {presetOpen && presetDeleteTarget && (
        <Modal
          title="删除提示词预设"
          onClose={() => setPresetDeleteTarget(null)}
          footer={
            <>
              <button
                className="btn btn--ghost"
                onClick={() => setPresetDeleteTarget(null)}
                disabled={presetBusy}
              >
                取消
              </button>
              <button
                className="btn btn--danger"
                onClick={() => void deletePreset(presetDeleteTarget.id)}
                disabled={presetBusy}
              >
                {presetBusy ? <><span className="spinner" /> 删除中…</> : "删除"}
              </button>
            </>
          }
        >
          <p className="preset-confirm">
            确定删除预设「{presetDeleteTarget.title}」？删除后无法恢复。
          </p>
        </Modal>
      )}
      {libraryOpen && <LibraryPicker onClose={() => setLibraryOpen(false)} />}
    </section>
  );
}
