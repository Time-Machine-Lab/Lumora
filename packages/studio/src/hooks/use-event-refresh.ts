import { useEffect, useState } from 'react';
import { TypedEventEmitter } from '@lumora/core';
import type { EventMap } from '@lumora/core';

/**
 * 订阅事件名列表并在事件发生时触发重渲染，
 * 用于让 UI 跟随贡献项/命令/插件状态的变更。
 */
export function useEventRefresh(
  events: TypedEventEmitter<EventMap>,
  names: Array<keyof EventMap & string>,
): void {
  const [, setVersion] = useState(0);
  // 事件名列表由调用方内联构造，这里以 join 结果为依赖，避免每次渲染重复订阅
  const key = names.join(',');
  useEffect(() => {
    const disposables = key
      .split(',')
      .filter(Boolean)
      .map((name) => events.on(name as keyof EventMap & string, () => setVersion((v) => v + 1)));
    return () => disposables.forEach((d) => d.dispose());
  }, [events, key]);
}
