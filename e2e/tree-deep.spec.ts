import { expect, test } from '@playwright/test';

/**
 * R6-D 真实深层 UI（TML-57 第六轮复审）：
 * - 121 节点深树（链深 8 + 每层 14 兄弟）全部渲染、键盘可完整遍历；
 * - 行内重命名期间 treeitem 移出 Tab 顺序，Tab 离开树（APG）；
 * - 「移动到」：M 键与行内按钮（触屏等价）打开目标菜单，候选排除自身与
 *   后代，选择即挂载。
 */

const TOTAL_ROWS = 8 * 15 + 1; // 8 组 + 8×14 叶 + 摄像机

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  // 注入确定性深树项目（与 AC4 相同的宿主重开通道）
  await page.evaluate(() => {
    const objects: {
      id: string;
      type: string;
      name: string;
      parentId: string | null;
      transform: { position: number[]; rotation: number[]; scale: number[] };
      visible: boolean;
      locked: boolean;
    }[] = [];
    for (let i = 0; i < 8; i += 1) {
      objects.push({
        id: `d${i}`,
        type: 'group',
        name: `深组${i}`,
        parentId: i === 0 ? null : `d${i - 1}`,
        transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
        visible: true,
        locked: false,
      });
      for (let j = 0; j < 14; j += 1) {
        objects.push({
          id: `d${i}-l${j}`,
          type: 'group',
          name: `叶${i}-${j}`,
          parentId: `d${i}`,
          transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
          visible: true,
          locked: false,
        });
      }
    }
    objects.push({
      id: 'cam',
      type: 'camera',
      name: '摄像机',
      parentId: null,
      transform: { position: [0, 2, 7], rotation: [0, 0, 0], scale: [1, 1, 1] },
      visible: true,
      locked: false,
      camera: { projection: 'perspective', focalLength: 50, fov: 45, sensorWidth: 36, sensorHeight: 24, near: 0.1, far: 200, aspect: null },
    });
    const project = {
      uri: 'lumora://deep-tree',
      name: '深树',
      schemaVersion: 2,
      createdAt: new Date().toISOString(),
      revision: 0,
      settings: { fps: 24, aspect: [16, 9] },
      activeSceneId: 's1',
      scenes: [{ id: 's1', name: '主场景', rootObjectIds: ['d0', 'cam'], activeCameraId: 'cam' }],
      objects,
      assets: [],
    };
    localStorage.setItem('lumora.demo.last-export', JSON.stringify(project));
  });
  await page.reload();
  await page.getByTestId('reopen-last-export').click();
});

test('R6 深层树：121 节点真实渲染、键盘遍历到底、行内重命名移出 Tab 顺序、移动到菜单', async ({ page }) => {
  // 真实深层 UI：最深行可见，全部行渲染
  await expect(page.getByTestId('tree-row-d7-l13')).toBeVisible();
  await expect(page.locator('.lumora-tree-row')).toHaveCount(TOTAL_ROWS);

  // 键盘遍历：从根一路 ArrowDown 走到底（d7-l13 是倒数第二行，其下只有摄像机）
  await page.getByTestId('tree-row-d0').focus();
  for (let i = 0; i < TOTAL_ROWS - 2; i += 1) {
    await page.keyboard.press('ArrowDown');
  }
  await expect(page.getByTestId('tree-row-d7-l13')).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByTestId('tree-row-d7-l13')).toBeFocused();

  // 行内重命名：treeitem 移出 Tab 顺序（APG）——Tab 离开树而非跳到下一行
  // 注意：li 包围整个子树，点中心会落在后代行上；固定点命中行自身（x≈行内容区），
  // 再显式 focus 行（选择由 onClick 驱动，焦点不随点击自动转移）
  await page.getByTestId('tree-row-d0').click({ position: { x: 90, y: 6 } });
  await page.getByTestId('tree-row-d0').focus();
  await page.keyboard.press('F2');
  const rename = page.getByTestId('tree-rename-d0');
  await expect(rename).toBeFocused();
  await expect(page.getByTestId('tree-row-d0')).toHaveAttribute('tabindex', '-1');
  await page.keyboard.press('Tab');
  expect(
    await page.evaluate(() => document.activeElement?.getAttribute('role')),
  ).not.toBe('treeitem');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('tree-row-d0')).toHaveAttribute('tabindex', '0');

  // 移动到（键盘）：M 打开目标菜单，候选排除自身与后代，选择即挂载
  await page.getByTestId('tree-row-d1').focus();
  await page.keyboard.press('m');
  await expect(page.getByTestId('tree-move-menu')).toBeVisible();
  await expect(page.getByTestId('tree-move-to-d0')).toBeVisible();
  await expect(page.getByTestId('tree-move-to-root')).toBeVisible();
  // 后代（d2 及以下）与自身不得作为目标
  await expect(page.getByTestId('tree-move-to-d1')).toHaveCount(0);
  await expect(page.getByTestId('tree-move-to-d2')).toHaveCount(0);
  await page.getByTestId('tree-move-to-root').click();
  await expect(page.getByTestId('tree-move-menu')).toHaveCount(0);
  // d1 提为根：从树根容器直接可见（不再嵌套在 d0 之下）
  await expect(page.locator('.lumora-tree__list > [data-testid="tree-row-d1"]')).toHaveCount(1);

  // 移动到（触屏等价路径）：行内「移动」按钮 → 菜单 → 子树整体随迁
  // 先把 d1 挂回 d0 下（复原链），再整棵 d0 子树挂到摄像机
  await page.getByTestId('tree-move-d1').click();
  await expect(page.getByTestId('tree-move-menu')).toBeVisible();
  await page.getByTestId('tree-move-to-d0').click();
  await expect(page.locator('[data-testid="tree-row-d0"] [data-testid="tree-row-d1"]')).toBeVisible();

  await page.getByTestId('tree-move-d0').click();
  await expect(page.getByTestId('tree-move-menu')).toBeVisible();
  await expect(page.getByTestId('tree-move-to-cam')).toBeVisible();
  // 后代（d1 已复原为 d0 子级）不得作为目标
  await expect(page.getByTestId('tree-move-to-d1')).toHaveCount(0);
  await page.getByTestId('tree-move-to-cam').click();
  await expect(page.locator('[data-testid="tree-row-cam"] [data-testid="tree-row-d0"]')).toBeVisible();
  // d0 子树（含 d1 与更深层）整体随迁
  await expect(page.locator('[data-testid="tree-row-d0"] [data-testid="tree-row-d1"]')).toBeVisible();
  await expect(page.locator('[data-testid="tree-row-d1"] [data-testid="tree-row-d2"]')).toBeVisible();
});
