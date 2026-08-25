import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import {
  STORYBOARD_CAMERA_MOVEMENTS,
  STORYBOARD_SHOT_SIZES,
  createShotClip,
  type AiProviderErrorData,
  type Project,
  type ShotClipData,
  type StoryboardCameraMovement,
  type StoryboardDraft,
  type StoryboardDraftShot,
  type StoryboardShotSize,
} from '@lumora/core';
import type { StudioRuntime } from '../../runtime/studio-runtime';
import { useEventRefresh } from '../../hooks/use-event-refresh';
import { showToast } from '../editor/toasts';

interface StoryboardWorkspaceProps {
  runtime: StudioRuntime;
  project: Project;
  onClose: () => void;
}

type WorkspaceTab = 'draft' | 'adopted';

const SHOT_SIZE_LABELS: Record<StoryboardShotSize, string> = {
  'extreme-wide': '大远景',
  wide: '全景',
  medium: '中景',
  'close-up': '近景',
  'extreme-close-up': '特写',
};

const MOVEMENT_LABELS: Record<StoryboardCameraMovement, string> = {
  static: '固定',
  pan: '横摇',
  tilt: '俯仰',
  'dolly-in': '推进',
  'dolly-out': '拉远',
  tracking: '跟拍',
  orbit: '环绕',
  handheld: '手持',
};

function nextShotStart(project: Project): number {
  return project.shots.reduce((latest, shot) => Math.max(latest, shot.endTime), 0);
}

function errorText(error: AiProviderErrorData): string {
  const retry = error.retryable ? '可手动重试' : '请修改输入或供应商设置';
  return `${error.code}: ${error.message} ${retry}；未自动重试。`;
}

