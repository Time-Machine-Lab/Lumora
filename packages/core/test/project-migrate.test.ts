import { describe, expect, it } from 'vitest';
import { CURRENT_PROJECT_SCHEMA_VERSION } from '../src/project/schema';
import { migrateProjectSchema } from '../src/project/migrate';
import { parseProjectPackage, serializeProjectPackage } from '../src/project/package';
import { buildProjectPackage } from '../src/project/package';
import { createSampleProject } from '../src/scene/sample-project';
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
    // 字段级透传：除迁移点外不丢任何数据
    const original = input as unknown as Project;
    expect(migrated.uri).toBe(original.uri);
    expect(migrated.name).toBe(original.name);
    expect(migrated.settings).toEqual(original.settings);
    expect(migrated.scenes).toEqual(original.scenes);
    expect(migrated.objects.map(({ visible: _v, locked: _l, ...rest }) => rest)).toEqual(
      original.objects.map(({ visible: _v, locked: _l, ...rest }) => rest),
    );
    expect(migrated.assets).toEqual(original.assets);
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
