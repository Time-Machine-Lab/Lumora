import { describe, expect, it } from 'vitest';
import { CURRENT_PROJECT_SCHEMA_VERSION } from '../src/project/schema';
import { migrateProjectSchema } from '../src/project/migrate';
import { parseProjectPackage, serializeProjectPackage } from '../src/project/package';
import { buildProjectPackage } from '../src/project/package';
import { createSampleProject } from '../src/scene/sample-project';
import { validateProjectSchema } from '../src/scene/validate';
import type { Project } from '../src/scene/types';

/**
 * v1 历史草案夹具（文档化，仅供迁移管道测试）：对象条目缺 visible/locked
 * （草案期默认可见、未锁定），其余结构与 v2 一致。
 */
function v1Fixture(): Record<string, unknown> {
  const v2 = createSampleProject('lumora://sample-project', '迁移样本');
  return {
    ...v2,
    schemaVersion: 1,
    objects: v2.objects.map(({ visible: _visible, locked: _locked, ...rest }) => ({ ...rest })),
  };
}

/** v2 夹具（TML-88 迁移测试）：无 tracks 字段（v2 schema 无轨道概念）。 */
function v2Fixture(): Record<string, unknown> {
  const v3 = createSampleProject('lumora://sample-project', '迁移样本');
  const { tracks: _tracks, ...v2 } = v3;
  return { ...v2, schemaVersion: 2 };
}