function AdoptedShotRow({
  runtime,
  project,
  shot,
}: {
  runtime: StudioRuntime;
  project: Project;
  shot: ShotClipData;
}) {
  const duration = shot.endTime - shot.startTime;
  const [name, setName] = useState(shot.name);
  const [shotSize, setShotSize] = useState<StoryboardShotSize>(shot.shotSize ?? 'medium');
  const [movement, setMovement] = useState<StoryboardCameraMovement>(shot.movement ?? 'static');
  const [durationSeconds, setDurationSeconds] = useState(String(duration));
  const [prompt, setPrompt] = useState(shot.prompt ?? '');

  useEffect(() => {
    setName(shot.name);
    setShotSize(shot.shotSize ?? 'medium');
    setMovement(shot.movement ?? 'static');
    setDurationSeconds(String(shot.endTime - shot.startTime));
    setPrompt(shot.prompt ?? '');
  }, [shot]);

  const save = useCallback(
    (overrides: Partial<ShotClipData> = {}) => {
      const nextDuration = Number(durationSeconds);
      const result = runtime.editor.updateShot(
        shot.id,
        (current) => {
          const { prompt: promptOverride, ...otherOverrides } = overrides;
          const nextPrompt = promptOverride?.trim();
          return {
            ...current,
            name: name.trim(),
            endTime:
              Number.isFinite(nextDuration) && nextDuration >= 0.1
                ? current.startTime + nextDuration
                : current.endTime,
            ...otherOverrides,
            ...(promptOverride === undefined || (nextPrompt === '' && current.prompt === undefined)
              ? {}
              : { prompt: nextPrompt }),
          };
        },
        `编辑分镜「${shot.name}」`,
      );
      if (!result.ok) {
        showToast(result.error.message, 'error');
        setName(shot.name);
        setShotSize(shot.shotSize ?? 'medium');
        setMovement(shot.movement ?? 'static');
        setDurationSeconds(String(duration));
        setPrompt(shot.prompt ?? '');
      }
    },
    [duration, durationSeconds, name, runtime.editor, shot],
  );

  const cameras = project.objects.filter((object) => object.type === 'camera');

  return (
    <article className="lumora-storyboard__adopted-row" data-testid="storyboard-adopted-shot">
      <div className="lumora-storyboard__row-heading">
        <input
          className="lumora-storyboard__title-input"
          aria-label="分镜名称"
          value={name}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => save()}
        />
        {shot.aiSource && <span className="lumora-storyboard__source">AI</span>}
        <button
          type="button"
          className="lumora-icon-button lumora-icon-button--danger"
          aria-label={`删除分镜 ${shot.name}`}
          title="删除分镜"
          onClick={() => {
            const result = runtime.editor.deleteShot(shot.id);
            if (!result.ok) showToast(result.error.message, 'error');
          }}
        >
          删
        </button>
      </div>
      <div className="lumora-storyboard__compact-grid">
        <label>
          <span>景别</span>
          <select
            value={shotSize}
            onChange={(event) => {
              const value = event.target.value as StoryboardShotSize;
              setShotSize(value);
              save({ shotSize: value });
            }}
          >
            {STORYBOARD_SHOT_SIZES.map((value) => <option key={value} value={value}>{SHOT_SIZE_LABELS[value]}</option>)}
          </select>
        </label>
        <label>
          <span>运动</span>
          <select
            value={movement}
            onChange={(event) => {
              const value = event.target.value as StoryboardCameraMovement;
              setMovement(value);
              save({ movement: value });
            }}
          >
            {STORYBOARD_CAMERA_MOVEMENTS.map((value) => <option key={value} value={value}>{MOVEMENT_LABELS[value]}</option>)}
          </select>
        </label>
        <label>
          <span>时长（秒）</span>
          <input
            type="number"
            min="0.1"
            step="0.1"
            value={durationSeconds}
            onChange={(event) => setDurationSeconds(event.target.value)}
            onBlur={() => save()}
          />
        </label>
        <label>
          <span>机位</span>
          <select
            value={shot.cameraObjectId ?? ''}
            onChange={(event) => save({ cameraObjectId: event.target.value || null })}
          >
            <option value="">未绑定</option>
            {cameras.map((camera) => <option key={camera.id} value={camera.id}>{camera.name}</option>)}
          </select>
        </label>
      </div>
      <label className="lumora-storyboard__prompt-field">
        <span>提示词</span>
        <textarea
          rows={2}
          value={prompt}
          data-testid="storyboard-adopted-prompt"
          onChange={(event) => setPrompt(event.target.value)}
          onBlur={() => save({ prompt })}
        />
      </label>
    </article>
  );
}

