/**
 * 事件日志行摘要（TML-87）：事件名与 payload 共享同一字符/节点预算，
 * 产出恒 <= SUMMARY_CHAR_BUDGET 的单行文本。
 *
 * - 已知事件按声明字段逐字段摘要，不做顶层反射；未知事件的对象退化为固定占位
 * - 所有文本（字符串、Error.message、键名、Symbol 描述、事件名）统一转义
 *   \r \n U+2028 U+2029 后再进入预算，转义只作用于实际输出的片段
 * - base64 资产内容按路径（payload 字段）直接掩码；内容启发式仅兜底且有界采样
 * - 值访问与键枚举受节点预算约束；getter/Proxy/反射失败容错
 */

export const SUMMARY_CHAR_BUDGET = 4096;

const SUMMARY_STRING_LIMIT = 120;
const SUMMARY_KEYS_LIMIT = 8;
const SUMMARY_ITEMS_LIMIT = 8;
const SUMMARY_DEPTH_LIMIT = 4;
const SUMMARY_NODE_BUDGET = 64;
const ELLIPSIS = '…';

/** 已知事件的展示字段（字段级摘要；缺失的事件视为未知，对象退化为占位） */
const KNOWN_EVENT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  'project:changed': ['project'],
  'project:opened': ['name', 'project'],
  'project:closed': ['uri'],
  'plugin:state-changed': ['instanceId', 'pluginId', 'state', 'error'],
  'plugin:contributed': ['pluginId'],
  'contribution:changed': ['pluginId'],
  'command:changed': ['id', 'added'],
  'command:executed': ['id', 'ok', 'error'],
};

/** 资产内容字段名：按路径直接掩码，不读内容 */
const ASSET_CONTENT_KEYS = new Set(['payload']);

/** BigInt 分级占位：安全整数范围内显示数值，超出退化为固定占位（避免无界十进制转换） */
const BIGINT_DISPLAY_LIMIT = 1_000_000_000_000_000_000n;

const CONTROL_ESCAPES: Readonly<Record<string, string>> = {
  '\r': '\\r',
  '\n': '\\n',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029',
};

function escapeControl(text: string): string {
  return text.replace(/[\r\n\u2028\u2029]/g, (ch) => CONTROL_ESCAPES[ch]);
}

class LineWriter {
  private readonly parts: string[] = [];
  private chars = SUMMARY_CHAR_BUDGET;
  private nodes = SUMMARY_NODE_BUDGET;
  private doneFlag = false;

  get done(): boolean {
    return this.doneFlag;
  }

  /** 写入文本：只对实际输出的片段转义并消费预算；超限时预留省略号空间后截断 */
  write(text: string): void {
    if (this.doneFlag) return;
    let raw = text.length > this.chars ? text.slice(0, Math.max(0, this.chars - ELLIPSIS.length)) : text;
    let safe = escapeControl(raw);
    while (safe.length > this.chars && raw.length > 0) {
      // 转义会放大长度：按超额量收缩原始片段，保证不切断转义序列
      raw = raw.slice(0, Math.max(0, raw.length - (safe.length - this.chars)));
      safe = escapeControl(raw);
    }
    this.chars -= safe.length;
    this.parts.push(safe);
    if (raw.length < text.length) this.truncate();
  }

  /** 消费一个节点预算；耗尽后截断并终止 */
  takeNode(): boolean {
    if (this.doneFlag) return false;
    if (this.nodes <= 0) {
      this.truncate();
      return false;
    }
    this.nodes--;
    return true;
  }

  truncate(): void {
    if (this.doneFlag) return;
    this.doneFlag = true;
    if (this.chars > 0) {
      this.parts.push(ELLIPSIS);
      this.chars = 0;
    }
  }

  get value(): string {
    return this.parts.join('');
  }
}

