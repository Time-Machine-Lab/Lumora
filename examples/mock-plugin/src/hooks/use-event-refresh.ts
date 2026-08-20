import { useEffect, useState } from 'react';
import type { EventMap, PluginEventBus } from '@lumora/plugin-sdk';

/** 订阅事件并触发重渲染；订阅随组件卸载释放 */
export function useEventRefresh(events: PluginEventBus, names: Array<keyof EventMap & string>): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const subscriptions = names.map((name) => events.on(name, () => setTick((tick) => tick + 1)));
    return () => {
      for (const subscription of subscriptions) subscription.dispose();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [events]);
}
