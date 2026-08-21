/**
 * 事件摘要：把任意 payload 折叠为有界单行文本，避免 JSON.stringify 式的
 * GB 级字符串（TML-87）。所有文本源（字符串、Error.message、BigInt、Symbol、
 * 对象键名）统一经过共享字符预算截断，最终行另有硬上限。
 */

export const SUMMARY_CHAR_BUDGET = 4096;

const SUMMARY_STRING_LIMIT = 120;
const SUMMARY_KEYS_LIMIT = 8;
const SUMMARY_ITEMS_LIMIT = 8;
const SUMMARY_DEPTH_LIMIT = 4;
const ELLIPSIS = '…';

interface SummaryBudget {
  remaining: number;
  truncated: boolean;
}

/** 从共享预算中取一段文本；预算耗尽后返回空串并置 truncated */
function spend(text: string, budget: SummaryBudget): string {
  if (budget.truncated) return '';
  if (text.length <= budget.remaining) {
    budget.remaining -= text.length;
    return text;
  }
  budget.truncated = true;
  const part = text.slice(0, budget.remaining);
  budget.remaining = 0;
  return part;
}

/** 内容特征判定：超长、base64 字符集、大小写混合 → 视为 base64 载荷，只标注长度不落内容 */
function isBase64Like(value: string): boolean {
  if (value.length <= 200) return false;
  const head = value.slice(0, 200);
  return /^[A-Za-z0-9+/]+$/.test(head) && /[A-Z]/.test(head) && /[a-z]/.test(head);
}

export function summarize(value: unknown): string {
  const budget: SummaryBudget = { remaining: SUMMARY_CHAR_BUDGET, truncated: false };
  const line = summarizeValue(value, 0, budget);
  const final = budget.truncated ? `${line}${ELLIPSIS}` : line;
  return final.length > SUMMARY_CHAR_BUDGET ? `${final.slice(0, SUMMARY_CHAR_BUDGET)}${ELLIPSIS}` : final;
}

function summarizeValue(value: unknown, depth: number, budget: SummaryBudget): string {
  if (budget.truncated) return '';
  if (value === null) return spend('null', budget);
  switch (typeof value) {
    case 'string': {
      if (isBase64Like(value)) return spend(`[base64: ${value.length} 字符]`, budget);
      const display =
        value.length > SUMMARY_STRING_LIMIT
          ? `"${value.slice(0, SUMMARY_STRING_LIMIT)}…"(${value.length} 字符)`
          : JSON.stringify(value);
      return spend(display, budget);
    }
    case 'number':
    case 'boolean':
      return spend(String(value), budget);
    case 'undefined':
      return spend('undefined', budget);
    case 'bigint':
      return spend(`${value}n`, budget);
    case 'function':
      return spend('[function]', budget);
    case 'symbol':
      return spend(value.toString(), budget);
    default: {
      if (value instanceof Error) return spend(`[Error: ${value.message}]`, budget);
      if (Array.isArray(value)) {
        if (depth >= SUMMARY_DEPTH_LIMIT) return spend(`[数组×${value.length}]`, budget);
        let out = spend('[', budget);
        const shown = Math.min(value.length, SUMMARY_ITEMS_LIMIT);
        for (let i = 0; i < shown && !budget.truncated; i++) {
          if (i > 0) out += spend(', ', budget);
          out += summarizeValue(value[i], depth + 1, budget);
        }
        if (value.length > shown && !budget.truncated) out += spend(`, …共 ${value.length} 项`, budget);
        return out + spend(']', budget);
      }
      const record = value as Record<string, unknown>;
      let out = spend('{', budget);
      let shown = 0;
      let hasMore = false;
      for (const key in record) {
        if (!Object.prototype.hasOwnProperty.call(record, key)) continue;
        if (shown >= SUMMARY_KEYS_LIMIT) {
          // 发现第 9 个自有键即停：不遍历全部键去统计总数
          hasMore = true;
          break;
        }
        if (budget.truncated) break;
        if (shown > 0) out += spend(', ', budget);
        shown++;
        out += depth >= SUMMARY_DEPTH_LIMIT
          ? spend(`${key}: …`, budget)
          : spend(`${key}: `, budget) + summarizeValue(record[key], depth + 1, budget);
      }
      if (hasMore && !budget.truncated) out += spend(', …', budget);
      return out + spend('}', budget);
    }
  }
}
