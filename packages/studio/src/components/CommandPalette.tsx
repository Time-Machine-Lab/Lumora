import { useEffect, useRef, useState } from 'react';
import type { Command } from '@lumora/core';
import type { StudioRuntime } from '../runtime/studio-runtime';
import { useEventRefresh } from '../hooks/use-event-refresh';

interface CommandPaletteProps {
  runtime: StudioRuntime;
  onClose: () => void;
}

export function CommandPalette({ runtime, onClose }: CommandPaletteProps) {
  useEventRefresh(runtime.events, ['command:changed']);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // 每次渲染直接读取注册表：命令注册/注销（command:changed）触发的重渲染必须反映最新列表，
  // 不能依赖 useMemo —— 其依赖在事件触发时不会变化。
  // when() 由 CommandRegistry 统一构造命令所属插件的上下文（pluginId/services 与 execute 一致）
  const keyword = query.trim().toLowerCase();
  const commands = runtime.host.commands
    .list()
    .filter((command) => runtime.host.commands.isAvailable(command))
    .filter(
      (command) =>
        keyword === '' ||
        command.title.toLowerCase().includes(keyword) ||
        command.id.toLowerCase().includes(keyword),
    );

  const run = (command: Command) => {
    onClose();
    void runtime.host.commands.execute(command.id);
  };

  return (
    <div className="lumora-modal-backdrop" onClick={onClose}>
      <div
        className="lumora-palette"
        data-testid="command-palette"
        role="dialog"
        aria-label="命令面板"
        onClick={(event) => event.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="lumora-palette__input"
          placeholder="输入命令名称或 id…"
          value={query}
          data-testid="command-palette-input"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && commands[0]) run(commands[0]);
          }}
        />
        <ul className="lumora-palette__list">
          {commands.length === 0 && <li className="lumora-palette__empty">没有匹配的命令</li>}
          {commands.map((command) => (
            <li key={command.id}>
              <button
                type="button"
                className="lumora-palette__item"
                data-testid={`palette-command-${command.id}`}
                onClick={() => run(command)}
              >
                <span className="lumora-palette__title">{command.title}</span>
                <code className="lumora-palette__id">{command.id}</code>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