export function StoryboardWorkspace({ runtime, project, onClose }: StoryboardWorkspaceProps) {
  useEventRefresh(runtime.events, ['contribution:changed']);
  const providers = runtime.host.services.ai.listStoryboardProviders();
  const [providerId, setProviderId] = useState(() => providers[0]?.id ?? '');
  const selectedProvider = providers.find((provider) => provider.id === providerId) ?? providers[0];
  const [modelId, setModelId] = useState(() => selectedProvider?.models[0]?.id ?? '');
  const selectedModel = selectedProvider?.models.find((model) => model.id === modelId) ?? selectedProvider?.models[0];
  const [concept, setConcept] = useState('');
  const [targetDurationSeconds, setTargetDurationSeconds] = useState(12);
  const [shotCount, setShotCount] = useState(3);
  const [visualStyle, setVisualStyle] = useState('电影感写实');
  const [draft, setDraft] = useState<StoryboardDraft | null>(null);
  const [acceptedIds, setAcceptedIds] = useState<Set<string>>(() => new Set());
  const [taskId, setTaskId] = useState<string | null>(null);
  const [error, setError] = useState<AiProviderErrorData | null>(null);
  const [tab, setTab] = useState<WorkspaceTab>('draft');
  const requestGenerationRef = useRef(0);
  const taskIdRef = useRef<string | null>(null);
  const conceptRef = useRef<HTMLTextAreaElement>(null);
  const workspaceRef = useRef<HTMLElement>(null);
  const draftTabRef = useRef<HTMLButtonElement>(null);
  const adoptedTabRef = useRef<HTMLButtonElement>(null);
  const onCloseRef = useRef(onClose);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!returnFocusRef.current && document.activeElement instanceof HTMLElement) {
      returnFocusRef.current = document.activeElement;
    }
    conceptRef.current?.focus();
    return () => {
      const trigger = returnFocusRef.current;
      if (trigger?.isConnected && !trigger.matches(':disabled')) trigger.focus();
    };
  }, []);

  const close = useCallback(() => {
    requestGenerationRef.current += 1;
    if (taskIdRef.current) runtime.host.services.ai.cancelGenerationTask(taskIdRef.current);
    taskIdRef.current = null;
    onCloseRef.current();
  }, [runtime.host.services.ai]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const workspace = workspaceRef.current;
      const inside = event.target instanceof Node && workspace?.contains(event.target);
      if (inside) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        close();
        return;
      }
      if (event.key === 'Tab') conceptRef.current?.focus();
      event.preventDefault();
      event.stopImmediatePropagation();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('keydown', onKeyDown, true);
      requestGenerationRef.current += 1;
      if (taskIdRef.current) runtime.host.services.ai.cancelGenerationTask(taskIdRef.current);
    };
  }, [close, runtime.host.services.ai]);

  const canGenerate =
    concept.trim().length >= 10 &&
    Number.isFinite(targetDurationSeconds) &&
    targetDurationSeconds >= 1 &&
    targetDurationSeconds <= 3_600 &&
    targetDurationSeconds * 10 >= shotCount &&
    targetDurationSeconds <= shotCount * 600 &&
    Number.isInteger(shotCount) &&
    shotCount >= 1 &&
    shotCount <= 24 &&
    visualStyle.trim().length <= 500 &&
    !!selectedProvider &&
    !!selectedModel &&
    !taskId;

  const generate = async () => {
    if (!canGenerate || !selectedProvider || !selectedModel) return;
    setDraft(null);
    setAcceptedIds(new Set());
    setError(null);
    const generation = requestGenerationRef.current + 1;
    requestGenerationRef.current = generation;
    try {
      const submitted = runtime.host.services.ai.submitStoryboard(selectedProvider.id, {
        model: selectedModel.id,
        brief: {
          concept: concept.trim(),
          targetDurationSeconds,
          shotCount,
          ...(visualStyle.trim() ? { visualStyle: visualStyle.trim() } : {}),
        },
      });
      taskIdRef.current = submitted.id;
      setTaskId(submitted.id);
      const completed = await runtime.host.services.ai.waitForGenerationTask(submitted.id);
      if (requestGenerationRef.current !== generation) return;
      taskIdRef.current = null;
      setTaskId(null);
      if (completed.status === 'succeeded' && completed.draft) {
        setDraft(completed.draft);
      } else if (completed.error) {
        setError(completed.error);
      }
    } catch (caught) {
      if (requestGenerationRef.current !== generation) return;
      taskIdRef.current = null;
      setTaskId(null);
      setError({
        code: 'invalid_request',
        message: caught instanceof Error ? caught.message : '无法提交生成任务。',
        retryable: false,
        costKnown: false,
      });
    }
  };

  const cancelGeneration = (currentTaskId: string) => {
    requestGenerationRef.current += 1;
    taskIdRef.current = null;
    setTaskId(null);
    setError({
      code: 'cancelled',
      message: 'Generation cancelled.',
      retryable: false,
      costKnown: false,
    });
    queueMicrotask(() => runtime.host.services.ai.cancelGenerationTask(currentTaskId));
  };

  const handleTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    let nextTab: WorkspaceTab | undefined;
    if (event.key === 'ArrowLeft') nextTab = tab === 'draft' ? 'adopted' : 'draft';
    else if (event.key === 'ArrowRight') nextTab = tab === 'draft' ? 'adopted' : 'draft';
    else if (event.key === 'Home') nextTab = 'draft';
    else if (event.key === 'End') nextTab = 'adopted';
    if (!nextTab) return;
    event.preventDefault();
    setTab(nextTab);
    (nextTab === 'draft' ? draftTabRef : adoptedTabRef).current?.focus();
  };

  const updateDraftShot = (index: number, patch: Partial<StoryboardDraftShot>) => {
    setDraft((current) =>
      current
        ? { ...current, shots: current.shots.map((shot, shotIndex) => shotIndex === index ? { ...shot, ...patch } : shot) }
        : current,
    );
  };

  const acceptIndexes = (indexes: number[]) => {
    if (!draft) return;
    const pending = indexes
      .filter((index) => draft.shots[index] && !acceptedIds.has(draft.shots[index]!.id))
      .map((index) => draft.shots[index]!);
    if (pending.length === 0) return;
    let cursor = nextShotStart(project);
    const shots = pending.map((candidate) => {
      const startTime = cursor;
      cursor += candidate.durationSeconds;
      return createShotClip(
        null,
        candidate.title,
        { startTime, endTime: cursor },
        {
          shotSize: candidate.shotSize,
          movement: candidate.movement,
          prompt: candidate.prompt,
          aiSource: { providerId: draft.providerId, model: draft.model, draftId: draft.id },
        },
      );
    });
    const result = shots.length === 1
      ? runtime.editor.addShot(shots[0]!)
      : runtime.editor.addShots(shots, `采用 AI 分镜草案「${draft.title}」`);
    if (!result.ok) {
      showToast(result.error.message, 'error');
      return;
    }
    setAcceptedIds((current) => new Set([...current, ...pending.map((shot) => shot.id)]));
    showToast(`已采用 ${shots.length} 个分镜`, 'success');
  };

  return (
    <section
      ref={workspaceRef}
      className="lumora-storyboard"
      data-testid="storyboard-workspace"
      role="dialog"
      aria-modal="true"
      aria-labelledby="storyboard-workspace-title"
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
          return;
        }
        if (event.key !== 'Tab') return;
        const focusables = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
          ),
        );
        const first = focusables[0];
        const last = focusables.at(-1);
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
    >
      <header className="lumora-storyboard__header">
        <div>
          <h2 id="storyboard-workspace-title">AI 分镜工作台</h2>
          <p>{project.name}</p>
        </div>
        <div className="lumora-storyboard__header-actions">
          <div className="lumora-storyboard__tabs" role="tablist" aria-label="分镜工作台视图">
            <button
              ref={draftTabRef}
              id="storyboard-tab-draft"
              type="button"
              role="tab"
              aria-controls="storyboard-panel-draft"
              aria-selected={tab === 'draft'}
              tabIndex={tab === 'draft' ? 0 : -1}
              className={tab === 'draft' ? 'is-active' : ''}
              onClick={() => setTab('draft')}
              onKeyDown={handleTabKeyDown}
            >
              生成草案
            </button>
            <button
              ref={adoptedTabRef}
              id="storyboard-tab-adopted"
              type="button"
              role="tab"
              aria-controls="storyboard-panel-adopted"
              aria-selected={tab === 'adopted'}
              tabIndex={tab === 'adopted' ? 0 : -1}
              className={tab === 'adopted' ? 'is-active' : ''}
              data-testid="storyboard-tab-adopted"
              onClick={() => setTab('adopted')}
              onKeyDown={handleTabKeyDown}
            >
              已采用 {project.shots.length}
            </button>
          </div>
          <button type="button" className="lumora-icon-button" aria-label="关闭 AI 分镜工作台" title="关闭" onClick={close}>
            ×
          </button>
        </div>
      </header>

      {tab === 'draft' ? (
        <div
          id="storyboard-panel-draft"
          className="lumora-storyboard__layout"
          role="tabpanel"
          aria-labelledby="storyboard-tab-draft"
        >
          <form
            className="lumora-storyboard__brief"
            onSubmit={(event) => {
              event.preventDefault();
              void generate();
            }}
          >
            <div className="lumora-storyboard__section-heading">
              <span>创意简报</span>
              <span>01</span>
            </div>
            <label className="lumora-storyboard__field lumora-storyboard__field--grow">
              <span>创意描述</span>
              <textarea
                ref={conceptRef}
                rows={7}
                maxLength={4_000}
                value={concept}
                data-testid="storyboard-concept"
                placeholder="描述人物、目标、冲突与场景氛围"
                disabled={!!taskId}
                onChange={(event) => setConcept(event.target.value)}
              />
              <small>{concept.length} / 4000</small>
            </label>
            <label className="lumora-storyboard__field">
              <span>视觉风格</span>
              <input maxLength={500} value={visualStyle} disabled={!!taskId} onChange={(event) => setVisualStyle(event.target.value)} />
            </label>
            <div className="lumora-storyboard__compact-grid">
              <label>
                <span>总时长（秒）</span>
                <input
                  type="number"
                  min="1"
                  max="3600"
                  step="1"
                  value={targetDurationSeconds}
                  data-testid="storyboard-duration"
                  disabled={!!taskId}
                  onChange={(event) => setTargetDurationSeconds(Number(event.target.value))}
                />
              </label>
              <label>
                <span>镜头数</span>
                <input
                  type="number"
                  min="1"
                  max="24"
                  step="1"
                  value={shotCount}
                  data-testid="storyboard-shot-count"
                  disabled={!!taskId}
                  onChange={(event) => setShotCount(Number(event.target.value))}
                />
              </label>
            </div>
            <label className="lumora-storyboard__field">
              <span>供应商</span>
              <select
                value={selectedProvider?.id ?? ''}
                data-testid="storyboard-provider"
                disabled={!!taskId}
                onChange={(event) => {
                  const next = providers.find((provider) => provider.id === event.target.value);
                  setProviderId(event.target.value);
                  setModelId(next?.models[0]?.id ?? '');
                  setDraft(null);
                  setError(null);
                }}
              >
                {providers.length === 0 && <option value="">无可用供应商</option>}
                {providers.map((provider) => <option key={provider.id} value={provider.id}>{provider.name}</option>)}
              </select>
            </label>
            <label className="lumora-storyboard__field">
              <span>模型 / 测试情景</span>
              <select
                value={selectedModel?.id ?? ''}
                data-testid="storyboard-model"
                disabled={!!taskId}
                onChange={(event) => {
                  setModelId(event.target.value);
                  setDraft(null);
                  setError(null);
                }}
              >
                {selectedProvider?.models.map((model) => <option key={model.id} value={model.id}>{model.name}</option>)}
              </select>
            </label>
            <div className="lumora-storyboard__cost" data-testid="storyboard-cost-hint">
              <span>费用预估</span>
              {selectedModel?.cost.kind === 'known'
                ? <strong>{selectedModel.cost.amount.toFixed(2)} {selectedModel.cost.currency}</strong>
                : <strong>未知</strong>}
              <small>{selectedModel?.cost.note ?? '选择模型后显示'}</small>
            </div>
            <div className="lumora-storyboard__submit-row">
              {taskId ? (
                <button
                  type="button"
                  className="lumora-button lumora-button--danger"
                  data-testid="storyboard-cancel"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    cancelGeneration(taskId);
                  }}
                >
                  取消生成
                </button>
              ) : (
                <button type="submit" className="lumora-button lumora-storyboard__primary" data-testid="storyboard-generate" disabled={!canGenerate}>
                  生成分镜草案
                </button>
              )}
            </div>
          </form>

          <div className="lumora-storyboard__drafts">
            <div className="lumora-storyboard__section-heading">
              <span>结构化草案</span>
              <span>02</span>
            </div>
            {taskId && (
              <div className="lumora-storyboard__status" role="status">
                <span className="lumora-storyboard__spinner" aria-hidden />
                正在生成并校验供应商响应…
              </div>
            )}
            {error && <div className="lumora-storyboard__error" data-testid="storyboard-error" role="alert">{errorText(error)}</div>}
            {!taskId && !error && !draft && (
              <div className="lumora-storyboard__empty-state">
                <span>尚无草案</span>
                <p>提交创意简报后，可在此编辑并采用镜头。</p>
              </div>
            )}
            {draft && (
              <>
                <div className="lumora-storyboard__draft-summary">
                  <div>
                    <h3>{draft.title}</h3>
                    <p>{draft.summary}</p>
                  </div>
                  <button
                    type="button"
                    className="lumora-button lumora-storyboard__primary"
                    data-testid="storyboard-accept-all"
                    disabled={draft.shots.every((shot) => acceptedIds.has(shot.id))}
                    onClick={() => acceptIndexes(draft.shots.map((_, index) => index))}
                  >
                    采用全部
                  </button>
                </div>
                <div className="lumora-storyboard__draft-list">
                  {draft.shots.map((shot, index) => {
                    const accepted = acceptedIds.has(shot.id);
                    return (
                      <article key={shot.id} className={`lumora-storyboard__draft-row${accepted ? ' is-accepted' : ''}`} data-testid="storyboard-draft-shot">
                        <div className="lumora-storyboard__row-heading">
                          <span className="lumora-storyboard__shot-number">{String(index + 1).padStart(2, '0')}</span>
                          <input
                            className="lumora-storyboard__title-input"
                            aria-label={`镜头 ${index + 1} 名称`}
                            value={shot.title}
                            disabled={accepted}
                            onChange={(event) => updateDraftShot(index, { title: event.target.value })}
                          />
                          <button
                            type="button"
                            className="lumora-button"
                            data-testid={`storyboard-accept-${index}`}
                            disabled={accepted}
                            onClick={() => acceptIndexes([index])}
                          >
                            {accepted ? '已采用' : '采用'}
                          </button>
                        </div>
                        <div className="lumora-storyboard__compact-grid lumora-storyboard__compact-grid--three">
                          <label>
                            <span>景别</span>
                            <select value={shot.shotSize} disabled={accepted} onChange={(event) => updateDraftShot(index, { shotSize: event.target.value as StoryboardShotSize })}>
                              {STORYBOARD_SHOT_SIZES.map((value) => <option key={value} value={value}>{SHOT_SIZE_LABELS[value]}</option>)}
                            </select>
                          </label>
                          <label>
                            <span>运动</span>
                            <select value={shot.movement} disabled={accepted} onChange={(event) => updateDraftShot(index, { movement: event.target.value as StoryboardCameraMovement })}>
                              {STORYBOARD_CAMERA_MOVEMENTS.map((value) => <option key={value} value={value}>{MOVEMENT_LABELS[value]}</option>)}
                            </select>
                          </label>
                          <label>
                            <span>时长（秒）</span>
                            <input
                              type="number"
                              min="0.1"
                              step="0.1"
                              value={shot.durationSeconds}
                              disabled={accepted}
                              onChange={(event) => updateDraftShot(index, { durationSeconds: Number(event.target.value) })}
                            />
                          </label>
                        </div>
                        <label className="lumora-storyboard__prompt-field">
                          <span>提示词</span>
                          <textarea
                            rows={2}
                            value={shot.prompt}
                            data-testid={`storyboard-draft-prompt-${index}`}
                            disabled={accepted}
                            onChange={(event) => updateDraftShot(index, { prompt: event.target.value })}
                          />
                        </label>
                      </article>
                    );
                  })}
                </div>
              </>
            )}
          </div>
        </div>
      ) : (
        <div
          id="storyboard-panel-adopted"
          className="lumora-storyboard__adopted"
          role="tabpanel"
          aria-labelledby="storyboard-tab-adopted"
        >
          <div className="lumora-storyboard__section-heading">
            <span>项目分镜</span>
            <span>{String(project.shots.length).padStart(2, '0')}</span>
          </div>
          {project.shots.length === 0 ? (
            <div className="lumora-storyboard__empty-state"><span>尚无已采用分镜</span></div>
          ) : (
            <div className="lumora-storyboard__adopted-list">
              {project.shots.map((shot) => <AdoptedShotRow key={shot.id} runtime={runtime} project={project} shot={shot} />)}
            </div>
          )}
        </div>
      )}
    </section>
  );
}
