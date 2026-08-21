import { useEffect, useRef, useState } from 'react';
import { findObject, focalLengthToFovDeg } from '@lumora/core';
import type { Project, SceneEditor, SceneObjectData, Vec3 } from '@lumora/core';
import { showToast } from './toasts';

interface PropertiesPanelProps {
  editor: SceneEditor;
  project: Project | null;
  selection: string[];
}

const DEG = 180 / Math.PI;
const RAD = Math.PI / 180;

/**
 * 数值字段：提交时校验（拒绝 NaN/Infinity，核心层兜底），非法输入回退并提示。
 * ref 镜像 draft：Escape→blur 同帧取消不提交（blur 同步触发，state 尚未刷新，
 * 闭包若直接读 state 会把已编辑值提交出去）；外部值更新（提交生效/撤销重做/
 * 切换对象）时放弃未提交草稿，回显最新值。
 */
function NumberField({
  label,
  value,
  step = 0.1,
  unit = '',
  testId,
  onCommit,
}: {
  label: string;
  value: number;
  step?: number;
  unit?: string;
  testId?: string;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const setDraftBoth = (value: string | null) => {
    draftRef.current = value;
    setDraft(value);
  };
  useEffect(() => {
    setDraftBoth(null);
  }, [value]);
  const display = draft ?? String(Number(value.toFixed(4)));
  const commit = () => {
    const raw = draftRef.current;
    setDraftBoth(null);
    if (raw === null) return;
    const parsed = Number.parseFloat(raw);
    if (!Number.isFinite(parsed)) {
      showToast(`「${label}」数值非法（不允许 NaN/Infinity）`, 'error');
      return;
    }
    onCommit(parsed);
  };
  return (
    <label className="lumora-field">
      <span className="lumora-field__label">{label}</span>
      <input
        type="number"
        step={step}
        data-testid={testId}
        value={display}
        onChange={(e) => setDraftBoth(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            // 先清 ref（同步）再 blur：blur 的 commit 读到 null → 取消提交
            setDraftBoth(null);
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {unit && <span className="lumora-field__unit">{unit}</span>}
    </label>
  );
}

/**
 * 名称输入：受控草稿，随 object.id / object.name 同步（切换对象、外部改名、
 * 撤销/重做后回显最新名称）。ref 镜像 draft，保证 Escape→blur 同帧取消不提交。
 */
function NameField({
  object,
  onCommit,
}: {
  object: SceneObjectData;
  onCommit: (name: string) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const draftRef = useRef<string | null>(null);
  const setDraftBoth = (value: string | null) => {
    draftRef.current = value;
    setDraft(value);
  };
  useEffect(() => {
    setDraftBoth(null);
  }, [object.id, object.name]);
  const commit = () => {
    const raw = draftRef.current;
    setDraftBoth(null);
    if (raw === null) return;
    onCommit(raw);
  };
  return (
    <input
      key={object.id}
      className="lumora-inspector__name"
      data-testid="inspector-name"
      value={draft ?? object.name}
      onChange={(e) => setDraftBoth(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          setDraftBoth(null);
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

function ColorField({
  label,
  value,
  testId,
  onCommit,
}: {
  label: string;
  value: string;
  testId?: string;
  onCommit: (value: string) => void;
}) {
  return (
    <label className="lumora-field">
      <span className="lumora-field__label">{label}</span>
      <input
        type="color"
        data-testid={testId}
        value={value}
        onChange={(e) => onCommit(e.target.value)}
      />
    </label>
  );
}

/** 属性面板：名称/变换数值编辑（角度制显示）、材质/灯光/摄像机参数 */
export function PropertiesPanel({ editor, project, selection }: PropertiesPanelProps) {
  if (!project) return null;
  if (selection.length === 0) {
    return (
      <aside className="lumora-inspector" data-testid="lumora-inspector" aria-label="属性面板">
        <div className="lumora-inspector__empty" data-testid="inspector-empty">
          未选择对象
        </div>
      </aside>
    );
  }
  const objects = selection
    .map((id) => findObject(project, id))
    .filter((o): o is SceneObjectData => !!o);
  if (objects.length === 0) return null;
  const object = objects[0]!;

  const commitName = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || trimmed === object.name) return;
    const result = editor.updateObjectProps(object.id, (o) => ({ ...o, name: trimmed }), '重命名');
    if (!result.ok) showToast(result.error.message, 'error');
  };

  const commitTransform = (partial: Partial<{ position: Vec3; rotation: Vec3; scale: Vec3 }>) => {
    const result = editor.setTransform(
      object.id,
      {
        position: partial.position ?? object.transform.position,
        rotation: partial.rotation ?? object.transform.rotation,
        scale: partial.scale ?? object.transform.scale,
      },
      '设置变换',
    );
    if (!result.ok) showToast(result.error.message, 'error');
  };

  const commitProps = (
    updater: (object: SceneObjectData) => SceneObjectData | null,
    label: string,
  ) => {
    const result = editor.updateObjectProps(object.id, updater, label);
    if (!result.ok) showToast(result.error.message, 'error');
  };

  return (
    <aside className="lumora-inspector" data-testid="lumora-inspector" aria-label="属性面板">
      {objects.length > 1 ? (
        <div className="lumora-inspector__multi" data-testid="inspector-multi">
          已选择 {objects.length} 个对象 —— 请单选编辑属性
        </div>
      ) : (
        <div className="lumora-inspector__body" key={object.id}>
          <header className="lumora-inspector__header">
            <NameField object={object} onCommit={commitName} />
            <span className="lumora-state">{TYPE_LABEL[object.type]}</span>
            {object.locked && (
              <span className="lumora-state lumora-state--active" data-testid="inspector-locked">
                已锁定
              </span>
            )}
          </header>

          <section className="lumora-inspector__section" data-testid="inspector-transform">
            <h3>变换{object.locked ? '（锁定，不可编辑）' : ''}</h3>
            <div className="lumora-field-grid">
              {(['position', 'rotation', 'scale'] as const).map((axis) => (
                <div key={axis} className="lumora-field-row">
                  <span className="lumora-field-row__axis">
                    {axis === 'position' ? '位置' : axis === 'rotation' ? '旋转' : '缩放'}
                  </span>
                  {axis === 'rotation' ? (
                    <RotationFields
                      values={object.transform.rotation}
                      locked={object.locked}
                      onCommit={(rotation) => commitTransform({ rotation })}
                    />
                  ) : (
                    <AxisFields
                      values={object.transform[axis]}
                      locked={object.locked}
                      testIdPrefix={axis === 'position' ? 'inspector-axis' : 'inspector-scale'}
                      onCommit={(values) => commitTransform({ [axis]: values })}
                    />
                  )}
                </div>
              ))}
            </div>
          </section>

          {object.type === 'primitive' && object.material && (
            <section className="lumora-inspector__section" data-testid="inspector-material">
              <h3>材质</h3>
              <ColorField
                label="颜色"
                value={object.material.color}
                testId="inspector-color"
                onCommit={(color) => commitProps((o) => ({ ...o, material: { color } }), '修改材质颜色')}
              />
            </section>
          )}

          {object.type === 'light' && object.light && (
            <section className="lumora-inspector__section" data-testid="inspector-light">
              <h3>灯光 · {LIGHT_LABEL[object.light.kind]}</h3>
              <ColorField
                label="颜色"
                value={object.light.color}
                testId="inspector-light-color"
                onCommit={(color) => commitProps((o) => ({ ...o, light: { ...o.light!, color } }), '修改灯光颜色')}
              />
              <NumberField
                label="强度"
                value={object.light.intensity}
                step={0.1}
                testId="inspector-light-intensity"
                onCommit={(intensity) =>
                  commitProps((o) => ({ ...o, light: { ...o.light!, intensity } }), '修改灯光强度')
                }
              />
              {object.light.kind !== 'directional' && (
                <NumberField
                  label="衰减距离"
                  value={object.light.distance ?? 0}
                  step={0.5}
                  testId="inspector-light-distance"
                  onCommit={(distance) =>
                    commitProps((o) => ({ ...o, light: { ...o.light!, distance } }), '修改灯光衰减')
                  }
                />
              )}
              {object.light.kind === 'spot' && (
                <NumberField
                  label="光锥角度"
                  value={Math.round((object.light.angle ?? 0) * DEG)}
                  step={1}
                  unit="°"
                  testId="inspector-light-angle"
                  onCommit={(angle) =>
                    commitProps(
                      (o) => ({ ...o, light: { ...o.light!, angle: Math.max(0.1, angle * RAD) } }),
                      '修改光锥角度',
                    )
                  }
                />
              )}
            </section>
          )}

          {object.type === 'camera' && object.camera && (
            <section className="lumora-inspector__section" data-testid="inspector-camera">
              <h3>摄像机</h3>
              <NumberField
                label="焦距"
                value={object.camera.focalLength}
                step={1}
                unit="mm"
                testId="inspector-focal-length"
                onCommit={(focalLength) =>
                  commitProps((o) => {
                    const c = o.camera!;
                    const fov = Math.round(focalLengthToFovDeg(Math.max(1, focalLength)) * 100) / 100;
                    return { ...o, camera: { ...c, focalLength, fov } };
                  }, '设置焦距')
                }
              />
              <NumberField
                label="FOV"
                value={Math.round(object.camera.fov * 100) / 100}
                step={0.1}
                unit="°"
                testId="inspector-fov"
                onCommit={(fov) =>
                  commitProps((o) => ({ ...o, camera: { ...o.camera!, fov } }), '设置视场角')
                }
              />
              <NumberField
                label="近平面"
                value={object.camera.near}
                step={0.01}
                testId="inspector-near"
                onCommit={(near) =>
                  commitProps((o) => ({ ...o, camera: { ...o.camera!, near } }), '设置近平面')
                }
              />
              <NumberField
                label="远平面"
                value={object.camera.far}
                step={1}
                testId="inspector-far"
                onCommit={(far) =>
                  commitProps((o) => ({ ...o, camera: { ...o.camera!, far } }), '设置远平面')
                }
              />
              <p className="lumora-inspector__note">
                画幅 {project.settings.aspect[0]}:{project.settings.aspect[1]}（跟随项目）
              </p>
            </section>
          )}

          {object.type === 'model' && (
            <section className="lumora-inspector__section" data-testid="inspector-model">
              <h3>模型</h3>
              <p className="lumora-inspector__note">
                资源：{project.assets.find((a) => a.id === object.assetId)?.name ?? '未知'}
              </p>
            </section>
          )}
        </div>
      )}
    </aside>
  );
}

const TYPE_LABEL: Record<SceneObjectData['type'], string> = {
  group: '组',
  model: '模型',
  primitive: '几何体',
  light: '灯光',
  camera: '摄像机',
};

const LIGHT_LABEL: Record<string, string> = {
  directional: '平行光',
  point: '点光源',
  spot: '聚光灯',
};

function AxisFields({
  values,
  locked,
  testIdPrefix,
  onCommit,
}: {
  values: Vec3;
  locked: boolean;
  testIdPrefix: string;
  onCommit: (values: Vec3) => void;
}) {
  return (
    <>
      {([0, 1, 2] as const).map((index) => (
        <NumberField
          key={index}
          label={AXIS_LABEL[index]}
          value={values[index]}
          step={0.1}
          testId={`${testIdPrefix}-${index}`}
          onCommit={(value) => {
            if (locked) {
              showToast('对象已锁定，无法变换', 'error');
              return;
            }
            const next = [...values] as Vec3;
            next[index] = value;
            onCommit(next);
          }}
        />
      ))}
    </>
  );
}

function RotationFields({
  values,
  locked,
  onCommit,
}: {
  values: Vec3;
  locked: boolean;
  onCommit: (values: Vec3) => void;
}) {
  return (
    <>
      {([0, 1, 2] as const).map((index) => (
        <NumberField
          key={index}
          label={AXIS_LABEL[index]}
          value={Math.round(values[index] * DEG * 100) / 100}
          step={1}
          unit="°"
          testId={`inspector-rotation-${index}`}
          onCommit={(value) => {
            if (locked) {
              showToast('对象已锁定，无法变换', 'error');
              return;
            }
            const next = [...values] as Vec3;
            next[index] = value * RAD;
            onCommit(next);
          }}
        />
      ))}
    </>
  );
}

const AXIS_LABEL = ['X', 'Y', 'Z'];
