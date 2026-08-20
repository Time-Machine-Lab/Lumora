import { satisfies, valid, validRange } from 'semver';
import type { Manifest } from './validate';

export interface EngineCheckResult {
  ok: boolean;
  reason?: string;
}

/**
 * 校验插件声明的引擎兼容范围与宿主版本。
 * engine.lumora 缺省视为兼容任意版本。
 */
export function checkEngineCompatibility(manifest: Manifest, hostVersion: string): EngineCheckResult {
  const range = manifest.engine?.lumora;
  if (!range) return { ok: true };
  if (!validRange(range)) {
    return { ok: false, reason: `engine.lumora "${range}" 不是合法的 semver 范围` };
  }
  if (!valid(hostVersion)) {
    return { ok: false, reason: `宿主版本 "${hostVersion}" 非法，无法进行兼容性判定` };
  }
  if (!satisfies(hostVersion, range)) {
    return { ok: false, reason: `宿主版本 ${hostVersion} 不满足插件引擎要求 ${range}` };
  }
  return { ok: true };
}
