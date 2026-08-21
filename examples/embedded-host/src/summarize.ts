/**
 * 事件日志行摘要（TML-87）：事件名与 payload 共享同一字符/节点预算，
 * 产出恒 <= SUMMARY_CHAR_BUDGET 的单行文本，且摘要本身不抛错。
 *
 * - 已知事件按声明字段逐字段摘要；未知事件/未知对象一律固定占位，不做任何反射枚举
 * - 嵌套对象仅按 path/schema 级字段白名单展开（白名单外对象固定 [对象]，
 *   数组只报长度或展开白名单项），不调用 Object.keys，工作量与对象宽度无关
 * - 每个声明字段读取前先做可捕获异常的 own-property 检查，缺失/失败跳过或占位
 * - 事件名或分隔符耗尽预算后立即返回，不再触碰 event/payload；
 *   剩余内容容量（不含省略号预留位）归零时同样立即截断
 * - 截断时恒以 … 结尾：每次写入前先为省略号预留 1 字符，
 *   转义收缩按未转义片段边界进行，不会切断转义序列
 * - Error 判定为有界检查（至多两次 Object.getPrototypeOf + 原型身份比较，
 *   循环 getPrototypeOf Proxy 至多触发 2 次 trap），且仅在已知 error 字段路径执行
 * - 所有文本（字符串、Error.message、Symbol 描述、事件名）统一转义
 *   \r \n U+2028 U+2029 后再进入预算；所有动态字符串统一经同一
 *   base64 判定入口进入文本写入
 * - base64 资产内容按路径（payload 字段）直接掩码；内容启发式仅兜底且有界采样
 * - getter/Proxy/revoked Proxy/异常形状一律容错（safeIsArray、readLength 校验、
 *   Error.message 类型校验），摘要永不抛错
 */

export const SUMMARY_CHAR_BUDGET = 4096;

const SUMMARY_STRING_LIMIT = 120;
const SUMMARY_ITEMS_LIMIT = 8;
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

/** 嵌套对象的 path/schema 级字段白名单：白名单外的对象固定 [对象]，不做通用键枚举 */
const KNOWN_OBJECT_FIELDS: Readonly<Record<string, readonly string[]>> = {
  project: ['name', 'revision', 'assets'],
  asset: ['id', 'kind', 'name', 'size', 'payload'],
};

/** 数组项 schema：父字段名 -> 项字段白名单键 */
const KNOWN_ARRAY_ITEM_FIELDS: Readonly<Record<string, string>> = {
  assets: 'asset',
};

/** 资产内容字段名：按路径直接掩码，不读内容 */
const ASSET_CONTENT_KEYS = new Set(['payload']);

/** BigInt 分级占位：安全整数范围内显示数值，超出退化为固定占位（避免无界十进制转换） */
const BIGINT_DISPLAY_LIMIT = 1_000_000_000_000_000_000n;

/** \r \n U+2028 U+2029 统一转义；用 fromCharCode 构造字符类，源码不含不可见行分隔符 */
const CONTROL_RE = new RegExp(`[\r\n${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`, 'g');

function escapeControl(text: string): string {
  return text.replace(CONTROL_RE, (ch) =>
    ch === '\r' ? '\\r' : ch === '\n' ? '\\n' : ch === String.fromCharCode(0x2028) ? '\\u2028' : '\\u2029',
  );
}

class LineWriter {
  private readonly parts: string[] = [];
  /** 与 parts 平行的未转义片段：截断回收时按原始边界裁剪，不切断转义序列 */
  private readonly raws: string[] = [];
  private chars = SUMMARY_CHAR_BUDGET;
  private nodes = SUMMARY_NODE_BUDGET;
  private doneFlag = false;

  get done(): boolean {
    return this.doneFlag;
  }

  /** 剩余内容容量（不含省略号预留位）：为 0 时已无任何内容空间，仅剩省略号 */
  remainingContent(): number {
    return this.chars - ELLIPSIS.length;
  }

