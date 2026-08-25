import { useEffect, useState } from 'react';
import type { Project, SceneEditor, ViewState } from '@lumora/core';

export interface EditorState {
  project: Project | null;
  selection: string[];
  view: ViewState;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

/** 订阅 SceneEditor 事件并镜像为 React 状态；组件卸载时移除订阅 */
export function useSceneEditor(editor: SceneEditor): EditorState {
  const [state, setState] = useState<EditorState>(() => {
    const history = editor.getHistoryState();
    return {
      project: editor.getProject(),
      selection: editor.getSelection(),
      view: editor.getView(),
      canUndo: history.canUndo,
      canRedo: history.canRedo,
      undoLabel: history.undoLabel,
      redoLabel: history.redoLabel,
    };
  });

  useEffect(() => {
    const subs = [
      editor.events.on('project:changed', ({ project, sessionToken }) => {
        if (!editor.isCurrentSession(sessionToken) || project !== editor.getProject()) return;
        setState((s) => ({ ...s, project }));
      }),
      editor.events.on('selection:changed', ({ ids }) => setState((s) => ({ ...s, selection: ids }))),
      editor.events.on('view:changed', ({ view }) => setState((s) => ({ ...s, view }))),
      editor.events.on('history:changed', (h) =>
        setState((s) => ({
          ...s,
          canUndo: h.canUndo,
          canRedo: h.canRedo,
          undoLabel: h.undoLabel,
          redoLabel: h.redoLabel,
        })),
      ),
    ];
    return () => {
      for (const sub of subs) sub.dispose();
    };
  }, [editor]);

  return state;
}
