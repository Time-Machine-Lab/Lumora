import '@testing-library/jest-dom/vitest';
// jsdom 不提供 IndexedDB：测试环境注入 fake-indexeddb 以便 ProjectStore 单测
import 'fake-indexeddb/auto';

// jsdom 25 未实现 PointerEvent：testing-library 会静默回退为普通 Event，
// 丢 clientX/clientY —— 注入最小 polyfill（继承 MouseEvent，补齐指针字段）
if (typeof window !== 'undefined' && typeof window.PointerEvent === 'undefined') {
  class PointerEventPolyfill extends window.MouseEvent {
    pointerId: number;
    width: number;
    height: number;
    pressure: number;
    tangentialPressure: number;
    tiltX: number;
    tiltY: number;
    twist: number;
    pointerType: string;
    isPrimary: boolean;

    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
      this.width = init.width ?? 1;
      this.height = init.height ?? 1;
      this.pressure = init.pressure ?? 0;
      this.tangentialPressure = init.tangentialPressure ?? 0;
      this.tiltX = init.tiltX ?? 0;
      this.tiltY = init.tiltY ?? 0;
      this.twist = init.twist ?? 0;
      this.pointerType = init.pointerType ?? 'mouse';
      this.isPrimary = init.isPrimary ?? false;
    }
  }
  window.PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent;
  (globalThis as Record<string, unknown>).PointerEvent = PointerEventPolyfill;
}
