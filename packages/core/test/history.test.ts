import { describe, expect, it } from 'vitest';
import { HistoryStack } from '../src/history/history';

describe('HistoryStack', () => {
  it('push 后 undo 返回 before、redo 返回 after，可反复往返', () => {
    const stack = new HistoryStack<number>();
    stack.push({ label: 'a', before: 1, after: 2 });
    expect(stack.canUndo).toBe(true);
    expect(stack.canRedo).toBe(false);
    expect(stack.undoLabel).toBe('a');
    expect(stack.undo()).toBe(1);
    expect(stack.canUndo).toBe(false);
    expect(stack.canRedo).toBe(true);
    expect(stack.redoLabel).toBe('a');
    expect(stack.redo()).toBe(2);
  });

  it('undo 后 push 截断重做尾', () => {
    const stack = new HistoryStack<number>();
    stack.push({ label: 'a', before: 1, after: 2 });
    stack.push({ label: 'b', before: 2, after: 3 });
    stack.undo();
    stack.undo();
    stack.push({ label: 'c', before: 1, after: 9 });
    expect(stack.redo()).toBeNull();
    expect(stack.undo()).toBe(1);
    expect(stack.redo()).toBe(9);
  });

  it('超过最大深度时丢弃最旧一步', () => {
    const stack = new HistoryStack<number>(2);
    stack.push({ label: 'a', before: 0, after: 1 });
    stack.push({ label: 'b', before: 1, after: 2 });
    stack.push({ label: 'c', before: 2, after: 3 });
    expect(stack.size).toBe(2);
    expect(stack.undo()).toBe(2);
    expect(stack.undo()).toBe(1);
    expect(stack.undo()).toBeNull();
  });

  it('空栈 undo/redo 返回 null，clear 清空', () => {
    const stack = new HistoryStack<number>();
    expect(stack.undo()).toBeNull();
    expect(stack.redo()).toBeNull();
    stack.push({ label: 'a', before: 0, after: 1 });
    stack.clear();
    expect(stack.canUndo).toBe(false);
    expect(stack.size).toBe(0);
  });

  it('标签随指针移动（undo 后显示最近可撤销项的标签）', () => {
    const stack = new HistoryStack<number>();
    stack.push({ label: '移动立方体', before: 0, after: 1 });
    stack.push({ label: '旋转球体', before: 1, after: 2 });
    expect(stack.undoLabel).toBe('旋转球体');
    stack.undo();
    expect(stack.undoLabel).toBe('移动立方体');
    expect(stack.redoLabel).toBe('旋转球体');
  });
});
