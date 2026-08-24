import { z } from 'zod';

/** 反向域名风格 id，如 com.example.mock（要求小写） */
const ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9]+)+$/;

export const manifestSchema = z
  .object({
    schemaVersion: z.enum(['1'], {
      errorMap: () => ({ message: '不支持的 schemaVersion，当前仅支持 "1"' }),
    }),
    id: z.string().regex(ID_PATTERN, '必须为反向域名风格，如 com.example.mock'),
    name: z.string().min(1, '不能为空'),
    version: z.string().min(1, '不能为空'),
    description: z.string().optional(),
    author: z.string().optional(),
    entry: z.string().min(1, '不能为空'),
    engine: z
      .object({
        lumora: z.string().optional(),
      })
      .optional(),
    contributes: z.array(z.enum(['panel', 'command', 'toolbar', 'assetLoader', 'aiProvider', 'exporter'])).optional(),
    enabled: z.boolean().optional(),
    /** 插件显式声明 pluginData[instanceId] 下这些顶层键为私有（导出含私有设置时
     *  剥离，不进工程包）。仅声明才剥离 —— 凭据隔离是结构化契约（第十一轮）。 */
    privateSettings: z.array(z.string()).optional(),
    /** 插件显式公开导出契约（第十四轮阻断 1）：声明 pluginData[instanceId] 下哪些
     *  字段/路径可随工程包导出。元素为顶层键字符串（整值导出）或路径数组
     *  （['profile', 'username'] 逐层递归投影）；缺失或空声明 = 无可导出内容 =
     *  整个命名空间不导出（fail-closed，凭据永不导出不依赖插件自觉声明）。
     *  宿主读取后原样传入 buildProjectPackage 的 publicKeysByPlugin，不做减法
     *  过滤。 */
    exportableSettings: z.array(z.union([z.string(), z.array(z.string())])).optional(),
  })
  .strict();

export type Manifest = z.infer<typeof manifestSchema>;

export interface ManifestValidationResult {
  ok: boolean;
  errors: string[];
  manifest?: Manifest;
}

/**
 * 校验 lumora.plugin.json 结构。结构合法但语义有问题的字段
 * （如非 semver 的 version）也会被列出。
 */
export function validateManifest(input: unknown): ManifestValidationResult {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['Manifest 必须是 JSON 对象'] };
  }
  const parsed = manifestSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => {
        const path = issue.path.length > 0 ? `字段 ${issue.path.join('.')}` : 'Manifest';
        return `${path}: ${issue.message}`;
      }),
    };
  }
  const manifest = parsed.data;
  const errors: string[] = [];
  if (!semverValid(manifest.version)) {
    errors.push(`字段 version: "${manifest.version}" 不是合法 semver`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, errors: [], manifest };
}

function semverValid(version: string): boolean {
  // 精简 semver 校验：主.次.修订（允许 -prerelease / +build），避免 core 对 node 环境外的构建依赖
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version);
}