  /**
   * 写入文本：只对实际输出的片段转义并消费预算。
   * 先为省略号预留 1 字符（room = chars - 1），保证未终止时恒有 chars >= 1，
   * 截断时总有空间补 …；转义放大长度时按超额量收缩原始片段，不切断转义序列。
   */
  write(text: string): void {
    if (this.doneFlag) return;
    const room = this.chars - ELLIPSIS.length;
    let raw = text.length > room ? text.slice(0, Math.max(0, room)) : text;
    let safe = escapeControl(raw);
    while (safe.length > room && raw.length > 0) {
      // 转义会放大长度：按超额量收缩原始片段，保证不切断转义序列
      raw = raw.slice(0, Math.max(0, raw.length - (safe.length - room)));
      safe = escapeControl(raw);
    }
    this.chars -= safe.length;
    this.parts.push(safe);
    this.raws.push(raw);
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

  /**
   * 截断并终止：末尾恒补 …。
   * 预留不变量下 chars >= 1（need <= 0）必然成立，回收分支仅为兜底：
   * 若未来写入路径破坏预留，则按最后未转义片段的完整边界回收字符，
   * 一次回收可能释放整个转义单元。
   */
  truncate(): void {
    if (this.doneFlag) return;
    this.doneFlag = true;
    let need = ELLIPSIS.length - this.chars;
    while (need > 0 && this.raws.length > 0) {
      const raw = this.raws[this.raws.length - 1] ?? '';
      const take = Math.min(need, raw.length);
      const newRaw = raw.slice(0, raw.length - take);
      this.chars += escapeControl(raw).length - escapeControl(newRaw).length;
      need = ELLIPSIS.length - this.chars;
      if (newRaw.length > 0) {
        this.raws[this.raws.length - 1] = newRaw;
        this.parts[this.parts.length - 1] = escapeControl(newRaw);
      } else {
        this.raws.pop();
        this.parts.pop();
      }
    }
    if (need <= 0) {
      this.parts.push(ELLIPSIS);
      this.raws.push(ELLIPSIS);
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

/** 可捕获异常的 own-property 检查；检查失败视为缺失（不触发继承 getter） */
function hasOwnKey(record: object, field: string): boolean {
  try {
    return Object.prototype.hasOwnProperty.call(record, field);
  } catch {
    return false;
  }
}

/** Array.isArray 在 revoked Proxy 上抛 TypeError，需容错 */
function safeIsArray(value: unknown): value is unknown[] {
  try {
    return Array.isArray(value);
  } catch {
    return false;
  }
}

/** 数组长度只接受有限非负整数；读取失败或形状异常返回 -1 */
function readLength(value: unknown[]): number {
  let length: unknown;
  try {
    length = value.length;
  } catch {
    return -1;
  }
  return typeof length === 'number' && Number.isInteger(length) && length >= 0 ? length : -1;
}

/**
 * 有界 Error 判定：只沿原型链检查至多两层（value 的原型与其原型），
 * 命中 Error 及其标准子类原型即视为 Error。instanceof 会遍历整条原型链
 * 直至 null（循环 getPrototypeOf Proxy 可触发海量 trap），本检查在
 * 循环 Proxy 上至多触发 2 次 trap；revoked Proxy 抛错被捕获。
 */
function isError(value: object): boolean {
  try {
    const proto = Object.getPrototypeOf(value);
    if (proto === null) return false;
    if (isErrorPrototype(proto)) return true;
    const parent = Object.getPrototypeOf(proto);
    return parent !== null && isErrorPrototype(parent);
  } catch {
    return false;
  }
}

/** Error 及其标准子类的原型（身份比较，无属性访问、无 trap） */
function isErrorPrototype(proto: object): boolean {
  return (
    proto === Error.prototype ||
    proto === TypeError.prototype ||
    proto === RangeError.prototype ||
    proto === SyntaxError.prototype ||
    proto === ReferenceError.prototype ||
    proto === EvalError.prototype ||
    proto === URIError.prototype ||
    proto === AggregateError.prototype
  );
}

export function formatLogLine(event: string, payload: unknown): string {
  const writer = new LineWriter();
  writer.write(event);
  writer.write(' ');
  // 事件名或分隔符耗尽预算（含仅余省略号预留位）：立即截断并返回，不再触碰 event/payload
  if (writer.done || writer.remainingContent() <= 0) {
    writer.truncate();
    return writer.value;
  }
  writePayload(event, payload, writer);
  return writer.value;
}

function writePayload(event: string, payload: unknown, writer: LineWriter): void {
  if (writer.done) return;
  if (writer.remainingContent() <= 0) {
    writer.truncate();
    return;
  }
  const fields = hasOwnKey(KNOWN_EVENT_FIELDS as object, event) ? KNOWN_EVENT_FIELDS[event] : undefined;
  if (!fields || payload === null || typeof payload !== 'object') {
    writeUnknownPayload(payload, writer);
    return;
  }
  const record = payload as object;
  writer.write('{');
  let shown = 0;
  for (const field of fields) {
    if (writer.done) break;
    // 每个声明字段先 own-property 检查：缺失（含检查失败）跳过，不触碰继承属性
    if (!hasOwnKey(record, field)) continue;
    if (shown > 0) writer.write(', ');
    const read = readKey(record, field);
    if (read.ok) {
      writer.write(`${field}: `);
      writeValue(writer, read.value, field);
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
      if (safeIsArray(payload)) {
        writeUnknownArray(writer, payload);
        return;
      }
      // Error 判定仅在已知 error 字段路径执行；未知对象固定 [对象]，零 trap 访问
      writer.write('[对象]');
    }
  }
}

function writeValue(writer: LineWriter, value: unknown, path: string): void {
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
      // Error 判定只在已知 error 字段路径执行；其余任意对象不再被检查，零 trap 访问
      if (path === 'error' && isError(value)) {
        writeError(writer, value as Error);
        return;
      }
      if (safeIsArray(value)) {
        writeArray(writer, value, path);
        return;
      }
      const fields = hasOwnKey(KNOWN_OBJECT_FIELDS as object, path) ? KNOWN_OBJECT_FIELDS[path] : undefined;
      if (!fields) {
        writer.write('[对象]');
        return;
      }
      writeObjectFields(writer, value as object, fields);
    }
  }
}

/** 白名单对象：只读声明字段（每字段先 own-property 检查），不做键枚举 */
function writeObjectFields(writer: LineWriter, record: object, fields: readonly string[]): void {
  writer.write('{');
  let shown = 0;
  for (const field of fields) {
    if (writer.done) break;
    if (!hasOwnKey(record, field)) continue;
    if (shown > 0) writer.write(', ');
    const read = readKey(record, field);
    if (read.ok) {
      writer.write(`${field}: `);
      writeValue(writer, read.value, field);
    } else {
      writer.write(`${field}: [取值失败]`);
    }
    shown++;
  }
  writer.write('}');
}

/** 数组：白名单数组展开前 8 项，溢出仅标 …；无白名单的数组只报长度 */
function writeArray(writer: LineWriter, value: unknown[], path: string): void {
  const length = readLength(value);
  if (length < 0) {
    writer.write('[数组]');
    return;
  }
  const itemKey = hasOwnKey(KNOWN_ARRAY_ITEM_FIELDS as object, path) ? KNOWN_ARRAY_ITEM_FIELDS[path] : undefined;
  if (!itemKey) {
    writer.write(`[数组×${length}]`);
    return;
  }
  writer.write('[');
  const shown = length > SUMMARY_ITEMS_LIMIT ? SUMMARY_ITEMS_LIMIT : length;
  for (let i = 0; i < shown && !writer.done; i++) {
    if (i > 0) writer.write(', ');
    const read = readKey(value, i);
    if (read.ok) {
      writeValue(writer, read.value, itemKey);
    } else {
      writer.write('[取值失败]');
    }
  }
  if (length > shown && !writer.done) writer.write(', …');
  writer.write(']');
}

/** 未知数组：只报长度（经有限非负整数校验），不枚举内容 */
function writeUnknownArray(writer: LineWriter, value: unknown[]): void {
  const length = readLength(value);
  if (length < 0) {
    writer.write('[数组]');
    return;
  }
  writer.write(`[数组×${length}]`);
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
  writeTextContent(writer, description);
  writer.write(']');
}

function writeError(writer: LineWriter, error: Error): void {
  let message: unknown;
  try {
    message = error.message;
  } catch {
    writer.write('[Error]');
    return;
  }
  if (typeof message !== 'string') {
    writer.write('[Error]');
    return;
  }
  writer.write('[Error: ');
  writeTextContent(writer, message);
  writer.write(']');
}

function writeString(writer: LineWriter, value: string): void {
  writer.write('"');
  writeTextContent(writer, value);
  writer.write('"');
}

/**
 * 统一动态文本入口：字符串、Error.message、Symbol 描述共用同一
 * 有界 base64 判定 + 有界文本写入，不再有绕过掩码的路径。
 */
function writeTextContent(writer: LineWriter, text: string): void {
  if (isBase64Like(text)) {
    writer.write(`[base64: ${text.length} 字符]`);
    return;
  }
  writeBoundedText(writer, text, SUMMARY_STRING_LIMIT);
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

/** 内容兜底：有界采样前 64 字符，纯 base64 字符集且总长超阈值才掩码 */
function isBase64Like(value: string): boolean {
  if (value.length <= 200) return false;
  return /^[A-Za-z0-9+/]+$/.test(value.slice(0, 64));
}
