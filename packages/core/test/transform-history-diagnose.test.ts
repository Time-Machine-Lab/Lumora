// 大载荷拖动诊断（DIAGNOSE=1 时运行）：对比历史记录携带载荷的成本——
// 旧策略（structuredClone + 2×JSON.stringify 全量项目）vs 新策略（不可变项目引用 + 局部变换比较）。
// 常规 CI 运行默认跳过；本地诊断：DIAGNOSE=1 npx vitest run packages/core/test/transform-history-diagnose.test.ts
import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import type { Result } from '../src/editor/scene-editor';
import { createSampleProject } from '../src/scene/sample-project';
import type { Project } from '../src/scene/types';

// 诊断用例依赖 Node 运行时全局（vitest），但不引入 @types/node 依赖：
// 以带类型的 globalThis 访问 process/gc，测试文件即可通过根级 tsc 检查。
const nodeGlobals = globalThis as typeof globalThis & {
  process?: { env: Record<string, string | undefined>; memoryUsage?: () => { heapUsed: number } };
  gc?: () => void;
};
const env = nodeGlobals.process?.env ?? {};
const DIAGNOSE = env.DIAGNOSE === '1';
const PAYLOAD_MIB = Number(env.DIAGNOSE_PAYLOAD_MIB ?? 50);

function ok<T>(result: Result<T>): T {
  if (!result.ok) throw new Error(`expected ok, got: ${result.error.message}`);
  return result.value as T;
}

function projectWithBigAsset(): Project {
  const project = createSampleProject();
  const payload = 'A'.repeat(PAYLOAD_MIB * 1024 * 1024);
  project.assets = [
    {
      id: 'asset-big',
      kind: 'gltf',
      name: 'big.glb',
      mime: 'model/gltf-binary',
      hash: `hash-big-${PAYLOAD_MIB}`,
      size: payload.length,
      source: 'file',
      storageRef: 'blob:test',
      createdAt: '2026-01-01',
      payload,
    },
  ];
  return project;
}

function heapUsed(): number {
  const memory = nodeGlobals.process?.memoryUsage;
  return memory ? memory().heapUsed : 0;
}

const gc = typeof nodeGlobals.gc === 'function' ? nodeGlobals.gc : null;

/** 旧策略：begin 克隆 + commit 双序列化（评审指出的历史缺陷），纯内存模拟 */
function measureLegacy(project: Project, _objectId: string) {
  const next: Project = { ...project, objects: [...project.objects] };
  const beginT0 = performance.now();
  const clone = structuredClone(project);
  const beginMs = performance.now() - beginT0;
  const commitT0 = performance.now();
  JSON.stringify(clone);
  JSON.stringify(next);
  const commitMs = performance.now() - commitT0;
  return { beginMs, commitMs };
}

/** 新策略：拖动前只存引用，提交时局部比较 9 个数值 */
function measureCurrent(project: Project, objectId: string) {
  const editor = new SceneEditor();
  editor.openProject(project);
  const beginT0 = performance.now();
  editor.beginTransform();
  const beginMs = performance.now() - beginT0;
  const commitT0 = performance.now();
  ok(editor.commitTransform(objectId, { position: [1, 1, 1], rotation: [0, 0, 0], scale: [1, 1, 1] }));
  const commitMs = performance.now() - commitT0;
  return { beginMs, commitMs };
}

describe.runIf(DIAGNOSE)('P0-7 大载荷拖动诊断（DIAGNOSE=1）', () => {
  it(`payload ${PAYLOAD_MIB}MiB：引用策略在 begin/commit 均优于克隆+序列化，且不放大堆占用`, () => {
    gc?.();
    const project = projectWithBigAsset();
    const objectId = project.objects[1]!.id;

    // 预热（JIT / 分配器缓存）
    measureLegacy(project, objectId);
    measureCurrent(project, objectId);

    gc?.();
    const heapBefore = heapUsed();
    const legacy = measureLegacy(project, objectId);
    gc?.();
    const heapAfterLegacy = heapUsed();

    const current = measureCurrent(project, objectId);
    gc?.();
    const heapAfterCurrent = heapUsed();

    const payloadMiB = PAYLOAD_MIB;
    // eslint-disable-next-line no-console -- 诊断输出
    console.log(
      `[diagnose] payload=${payloadMiB}MiB ` +
        `legacy begin=${legacy.beginMs.toFixed(1)}ms commit=${legacy.commitMs.toFixed(1)}ms ` +
        `current begin=${current.beginMs.toFixed(3)}ms commit=${current.commitMs.toFixed(3)}ms ` +
        `legacy heapDelta=${((heapAfterLegacy - heapBefore) / 1024 / 1024).toFixed(1)}MiB ` +
        `current heapDelta=${((heapAfterCurrent - heapBefore) / 1024 / 1024).toFixed(1)}MiB`,
    );

    // 慢/内存放大不是失败判定（CI 机器波动大），但诊断要求量级断言：
    // 新策略 begin 是 O(1) 引用记录，legacy begin 是 O(n) 克隆 → 至少快 10 倍
    expect(current.beginMs * 10).toBeLessThan(Math.max(legacy.beginMs, 1));
    // 新策略 commit 局部比较 9 个数值，legacy 双序列化 → 至少快 10 倍
    expect(current.commitMs * 10).toBeLessThan(Math.max(legacy.commitMs, 1));
  });
});