/** 读取可能抛错的属性（throwing getter / 恶意 Proxy） */
function readKey(record: object, key: string | number): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: (record as Record<string | number, unknown>)[key] };
  } catch {
    return { ok: false };
  }
}

export function formatLogLine(event: string, payload: unknown): string {
  const writer = new LineWriter();
  writer.write(event);
  writer.write(' ');
  writePayload(event, payload, writer);
  return writer.value;
}

function writePayload(event: string, payload: unknown, writer: LineWriter): void {
  const fields = Object.prototype.hasOwnProperty.call(KNOWN_EVENT_FIELDS, event)
    ? KNOWN_EVENT_FIELDS[event]
    : undefined;
  if (!fields || payload === null || typeof payload !== 'object') {
    writeUnknownPayload(payload, writer);
    return;
  }
  const record = payload as Record<string, unknown>;
  writer.write('{');
  let shown = 0;
  for (const field of fields) {
    if (writer.done) break;
    if (shown > 0) writer.write(', ');
    const read = readKey(record, field);
    if (read.ok) {
      writer.write(`${field}: `);
      writeValue(writer, read.value, 0, field);
    } else {
      writer.write(`${field}: [取值失败]`);
    }
    shown++;
  }
  writer.write('}');
}

/** 未知事件：对象一律固定占位，不做通用反射枚举 */
function writeUnknownPayload(payload: unknown, writer: LineWriter): void {
  if (payload === null) {
    writer.write('null');
    return;
  }
  switch (typeof payload) {
    case 'string': {
      if (isBase64Like(payload)) {
        writer.write(`[base64: ${payload.length} 字符]`);
        return;
      }
      writeString(writer, payload);
      return;
    }
    case 'number':
    case 'boolean':
      writer.write(String(payload));
      return;
    case 'undefined':
      writer.write('undefined');
      return;
    case 'bigint':
      writeBigInt(writer, payload);
      return;
    case 'function':
      writer.write('[function]');
      return;
    case 'symbol':
      writeSymbol(writer, payload);
      return;
    default: {
      if (Array.isArray(payload)) {
        writeUnknownArray(writer, payload);
        return;
      }
      if (isError(payload)) {
        writeError(writer, payload as Error);
        return;
      }
      writer.write('[对象]');
    }
  }
}

function writeValue(writer: LineWriter, value: unknown, depth: number, path: string): void {
  if (writer.done) return;
  if (!writer.takeNode()) return;
  if (value === null) {
    writer.write('null');
    return;
  }
  switch (typeof value) {
    case 'string': {
      if (ASSET_CONTENT_KEYS.has(path)) {
        writer.write(`[base64: ${value.length} 字符]`);
        return;
      }
      if (isBase64Like(value)) {
        writer.write(`[base64: ${value.length} 字符]`);
        return;
      }
      writeString(writer, value);
      return;
    }
    case 'number':
    case 'boolean':
      writer.write(String(value));
      return;
    case 'undefined':
      writer.write('undefined');
      return;
    case 'bigint':
      writeBigInt(writer, value);
      return;
    case 'function':
      writer.write('[function]');
      return;
    case 'symbol':
      writeSymbol(writer, value);
      return;
    default: {
      if (ASSET_CONTENT_KEYS.has(path)) {
        writer.write('[数据]');
        return;
      }
      if (isError(value)) {
        writeError(writer, value as Error);
        return;
      }
      if (Array.isArray(value)) {
        if (depth >= SUMMARY_DEPTH_LIMIT) {
          writeUnknownArray(writer, value);
          return;
        }
        writeArray(writer, value, depth);
        return;
      }
      if (depth >= SUMMARY_DEPTH_LIMIT) {
        writer.write('[对象]');
        return;
      }
      writeObject(writer, value, depth);
    }
  }
}

function writeBigInt(writer: LineWriter, value: bigint): void {
  if (value >= -BIGINT_DISPLAY_LIMIT && value <= BIGINT_DISPLAY_LIMIT) {
    writer.write(`${value}n`);
  } else {
    writer.write('[BigInt]');
  }
}

