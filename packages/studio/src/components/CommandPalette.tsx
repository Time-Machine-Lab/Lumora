import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { Command } from '@lumora/core';
import type { StudioRuntime } from '../runtime/studio-runtime';
import { useEventRefresh } from '../hooks/use-event-refresh';
import { ModalDialog } from './ModalDialog';

interface CommandPaletteProps {
  runtime: StudioRuntime;
  onClose: () => void;
  returnFocusRef?: RefObject<HTMLElement | null>;
}

export function CommandPalette({ runtime, onClose, returnFocusRef }: CommandPaletteProps) {
  const titleId = useId();
  const inputId = useId();
  useEventRefresh(runtime.events, ['command:changed']);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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
    <ModalDialog
      dialogClassName="lumora-palette"
      dialogTestId="command-palette"
      ariaLabelledBy={titleId}
      initialFocusRef={inputRef}
      returnFocusRef={returnFocusRef}
      onClose={onClose}
      onDialogKeyDown={(event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault();
          onClose();
        }
      }}
    >
        <header className="lumora-palette__header">
          <h2 id={titleId}>命令面板</h2>
          <label htmlFor={inputId}>搜索命令</label>
        </header>
        <input
          id={inputId}
          ref={inputRef}
          className="lumora-palette__input"
          placeholder="输入命令名称或 id…"
          value={query}
          data-testid="command-palette-input"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && commands[0]) {
              event.preventDefault();
              run(commands[0]);
            }
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
    </ModalDialog>
  );
}