describe('migrateProjectSchema：版本化 schema 迁移管道（NFR-017）', () => {
  it('v1 → 当前版本：补默认字段、schemaVersion 升级、其余字段完整保留（不静默丢字段）', () => {
    const input = v1Fixture();
    const result = migrateProjectSchema(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(1);
    const migrated = result.project as Project;
    expect(migrated.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
    for (const object of migrated.objects) {
      expect(object.visible).toBe(true);
      expect(object.locked).toBe(false);
    }
    // 字段级透传：除迁移点外不丢任何数据（含 v1 携带的 tracks 原样到达 v3）
    const original = input as unknown as Project;
    expect(migrated.uri).toBe(original.uri);
    expect(migrated.name).toBe(original.name);
    expect(migrated.settings).toEqual(original.settings);
    expect(migrated.scenes).toEqual(original.scenes);
    expect(migrated.objects.map(({ visible: _v, locked: _l, ...rest }) => rest)).toEqual(
      original.objects.map(({ visible: _v, locked: _l, ...rest }) => rest),
    );
    expect(migrated.tracks).toEqual(original.tracks);
    expect(migrated.assets).toEqual(original.assets);
  });

  it('v2 → 当前版本：无 tracks 的 v2 数据补默认空数组，其余字段完整保留', () => {
    const input = v2Fixture();
    const result = migrateProjectSchema(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(2);
    const migrated = result.project as Project;
    expect(migrated.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
    expect(migrated.tracks).toEqual([]);
    // 字段级透传：迁移点之外不丢任何数据
    const original = input as unknown as Project;
    expect(migrated.uri).toBe(original.uri);
    expect(migrated.name).toBe(original.name);
    expect(migrated.settings).toEqual(original.settings);
    expect(migrated.scenes).toEqual(original.scenes);
    expect(migrated.objects).toEqual(original.objects);
    expect(migrated.assets).toEqual(original.assets);
  });

  it('v2 数据携带 tracks（手工构造）时原样透传，不覆盖不丢弃', () => {
    const input = v2Fixture();
    const tracks = [
      {
        id: 't1',
        name: '推镜',
        objectId: 'sample-camera',
        targetPath: 'position' as const,
        keyframes: [{ time: 0, value: [0, 0, 0] as [number, number, number] }],
      },
    ];
    input.tracks = tracks;
    const result = migrateProjectSchema(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const migrated = result.project as Project;
    expect(migrated.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
    expect(migrated.tracks).toEqual(tracks);
  });

  it('v2 数据携带非数组 tracks → 迁移原样保留（不静默置空掩盖损坏），v3 校验明确拒绝', () => {
    const input = v2Fixture();
    input.tracks = 'corrupted';
    const result = migrateProjectSchema(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const migrated = result.project as unknown as { schemaVersion: number; tracks: unknown };
    expect(migrated.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
    expect(migrated.tracks).toBe('corrupted');
    // 非法值保留到校验阶段明确拒绝：绝不静默置空
    expect(validateProjectSchema(migrated)).toContain('tracks');
  });

  it('v2 数据携带自定义未知字段时透传保留（不静默丢字段）', () => {
    const input = v2Fixture();
    input.customTopLevel = { nested: [1, 2, 3] };
    const result = migrateProjectSchema(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const migrated = result.project as unknown as Record<string, unknown>;
    expect(migrated.customTopLevel).toEqual({ nested: [1, 2, 3] });
  });

  it('v1 对象携带自定义未知字段时透传保留', () => {
    const input = v1Fixture();
    const objects = input.objects as Array<Record<string, unknown>>;
    objects[0]!.customField = { nested: [1, 2, 3] };
    const result = migrateProjectSchema(input);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const migrated = result.project as Project;
    expect(migrated.objects[0]).toMatchObject({ customField: { nested: [1, 2, 3] } });
  });

  it('当前版本直接通过（migratedFrom = 当前）', () => {
    const result = migrateProjectSchema(createSampleProject());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
  });

  it('未来版本 → 可操作错误（升级提示），不猜测解释', () => {
    const result = migrateProjectSchema({ schemaVersion: CURRENT_PROJECT_SCHEMA_VERSION + 1 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('future-schema-version');
    expect(result.error.message).toContain('升级');
    expect(result.error.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION + 1);
  });

  it('缺失 schemaVersion → 明确错误（schemaVersion 必填）', () => {
    const result = migrateProjectSchema({ uri: 'lumora://x', name: 'x' });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('missing-schema-version');
    expect(result.error.message).toContain('schemaVersion');
  });

  it('非法 schemaVersion（字符串/非整数）→ 明确错误', () => {
    for (const bad of ['2', 2.5, 0, -1]) {
      const result = migrateProjectSchema({ schemaVersion: bad });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.error.kind).toBe('invalid-schema-version');
    }
  });

  it('非对象输入 → invalid-schema-version', () => {
    const result = migrateProjectSchema(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid-schema-version');
  });
});

describe('迁移与包解析集成（AC3：未知 schema 的包导入失败）', () => {
  it('v1 工程包经解析完整恢复为当前版本', async () => {
    const v1 = v1Fixture() as unknown as Project;
    const pkg = buildProjectPackage(v1, { exportedAt: '2026-08-21T00:00:00.000Z' });
    // 序列化后 project 的 schemaVersion 应为 1（打包不迁移，解析时才迁移）
    const parsed = JSON.parse(serializeProjectPackage(pkg)) as { project: Project };
    expect(parsed.project.schemaVersion).toBe(1);
    const result = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(1);
    expect(result.project.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
    expect(result.project.objects.every((o) => o.visible === true && o.locked === false)).toBe(true);
    expect(result.project.scenes).toEqual(v1.scenes);
    expect(result.project.tracks).toEqual(v1.tracks);
  });

  it('v2 工程包经解析迁移：tracks 补空数组，数据与引用完整恢复', async () => {
    const v2 = v2Fixture() as unknown as Project;
    const pkg = buildProjectPackage(v2, { exportedAt: '2026-08-21T00:00:00.000Z' });
    const parsed = JSON.parse(serializeProjectPackage(pkg)) as { project: Project };
    expect(parsed.project.schemaVersion).toBe(2);
    const result = await parseProjectPackage(serializeProjectPackage(pkg));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.migratedFrom).toBe(2);
    expect(result.project.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION);
    expect(result.project.tracks).toEqual([]);
    expect(result.project.scenes).toEqual(v2.scenes);
    expect(result.project.objects).toEqual(v2.objects);
  });

  it('未来 schemaVersion 的包导入失败，返回可操作错误', async () => {
    const pkg = buildProjectPackage(createSampleProject());
    const raw = JSON.parse(serializeProjectPackage(pkg)) as { project: Record<string, unknown> };
    raw.project.schemaVersion = 99;
    const result = await parseProjectPackage(JSON.stringify(raw));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe('migration-failed');
    expect(result.error.message).toContain('升级');
  });
});