function writeSymbol(writer: LineWriter, symbol: symbol): void {
  let description: string | undefined;
  try {
    description = symbol.description;
  } catch {
    description = undefined;
  }
  if (typeof description !== 'string') {
    writer.write('[Symbol]');
    return;
  }
  writer.write('[Symbol: ');
  writeBoundedText(writer, description, SUMMARY_STRING_LIMIT);
  writer.write(']');
}

/** 未知事件的数组：只报长度，不枚举内容 */
function writeUnknownArray(writer: LineWriter, value: unknown[]): void {
  const length = readLength(value);
  if (length < 0) {
    writer.write('[数组]');
    return;
  }
  writer.write(`[数组×${length}]`);
}

function writeError(writer: LineWriter, error: Error): void {
  let message: string;
  try {
    message = error.message;
  } catch {
    writer.write('[Error]');
    return;
  }
  writer.write('[Error: ');
  writeBoundedText(writer, message, SUMMARY_STRING_LIMIT);
  writer.write(']');
}

function writeString(writer: LineWriter, value: string): void {
  writer.write('"');
  writeBoundedText(writer, value, SUMMARY_STRING_LIMIT);
  writer.write('"');
}

/** 有界文本：先取定长片段（不构造完整文本）再按片段写入 */
function writeBoundedText(writer: LineWriter, text: string, limit: number): void {
  if (text.length <= limit) {
    writer.write(text);
    return;
  }
  writer.write(text.slice(0, limit));
  writer.write(`…(${text.length} 字符)`);
}

function writeArray(writer: LineWriter, value: unknown[], depth: number): void {
  const length = readLength(value);
  if (length < 0) {
    writer.write('[数组]');
    return;
  }
  writer.write('[');
  const shown = Math.min(length, SUMMARY_ITEMS_LIMIT);
  for (let i = 0; i < shown && !writer.done; i++) {
    if (i > 0) writer.write(', ');
    const read = readKey(value, i);
    if (read.ok) {
      writeValue(writer, read.value, depth + 1, '');
    } else {
      writer.write('[取值失败]');
    }
  }
  if (length > shown && !writer.done) writer.write(`, …共 ${length} 项`);
  writer.write(']');
}

/** 自身可枚举键（不含继承键）；只读前 KEY_LIMIT+1 个的展示值，不遍历剩余键 */
function writeObject(writer: LineWriter, record: unknown, depth: number): void {
  let keys: string[];
  try {
    keys = Object.keys(record as object);
  } catch {
    writer.write('[对象]');
    return;
  }
  writer.write('{');
  const shown = Math.min(keys.length, SUMMARY_KEYS_LIMIT);
  for (let i = 0; i < shown && !writer.done; i++) {
    if (i > 0) writer.write(', ');
    const key = keys[i];
    const boundedKey = key.length > SUMMARY_STRING_LIMIT ? `${key.slice(0, SUMMARY_STRING_LIMIT)}…` : key;
    const read = readKey(record as object, key);
    if (read.ok) {
      writer.write(`${boundedKey}: `);
      writeValue(writer, read.value, depth + 1, key);
    } else {
      writer.write(`${boundedKey}: [取值失败]`);
    }
  }
  if (keys.length > shown && !writer.done) writer.write(`, …共 ${keys.length} 个键`);
  writer.write('}');
}

function isError(value: object): boolean {
  try {
    return value instanceof Error;
  } catch {
    return false;
  }
}

function readLength(value: unknown[]): number {
  try {
    return value.length;
  } catch {
    return -1;
  }
}

/** 内容兜底：有界采样前 64 字符，纯 base64 字符集且总长超阈值才掩码 */
function isBase64Like(value: string): boolean {
  if (value.length <= 200) return false;
  return /^[A-Za-z0-9+/]+$/.test(value.slice(0, 64));
}
