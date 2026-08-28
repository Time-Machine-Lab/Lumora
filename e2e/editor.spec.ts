import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Download, Page } from '@playwright/test';
import { decodePng, pngPixel, scanFrameBounds } from './helpers/png';
import { MINIMAL_GLB } from './helpers/glb';

/** 真实 GLB 夹具：嵌套节点 + 共享材质（CarRoot → BodyMesh + 4×WheelMesh，BIN chunk） */
const FIXTURE_GLB = fileURLToPath(new URL('../packages/studio/test/fixtures/nested-mesh.glb', import.meta.url));

async function readDownload(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** 隐藏视口上的 DOM 覆盖层（工具条/辅助线），让 canvas 截图只含 WebGL 像素 */
async function hideOverlays(page: import('@playwright/test').Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((el) => {
    (el as HTMLElement).style.display = 'none';
  });
}

async function showOverlays(page: import('@playwright/test').Page, selector: string): Promise<void> {
  await page.locator(selector).evaluate((el) => {
    (el as HTMLElement).style.display = '';
  });
}

async function countGizmoPixels(page: Page): Promise<number> {
  const png = decodePng(await page.locator('.lumora-viewport canvas').screenshot());
  let count = 0;
  for (let y = 0; y < png.height; y += 2) {
    for (let x = 0; x < png.width; x += 2) {
      const [r, g, b] = pngPixel(png, x, y);
      if ((r > 230 && g < 50 && b < 50) || (b > 230 && r < 50 && g < 50)) count += 1;
    }
  }
  return count;
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-group')).toBeVisible();
});

async function moveReactRootIntoOpenShadowRoot(page: Page): Promise<void> {
  await page.evaluate(() => {
    const reactRoot = document.getElementById('root');
    if (!reactRoot) throw new Error('React root is missing');
    const host = document.createElement('div');
    host.dataset.testid = 'e2e-shadow-host';
    document.body.append(host);
    host.attachShadow({ mode: 'open' }).append(reactRoot);
  });
}

for (const rootMode of ['light DOM', 'open ShadowRoot'] as const) {
  test(`button Escape clears selection in ${rootMode}`, async ({ page }) => {
    if (rootMode === 'open ShadowRoot') await moveReactRootIntoOpenShadowRoot(page);
    await centerCubeAndScale(page);
    await expect(page.locator('.lumora-tree-row--selected')).toHaveCount(1);
    await expect.poll(() => countGizmoPixels(page)).toBeGreaterThan(0);
    const button = page.getByTestId('timeline-play');
    await button.focus();

    await button.press('Escape');

    await expect(page.locator('.lumora-tree-row--selected')).toHaveCount(0);
    await expect(page.getByTestId('inspector-empty')).toHaveText('未选择对象');
    await expect.poll(() => countGizmoPixels(page)).toBe(0);
  });

  test(`contenteditable nested button preserves Escape editing semantics in ${rootMode}`, async ({ page }) => {
    if (rootMode === 'open ShadowRoot') await moveReactRootIntoOpenShadowRoot(page);
    await centerCubeAndScale(page);
    await expect(page.locator('.lumora-tree-row--selected')).toHaveCount(1);
    await expect.poll(() => countGizmoPixels(page)).toBeGreaterThan(0);
    await page.getByTestId('lumora-studio').evaluate((studio) => {
      const editable = document.createElement('div');
      editable.contentEditable = 'true';
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.testid = 'editable-nested-button';
      button.textContent = 'Editable action';
      editable.append(button);
      studio.append(editable);
    });
    const button = page.getByTestId('editable-nested-button');
    await button.focus();

    await button.press('Escape');

    await expect(page.locator('.lumora-tree-row--selected')).toHaveCount(1);
    await expect(page.getByTestId('inspector-name')).toHaveValue('立方体');
    await expect.poll(() => countGizmoPixels(page)).toBeGreaterThan(0);
  });
}

test('command palette consumes one Escape without clearing selection or gizmo', async ({ page }) => {
  await expect(page.getByTestId('panel-tab-com.lumora.mock.panel.console')).toBeVisible();
  await centerCubeAndScale(page);
  await expect(page.locator('.lumora-tree-row--selected')).toHaveCount(1);
  await expect(page.getByTestId('inspector-name')).toHaveValue('立方体');
  await expect.poll(() => countGizmoPixels(page)).toBeGreaterThan(0);
  await page.keyboard.press('Control+k');
  const command = page.getByTestId('palette-command-com.lumora.mock.exportScene');
  await command.focus();

  await command.press('Escape');

  await expect(page.getByTestId('command-palette')).not.toBeVisible();
  await expect(page.locator('.lumora-tree-row--selected')).toHaveCount(1);
  await expect(page.getByTestId('inspector-name')).toHaveValue('立方体');
  await expect.poll(() => countGizmoPixels(page)).toBeGreaterThan(0);
});

test('对象树选择联动属性面板；数值变换提交后数据与撤销恢复一致（AC1）', async ({ page }) => {
  await page.getByTestId('tree-row-sample-cube').click();
  await expect(page.getByTestId('inspector-name')).toHaveValue('立方体');
  await expect(page.getByTestId('inspector-axis-0')).toHaveValue('-2.5');

  // 位置 X 输入 3.25 → 提交；输入框显示提交后的值
  await page.getByTestId('inspector-axis-0').fill('3.25');
  await page.getByTestId('inspector-axis-0').press('Enter');
  await expect(page.getByTestId('inspector-axis-0')).toHaveValue('3.25');

  // 重新选择后数值保持（与项目数据一致）
  await page.getByTestId('tree-row-sample-ground').click();
  await page.getByTestId('tree-row-sample-cube').click();
  await expect(page.getByTestId('inspector-axis-0')).toHaveValue('3.25');

  // 一次撤销回到 -2.5（一步历史，AC3）
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('inspector-axis-0')).toHaveValue('-2.5');
});

test('锁定对象：变换/删除被拒绝且数据不变（AC2）', async ({ page }) => {
  await page.getByTestId('tree-lock-sample-light').click();

  // 锁定后属性面板数值输入被拒绝
  await page.getByTestId('tree-row-sample-light').click();
  await page.getByTestId('inspector-axis-0').fill('5');
  await page.getByTestId('inspector-axis-0').press('Enter');
  await expect(page.getByTestId('lumora-toasts')).toContainText('已锁定');
  await expect(page.getByTestId('inspector-axis-0')).toHaveValue('4');

  // 两步删除被拒绝，行仍存在
  await page.getByTestId('tree-delete-sample-light').click();
  await page.getByTestId('tree-delete-sample-light').click();
  await expect(page.getByTestId('lumora-toasts')).toContainText('锁定');
  await expect(page.getByTestId('tree-row-sample-light')).toBeVisible();

  // 解锁后可删除（数据未坏）
  await page.getByTestId('tree-lock-sample-light').click();
  await page.getByTestId('tree-delete-sample-light').click();
  await page.getByTestId('tree-delete-sample-light').click();
  await expect(page.getByTestId('tree-row-sample-light')).not.toBeVisible();
});

test('撤销/重做：添加对象一次撤销移除、重做恢复（AC3）', async ({ page }) => {
  const before = await page.locator('.lumora-tree-row').count();
  await expect(page.getByTestId('undo')).toBeDisabled(); // 无历史：按钮禁用

  await page.getByTestId('add-object').click();
  await page.getByTestId('add-立方体').click();
  await expect(page.locator('.lumora-tree-row')).toHaveCount(before + 1);
  await expect(page.getByTestId('undo')).toBeEnabled();

  await page.getByTestId('undo').click();
  await expect(page.locator('.lumora-tree-row')).toHaveCount(before);
  await page.getByTestId('redo').click();
  await expect(page.locator('.lumora-tree-row')).toHaveCount(before + 1);
});

test('相机视图：16:9 画幅辅助线矩形，辅助线为 DOM 覆盖层（AC4）', async ({ page }) => {
  // 默认 50mm 焦距（示例摄像机）
  await page.getByTestId('tree-row-sample-camera').click();
  await expect(page.getByTestId('inspector-focal-length')).toHaveValue('50');

  await page.getByTestId('view-mode-select').selectOption('sample-camera');
  const guides = page.getByTestId('lumora-guides');
  await expect(guides).toBeVisible();

  // 画幅矩形保持项目 16:9
  const box = (await guides.boundingBox())!;
  expect(box.width / box.height).toBeCloseTo(16 / 9, 2);

  // 辅助线是视口容器下的 DOM 覆盖层（R3F canvas 位于其包裹层内，永不进入截图画布）
  await expect(page.locator('.lumora-viewport > .lumora-guides')).toHaveCount(1);

  // 三分线/安全框开关影响覆盖层内容
  await expect(guides.locator('svg line')).toHaveCount(4);
  await page.getByLabel('三分线').uncheck();
  await expect(guides.locator('svg line')).toHaveCount(0);
  await page.getByLabel('安全框').uncheck();
  await expect(guides.locator('svg rect')).toHaveCount(0);
});

test('GLB 导入：解析挂载成功，同内容重复导入去重（FR-003）', async ({ page }) => {
  const file = { name: 'hero.glb', mimeType: 'model/gltf-binary', buffer: MINIMAL_GLB };
  await page.getByTestId('toolbar-model-file-input').setInputFiles(file);
  await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');
  await expect(page.locator('.lumora-tree-row', { hasText: 'hero' })).toBeVisible();

  // 模型对象可选中，属性面板显示资源名
  await page.locator('.lumora-tree-row', { hasText: 'hero' }).click();
  await expect(page.getByTestId('inspector-model')).toContainText('hero.glb');

  // 相同内容再次导入：资源去重提示，新增一个对象但资源不重复
  await page.getByTestId('toolbar-model-file-input').setInputFiles(file);
  await expect(page.getByTestId('lumora-toasts')).toContainText('资源已复用');
  await expect(page.locator('.lumora-tree-row', { hasText: 'hero' })).toHaveCount(2);

  // P0-1：导出验证两个模型统一引用同一资源（去重规范化，无视第二次导入携带的 assetId）
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const exported = JSON.parse(await readDownload(await downloadPromise));
  const models = exported.objects.filter((o: { type: string }) => o.type === 'model');
  expect(models).toHaveLength(2);
  expect(exported.assets).toHaveLength(1);
  expect(models[0].assetId).toBe(exported.assets[0].id);
  expect(models[1].assetId).toBe(exported.assets[0].id);
});

test('GLB 导入解析失败：提示错误，不产生对象', async ({ page }) => {
  await page.getByTestId('toolbar-model-file-input').setInputFiles({
    name: 'broken.glb',
    mimeType: 'model/gltf-binary',
    buffer: Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]),
  });
  await expect(page.getByTestId('lumora-toasts')).toContainText('模型解析失败');
  await expect(page.locator('.lumora-tree-row', { hasText: 'broken' })).toHaveCount(0);
});

test('浏览器 MIME 误报：.gltf 以 application/json 上报仍按扩展名决议导入（格式决议，P4）', async ({ page }) => {
  const gltfJson = JSON.stringify({
    asset: { version: '2.0' },
    scenes: [{ nodes: [0] }],
    nodes: [{ name: 'JsonRoot' }],
  });
  await page.getByTestId('toolbar-model-file-input').setInputFiles({
    name: 'misreported.gltf',
    mimeType: 'application/json',
    buffer: Buffer.from(gltfJson, 'utf8'),
  });
  await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');
  await expect(page.locator('.lumora-tree-row', { hasText: 'misreported' })).toBeVisible();
  // 资源以 .gltf 格式持久化，模型对象可选中
  await page.locator('.lumora-tree-row', { hasText: 'misreported' }).click();
  await expect(page.getByTestId('inspector-model')).toContainText('misreported.gltf');
});

test('对象树键盘导航：Arrow/Home/End/Enter 沿可见行 roving focus，折叠后跳过子级（P4）', async ({ page }) => {
  const row = (id: string) => page.getByTestId(`tree-row-${id}`);
  // 点击只选择不移焦（鼠标路径）；键盘路径经 Tab 落入 roving tabindex 停靠点
  await row('sample-group').click();
  await row('sample-group').focus();
  await expect(row('sample-group')).toBeFocused();

  // 展开的 group → 首个可见子级；连续 ArrowDown 沿深度优先可见序
  await page.keyboard.press('ArrowDown');
  await expect(row('sample-cube')).toBeFocused();
  await expect(page.getByTestId('inspector-name')).toHaveValue('立方体');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(row('sample-cone')).toBeFocused();
  await expect(page.getByTestId('inspector-name')).toHaveValue('圆锥');

  await page.keyboard.press('End'); // 最后一个可见行（示例项目含两台机位）
  await expect(row('sample-camera-2')).toBeFocused();
  await expect(page.getByTestId('inspector-name')).toHaveValue('俯拍机位');
  await page.keyboard.press('Home');
  await expect(row('sample-group')).toBeFocused();

  // ArrowLeft 折叠 group（有子级且展开）；再 ArrowDown 跳过子级直达下一个根
  await page.keyboard.press('ArrowLeft');
  await expect(row('sample-cube')).not.toBeVisible();
  await page.keyboard.press('ArrowDown');
  await expect(row('sample-ground')).toBeFocused();

  // ArrowRight 展开；再 ArrowRight 移到首个可见子级
  await page.keyboard.press('ArrowUp');
  await expect(row('sample-group')).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(row('sample-cube')).toBeVisible();
  await page.keyboard.press('ArrowRight');
  await expect(row('sample-cube')).toBeFocused();

  // Enter：显式选中当前行
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('inspector-name')).toHaveValue('立方体');
});

test('M3 树行原生拖拽：拖到目标行重设父级，树层级与导出数据一致', async ({ page }) => {
  // 生产契约：行本身是原生 draggable；真实拖拽（HTML5 DnD）把 sample-cube 拖到 sample-ground
  await page.getByTestId('tree-row-sample-cube').dragTo(page.getByTestId('tree-row-sample-ground'));
  // 树层级更新：cube 嵌套进 ground 行下（默认展开可见）
  await expect(
    page.locator('[data-testid="tree-row-sample-ground"] [data-testid="tree-row-sample-cube"]'),
  ).toBeVisible();

  // 导出：parentId 变更持久化（parent 关联进入项目 JSON）
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const exported = JSON.parse(await readDownload(await downloadPromise));
  const cube = exported.objects.find((o: { id: string }) => o.id === 'sample-cube');
  expect(cube.parentId).toBe('sample-ground');
});

test('M3 APG 单一 Tab 入口：行是唯一 tab 停靠点，Tab 进入/离开树各只一次', async ({ page }) => {
  const row = (id: string) => page.getByTestId(`tree-row-${id}`);
  await row('sample-cube').click();
  await expect(row('sample-cube')).toHaveAttribute('tabindex', '0');

  // 行级 tab 停靠点唯一：仅活动行 tabIndex=0；行内按钮均非 tab 停靠点（APG treeview）
  const zeroCount = await page
    .locator('[role="treeitem"]')
    .evaluateAll((els) => els.filter((el) => (el as HTMLElement).tabIndex === 0).length);
  expect(zeroCount).toBe(1);
  for (const testId of ['tree-toggle-sample-cube', 'tree-visible-sample-cube', 'tree-lock-sample-cube', 'tree-delete-sample-cube']) {
    await expect(page.getByTestId(testId)).toHaveAttribute('tabindex', '-1');
  }

  // 单一 Tab 入口：从树头部控件（＋添加）Tab 一次即落入活动行，不逐行遍历
  await page.getByTestId('add-object').focus();
  await page.keyboard.press('Tab');
  await expect(row('sample-cube')).toBeFocused();

  // 从活动行再 Tab：直接离开树（行内按钮不拦截）
  await page.keyboard.press('Tab');
  const inTree = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    return el?.closest('[role="treeitem"]') !== null;
  });
  expect(inTree).toBe(false);
});

test('M3 树行键盘动作：V/L 切换可见/锁定，Delete 全局快捷键直接删除（可撤销）', async ({ page }) => {
  const row = (id: string) => page.getByTestId(`tree-row-${id}`);
  await row('sample-cube').click();
  await row('sample-cube').focus();

  // L：锁定（按钮文本翻转为「锁」）；V：隐藏（「隐」）——行内按钮等效快捷键
  await page.keyboard.press('l');
  await expect(page.getByTestId('tree-lock-sample-cube')).toHaveText('锁');
  await page.keyboard.press('v');
  await expect(page.getByTestId('tree-visible-sample-cube')).toHaveText('隐');
  await page.keyboard.press('l');
  await expect(page.getByTestId('tree-lock-sample-cube')).toHaveText('开');
  // Delete：宿主全局快捷键（选中行上直接删除，撤销可恢复）
  await page.keyboard.press('Delete');
  await expect(row('sample-cube')).not.toBeVisible();
  await page.getByTestId('undo').click();
  await expect(row('sample-cube')).toBeVisible();
});

test('M3 按钮双击隔离：双击不绕过删除确认、不触发行重命名、不重复切换', async ({ page }) => {
  // 双击删除按钮：第一次点击只进入确认态，双击的第二次点击被隔离 → 对象仍在
  await page.getByTestId('tree-delete-sample-light').dblclick();
  await expect(page.getByTestId('tree-row-sample-light')).toBeVisible();
  await expect(page.getByTestId('tree-delete-sample-light')).toHaveText('确认?');
  // 双击按钮不触发行级 dblclick（不进入重命名）
  await expect(page.getByTestId('tree-rename-sample-light')).toHaveCount(0);
  // 单击确认 → 删除
  await page.getByTestId('tree-delete-sample-light').click();
  await expect(page.getByTestId('tree-row-sample-light')).not.toBeVisible();

  // 双击可见性按钮：只切换一次（一次双击只产生一步「隐藏」，不因第二次点击回弹）
  await page.getByTestId('tree-visible-sample-cube').dblclick();
  await expect(page.getByTestId('tree-visible-sample-cube')).toHaveText('隐');
  await expect(page.getByTestId('tree-rename-sample-cube')).toHaveCount(0);
});

test('M3 数值字段 blur-first：点击外部提交草稿、Escape 同帧取消、Enter 提交', async ({ page }) => {
  await page.getByTestId('tree-row-sample-cube').click();
  const field = page.getByTestId('inspector-axis-0');
  await expect(field).toHaveValue('-2.5');

  // 草稿 + 点击树行（blur）→ 提交生效（blur-first，不依赖 Enter）
  await field.fill('7.5');
  await page.getByTestId('tree-row-sample-ground').click();
  await page.getByTestId('tree-row-sample-cube').click();
  await expect(field).toHaveValue('7.5');
  // 一步历史：撤销回到原值
  await page.getByTestId('undo').click();
  await expect(field).toHaveValue('-2.5');

  // Escape：草稿同帧取消，不提交
  await field.fill('99');
  await field.press('Escape');
  await expect(field).toHaveValue('-2.5');

  // Enter：提交（blur-first 的键盘路径）
  await field.fill('1.25');
  await field.press('Enter');
  await expect(field).toHaveValue('1.25');
});

test('场景切换器与视图工具条：Gizmo 模式/空间切换即时生效', async ({ page }) => {
  await expect(page.getByTestId('scene-switcher')).toHaveValue('scene-1');

  await page.getByTestId('gizmo-mode-rotate').click();
  await expect(page.getByTestId('gizmo-mode-rotate')).toHaveClass(/lumora-toolbutton--active/);

  await page.getByTestId('gizmo-space').click();
  await expect(page.getByTestId('gizmo-space')).toHaveText('世界');
});

test('Gizmo 缩放连续拖动：一步历史，撤销后位置/缩放整体恢复（AC3 验收）', async ({ page }) => {
  // 立方体移到原点：gizmo 居中于 canvas
  await page.getByTestId('tree-row-sample-cube').click();
  for (const axis of ['0', '1', '2']) {
    await page.getByTestId(`inspector-axis-${axis}`).fill('0');
    await page.getByTestId(`inspector-axis-${axis}`).press('Enter');
  }
  await page.waitForTimeout(300); // 等 canvas 重排 gizmo 到新位置
  await page.getByTestId('gizmo-mode-scale').click();
  await page.waitForTimeout(200);

  // 均匀缩放手柄（XYZY）：three-stdlib 烘焙在对象局部轴 +1.1 处（中心无手柄），
  // 屏幕位置随布局缩放，从渲染截图定位（见 uniformScaleHandle）
  const h = await uniformScaleHandle(page);
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  for (let i = 1; i <= 4; i += 1) {
    await page.mouse.move(h.x, h.y - i * 2);
  }
  await page.mouse.up();

  // 一次拖动产生缩放变更
  await expect(page.getByTestId('inspector-scale-0')).not.toHaveValue('1');

  // 一次撤销：缩放回 1，且位置保持 0 —— 整次拖动只占一步历史
  await page.getByTestId('undo').click();
  await expect(page.getByTestId('inspector-scale-0')).toHaveValue('1');
  await expect(page.getByTestId('inspector-axis-0')).toHaveValue('0');
});

test('真实 GLB（嵌套节点+材质）：持久化载荷随项目导出，导入/撤销/重做原子（P0 验收）', async ({ page }) => {
  await page.getByTestId('toolbar-model-file-input').setInputFiles(FIXTURE_GLB);
  await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');
  const row = page.locator('.lumora-tree-row', { hasText: 'nested-mesh' });
  await expect(row).toBeVisible();

  // 浏览器级持久化证据：导出 JSON 含模型对象与资源字节载荷，无 blob: 运行期引用
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const exported = JSON.parse(await readDownload(await downloadPromise));
  expect(JSON.stringify(exported)).not.toContain('blob:');
  expect(exported.assets.length).toBe(1);
  expect(exported.assets[0].payload.length).toBeGreaterThan(1000);
  expect(exported.assets[0].storageRef).toBe('');
  expect(exported.objects.filter((o: { type: string }) => o.type === 'model')).toHaveLength(1);

  // 撤销：对象与资源一并移除（导入 = 一步原子提交）
  await page.getByTestId('undo').click();
  await expect(page.locator('.lumora-tree-row', { hasText: 'nested-mesh' })).toHaveCount(0);
  const undoDownload = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const afterUndo = JSON.parse(await readDownload(await undoDownload));
  expect(afterUndo.assets.length).toBe(0);
  expect(afterUndo.objects.filter((o: { type: string }) => o.type === 'model')).toHaveLength(0);

  // 重做：对象与资源一并恢复，载荷仍在（内容可据此重建）
  await page.getByTestId('redo').click();
  await expect(row).toBeVisible();
  const redoDownload = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const afterRedo = JSON.parse(await readDownload(await redoDownload));
  expect(afterRedo.assets.length).toBe(1);
  expect(afterRedo.assets[0].payload.length).toBeGreaterThan(1000);
  expect(afterRedo.objects.filter((o: { type: string }) => o.type === 'model')).toHaveLength(1);
});

test.describe('S-7 验收：相机视图与 DPR', () => {
  test.describe('高 DPR 视口', () => {
    test.use({ deviceScaleFactor: 2 });

    test('DPR=2 时 canvas 物理像素为布局尺寸的两倍', async ({ page }) => {
      const canvas = page.locator('.lumora-viewport canvas');
      await page.waitForTimeout(300); // 等 R3F 按当前布局尺寸重设画布缓冲
      const box = (await canvas.boundingBox())!;
      const backing = await canvas.evaluate((el) => {
        const c = el as HTMLCanvasElement;
        return { width: c.width, height: c.height };
      });
      expect(Math.abs(backing.width - box.width * 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(backing.height - box.height * 2)).toBeLessThanOrEqual(1);
    });
  });

  test('相机视图：退出后活动相机逐像素恢复；辅助线为 DOM 覆盖层不进 canvas（S-7）', async ({ page }) => {
    const canvas = page.locator('.lumora-viewport canvas');
    await page.waitForTimeout(400); // 稳定首帧
    await hideOverlays(page, '.lumora-viewport-toolbar');
    const directorBefore = await canvas.screenshot();
    await showOverlays(page, '.lumora-viewport-toolbar');

    // 进入相机视图：构图与导演视图不同（验证截图对构图敏感）
    await page.getByTestId('view-mode-select').selectOption('sample-camera');
    await expect(page.getByTestId('lumora-guides')).toBeVisible();
    await page.waitForTimeout(400);
    await hideOverlays(page, '.lumora-viewport-toolbar');
    await hideOverlays(page, '.lumora-guides');
    const cameraView = await canvas.screenshot();
    await showOverlays(page, '.lumora-viewport-toolbar');
    await showOverlays(page, '.lumora-guides');
    expect(cameraView.equals(directorBefore)).toBe(false);

    // 三分线开/关不影响 canvas 像素（辅助线是 DOM 覆盖层，永不进入截图）
    await expect(page.getByLabel('三分线')).toBeChecked();
    await page.getByLabel('三分线').uncheck();
    await page.waitForTimeout(200);
    await hideOverlays(page, '.lumora-viewport-toolbar');
    await hideOverlays(page, '.lumora-guides');
    const withoutThirds = await canvas.screenshot();
    await showOverlays(page, '.lumora-viewport-toolbar');
    await showOverlays(page, '.lumora-guides');
    expect(withoutThirds.equals(cameraView)).toBe(true);

    // 退出相机视图：活动相机恢复为导演相机，构图与进入前逐像素一致
    await page.getByTestId('view-mode-select').selectOption('director');
    await expect(page.getByTestId('lumora-guides')).not.toBeVisible();
    await page.waitForTimeout(400);
    await hideOverlays(page, '.lumora-viewport-toolbar');
    const restored = await canvas.screenshot();
    await showOverlays(page, '.lumora-viewport-toolbar');
    expect(restored.equals(directorBefore)).toBe(true);
  });
});

test.describe('G-10 验收：窄屏布局', () => {
  test.use({ viewport: { width: 375, height: 667 } });

  test('375px 视口无水平溢出，编辑区可用', async ({ page }) => {
    await page.getByTestId('tree-row-sample-group').click();
    const { scrollWidth, innerWidth } = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    }));
    expect(scrollWidth).toBeLessThanOrEqual(innerWidth);

    // 窄屏下列布局仍可编辑：选中对象并修改名称提交
    await page.getByTestId('inspector-name').fill('窄屏示例组');
    await page.getByTestId('inspector-name').press('Enter');
    await expect(page.getByTestId('tree-row-sample-group')).toContainText('窄屏示例组');
  });
});

test('P0 真实流程：导入 → 变换 → 导出 → 全新运行时重开（数据一致）', async ({ page }) => {
  await page.getByTestId('toolbar-model-file-input').setInputFiles(FIXTURE_GLB);
  await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');
  const row = page.locator('.lumora-tree-row', { hasText: 'nested-mesh' });
  await expect(row).toBeVisible();

  // 变换：X 位置设为 2.25
  await row.click();
  await page.getByTestId('inspector-axis-0').fill('2.25');
  await page.getByTestId('inspector-axis-0').press('Enter');
  await expect(page.getByTestId('inspector-axis-0')).toHaveValue('2.25');

  // 导出：全量项目 JSON（场景/设置/资源载荷）写入 localStorage 供宿主重开
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const exported = JSON.parse(await readDownload(await downloadPromise));
  expect(exported.scenes.length).toBeGreaterThanOrEqual(1);
  expect(exported.assets).toHaveLength(1);
  expect(await page.evaluate(() => localStorage.getItem('lumora.demo.last-export'))).not.toBeNull();

  // 全新运行时重开：reload 清空当前 Studio 会话，宿主按钮以导出 JSON 重建项目
  await page.reload();
  await expect(page.getByTestId('lumora-studio')).toBeVisible();
  await page.getByTestId('reopen-last-export').click();
  const reopenedRow = page.locator('.lumora-tree-row', { hasText: 'nested-mesh' });
  await expect(reopenedRow).toBeVisible();

  // 数据一致：对象与变换恢复；视图状态复位为导演视图
  await reopenedRow.click();
  await expect(page.getByTestId('inspector-axis-0')).toHaveValue('2.25');
  await expect(page.getByTestId('view-mode-select')).toHaveValue('director');

  // 模型内容从持久化载荷重建：再次导出载荷仍在（真实几何字节未被丢弃）
  const reExportPromise = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const reopened = JSON.parse(await readDownload(await reExportPromise));
  expect(reopened.assets).toHaveLength(1);
  expect(reopened.assets[0].payload.length).toBeGreaterThan(1000);
});

test('P0-2 复制后删除原件：副本保留、资源不释放、导出仍含资源', async ({ page }) => {
  await page.getByTestId('toolbar-model-file-input').setInputFiles(FIXTURE_GLB);
  await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');
  const row = page.locator('.lumora-tree-row', { hasText: 'nested-mesh' });
  await expect(row).toHaveCount(1);

  // Ctrl+D 复制：两行（选择在副本）
  await row.click();
  await page.keyboard.press('Control+d');
  await expect(page.locator('.lumora-tree-row', { hasText: 'nested-mesh' })).toHaveCount(2);

  // 删除原件（第一行）→ 副本仍在
  await page.locator('.lumora-tree-row', { hasText: 'nested-mesh' }).first().click();
  await page.keyboard.press('Delete');
  await expect(page.locator('.lumora-tree-row', { hasText: 'nested-mesh' })).toHaveCount(1);

  // 导出：一个模型对象 + 资源保留（缓存引用以项目关系为准，未被误释放）
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const exported = JSON.parse(await readDownload(await downloadPromise));
  const models = exported.objects.filter((o: { type: string }) => o.type === 'model');
  expect(models).toHaveLength(1);
  expect(exported.assets).toHaveLength(1);
  expect(models[0].assetId).toBe(exported.assets[0].id);
});

/** 立方体移到原点并切换到缩放 Gizmo */
async function centerCubeAndScale(page: Page): Promise<void> {
  await page.getByTestId('tree-row-sample-cube').click();
  for (const axis of ['0', '1', '2']) {
    await page.getByTestId(`inspector-axis-${axis}`).fill('0');
    await page.getByTestId(`inspector-axis-${axis}`).press('Enter');
  }
  await page.waitForTimeout(300); // 等 canvas 重排 gizmo 到新位置
  await page.getByTestId('gizmo-mode-scale').click();
  await page.waitForTimeout(200);
}

async function startDrag(page: Page): Promise<void> {
  const h = await uniformScaleHandle(page);
  await page.mouse.move(h.x, h.y);
  await page.mouse.down();
  await page.mouse.move(h.x, h.y - 4);
}

/**
 * 定位均匀缩放手柄（XYZY）：截图扫描纯色轴手柄像素（红/绿/蓝，排除场景对象与
 * 高光）→ gizmo 包围盒中心 = 选中对象投影中心；绿色像素顶边 = Y 手柄顶边
 * （局部 0.8625），XYZY 手柄中心在局部 1.1（three-stdlib 固定几何）。
 * 返回画布页面坐标，随布局/视口尺寸自适应。
 */
async function uniformScaleHandle(page: Page): Promise<{ x: number; y: number }> {
  const canvas = page.locator('.lumora-viewport canvas');
  const shot = await canvas.screenshot();
  const png = decodePng(shot);
  let minX = png.width;
  let maxX = 0;
  let minY = png.height;
  let maxY = 0;
  let greenTop = png.height;
  for (let y = 0; y < png.height; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const [r, g, b] = pngPixel(png, x, y);
      const pureRed = r > 200 && g < 80 && b < 80;
      const pureGreen = g > 200 && r < 80 && b < 80;
      const pureBlue = b > 200 && r < 80 && g < 80;
      if (pureRed || pureGreen || pureBlue) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
      if (pureGreen && y < greenTop) greenTop = y;
    }
  }
  const centerY = (minY + maxY) / 2;
  const box = await canvas.boundingBox();
  return {
    x: box.x + (minX + maxX) / 2,
    y: box.y + centerY - (1.1 / 0.8625) * (centerY - greenTop),
  };
}

/** 撤销直到按钮禁用（轴输入产生的历史步数不定：目标值可能等于当前值而无提交） */
async function undoUntilDisabled(page: Page): Promise<void> {
  for (let i = 0; i < 12; i += 1) {
    if (!(await page.getByTestId('undo').isEnabled())) break;
    await page.getByTestId('undo').click();
  }
  await expect(page.getByTestId('undo')).toBeDisabled();
}

test('P0-6 Gizmo 中断：Escape 回滚变换、不产生历史、拖动态清理', async ({ page }) => {
  await centerCubeAndScale(page);
  await startDrag(page);
  // 拖动中按 Escape：节点回滚到拖动前缩放
  await page.keyboard.press('Escape');
  await page.mouse.up();
  // Escape 同时清空选择 → 重新选中立方体验证数据未变
  await page.getByTestId('tree-row-sample-cube').click();
  await expect(page.getByTestId('inspector-scale-0')).toHaveValue('1');
  // 中断的拖动不产生历史：撤销只回退轴输入，耗尽后按钮禁用
  await undoUntilDisabled(page);
  await expect(page.getByTestId('inspector-scale-0')).toHaveValue('1');
});

test('P0-6 Gizmo 中断：window blur 回滚并清理拖动态', async ({ page }) => {
  await centerCubeAndScale(page);
  await startDrag(page);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await page.mouse.up();
  await page.getByTestId('tree-row-sample-cube').click();
  await expect(page.getByTestId('inspector-scale-0')).toHaveValue('1');
  await undoUntilDisabled(page);
  await expect(page.getByTestId('inspector-scale-0')).toHaveValue('1');
});

test('P0-6 Gizmo 中断：pointercancel 回滚并清理拖动态', async ({ page }) => {
  await centerCubeAndScale(page);
  await startDrag(page);
  await page.evaluate(() => window.dispatchEvent(new PointerEvent('pointercancel')));
  await page.mouse.up();
  await page.getByTestId('tree-row-sample-cube').click();
  await expect(page.getByTestId('inspector-scale-0')).toHaveValue('1');
  await undoUntilDisabled(page);
  await expect(page.getByTestId('inspector-scale-0')).toHaveValue('1');
});

test('P0-6 Gizmo 中断：Delete 删除对象时拖动态清理、无残留状态', async ({ page }) => {
  await centerCubeAndScale(page);
  await startDrag(page);
  await page.keyboard.press('Delete');
  await page.mouse.up();
  // 对象已删除（一步历史）
  await expect(page.getByTestId('tree-row-sample-cube')).not.toBeVisible();
  await expect(page.getByTestId('undo')).toBeEnabled();
  // 拖动态已清理：选择其他对象可正常编辑
  await page.getByTestId('tree-row-sample-ground').click();
  await expect(page.getByTestId('inspector-name')).toHaveValue('地面');
});

test('P0-4 多场景相机/选择隔离：机位按场景过滤，切场景回退导演视图', async ({ page }) => {
  // 导出示例项目（写入 localStorage），注入第二个场景与 B 相机
  const seedDownload = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  await readDownload(await seedDownload);
  await page.evaluate(() => {
    const project = JSON.parse(localStorage.getItem('lumora.demo.last-export')!);
    const cam = project.objects.find((o: { id: string }) => o.id === 'sample-camera');
    const camB = { ...cam, id: 'cam-b', name: 'B 相机' };
    project.objects.push(camB);
    project.scenes.push({ id: 'scene-b', name: '场景 B', rootObjectIds: ['cam-b'], activeCameraId: 'cam-b' });
    localStorage.setItem('lumora.demo.last-export', JSON.stringify(project));
  });
  await page.reload();
  await page.getByTestId('reopen-last-export').click();
  await expect(page.getByTestId('tree-row-sample-group')).toBeVisible();

  // 场景 A：机位选项含 sample-camera 与 sample-camera-2
  const modeSelect = page.getByTestId('view-mode-select');
  await expect(modeSelect.locator('option')).toHaveText(['导演视图', '相机 · 主摄像机', '相机 · 俯拍机位']);

  // 切到场景 B：树只含 B 相机，机位选项只有 cam-b
  await page.getByTestId('scene-switcher').selectOption('scene-b');
  await expect(page.getByTestId('tree-row-cam-b')).toBeVisible();
  await expect(modeSelect.locator('option')).toHaveText(['导演视图', '相机 · B 相机']);
  await expect(page.locator('.lumora-tree-row--selected')).toHaveCount(0);

  // 场景 B 中查看 B 相机：辅助线出现
  await modeSelect.selectOption('cam-b');
  await expect(page.getByTestId('lumora-guides')).toBeVisible();

  // 切回场景 A：B 相机不属于 A → 视图自动回退导演视图
  await page.getByTestId('scene-switcher').selectOption('scene-1');
  await expect(page.getByTestId('tree-row-cam-b')).not.toBeVisible();
  await expect(page.getByTestId('lumora-guides')).not.toBeVisible();
  await expect(modeSelect).toHaveValue('director');

  // 选择随场景过滤：A 中无跨场景选择残留
  await page.getByTestId('tree-row-sample-camera').click();
  await expect(page.locator('.lumora-tree-row--selected')).toHaveCount(1);
  await page.getByTestId('scene-switcher').selectOption('scene-b');
  await expect(page.locator('.lumora-tree-row--selected')).toHaveCount(0);
});

test.describe('P0-8 letterbox 黑边像素验收', () => {
  for (const dpr of [1, 2]) {
    test.describe(`DPR=${dpr}`, () => {
      test.use({ deviceScaleFactor: dpr });

      test('相机视图黑边纯黑、画幅内渲染场景', async ({ page }) => {
        await page.getByTestId('view-mode-select').selectOption('sample-camera');
        await expect(page.getByTestId('lumora-guides')).toBeVisible();
        await page.waitForTimeout(400);
        await hideOverlays(page, '.lumora-viewport-toolbar');
        await hideOverlays(page, '.lumora-guides');
        const shot = await page.locator('.lumora-viewport canvas').screenshot();
        await showOverlays(page, '.lumora-viewport-toolbar');
        await showOverlays(page, '.lumora-guides');

        const png = decodePng(shot);
        const midX = Math.floor(png.width / 2);
        const midY = Math.floor(png.height / 2);
        const isBlack = (p: [number, number, number, number]) => p[0] === 0 && p[1] === 0 && p[2] === 0;
        const edges = [
          pngPixel(png, 2, midY), // 左
          pngPixel(png, png.width - 3, midY), // 右
          pngPixel(png, midX, 2), // 上
          pngPixel(png, midX, png.height - 3), // 下
        ];
        // 16:9 画幅在容器内上下或左右留边：对应边缘对必须为纯黑
        expect(edges.filter(isBlack).length).toBeGreaterThanOrEqual(2);
        // 画幅内渲染非黑（场景背景 #14161f 或对象）
        const center = pngPixel(png, midX, midY);
        expect(center[0] + center[1] + center[2]).toBeGreaterThan(10);
      });
    });
  }
});

test.describe('第三轮验收：生产路径（AC1/AC3/AC4）', () => {
  test('AC1 生产 SceneContent：真实 GLB 材质与嵌套几何渲染（无占位框）', async ({ page }) => {
    await page.getByTestId('toolbar-model-file-input').setInputFiles(FIXTURE_GLB);
    await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');
    await expect(page.locator('.lumora-tree-row', { hasText: 'nested-mesh' })).toBeVisible();

    // 内容挂载完成（占位框被 GLB 内容替换），导演视图渲染模型（原点）。
    // GLB 解析/挂载异步，固定等待在负载下会提前采样到未替换的占位框（flake），
    // 改为轮询紫色占位框像素归零：内容永不到挂载则轮询超时失败（回归语义不变）
    await hideOverlays(page, '.lumora-viewport-toolbar');
    // 导入自动选中模型 → 变换控件 gizmo 确定性出现（场景同步竞态回归防护：
    // syncScene 结构变更未触发重渲染时，gizmo 出现与否取决于无关状态更新时序；
    // 纯红 X 轴 / 纯蓝 Z 轴是场景中唯一接近纯红/纯蓝的像素源，其余物体均为
    // 阴影化着色，g=107+ 或 b=171+ 不满足 g<50/b<50 的硬阈值）
    const gizmoPixels = (p: ReturnType<typeof decodePng>): number => {
      let count = 0;
      for (let y = 0; y < p.height; y += 2) {
        for (let x = 0; x < p.width; x += 2) {
          const [r, g, b] = pngPixel(p, x, y);
          if ((r > 230 && g < 50 && b < 50) || (b > 230 && r < 50 && g < 50)) count += 1;
        }
      }
      return count;
    };
    await expect
      .poll(
        async () => gizmoPixels(decodePng(await page.locator('.lumora-viewport canvas').screenshot())),
        { timeout: 5000 },
      )
      .toBeGreaterThan(0);
    // Escape 清选 → gizmo 消失：gizmo 轴色与占位框启发式同色相，不清选则
    // 下方的紫色计数恒非零，无法表达「占位框已替换」
    await page.keyboard.press('Escape');
    await expect
      .poll(
        async () => gizmoPixels(decodePng(await page.locator('.lumora-viewport canvas').screenshot())),
        { timeout: 5000 },
      )
      .toBe(0);
    await expect
      .poll(async () => {
        const p = decodePng(await page.locator('.lumora-viewport canvas').screenshot());
        let purple = 0;
        for (let y = 0; y < p.height; y += 2) {
          for (let x = 0; x < p.width; x += 2) {
            const [r, g, b] = pngPixel(p, x, y);
            if (b > 150 && g < r && g < 120) purple += 1;
          }
        }
        return purple;
      }, { timeout: 5000 })
      .toBe(0);
    const shot = await page.locator('.lumora-viewport canvas').screenshot();
    await showOverlays(page, '.lumora-viewport-toolbar');
    const png = decodePng(shot);

    let bodyPixels = 0;
    let placeholderPixels = 0;
    let minX = png.width;
    let maxX = 0;
    let minY = png.height;
    let maxY = 0;
    for (let y = 0; y < png.height; y += 2) {
      for (let x = 0; x < png.width; x += 2) {
        const [r, g, b] = pngPixel(png, x, y);
        // 车身 #d9480f（受光/环境光下均为红主导且绿>蓝）；示例对象中立方体
        // #ff6b6b 与球/锥为蓝绿主导，不会误命中的原因：立方体 g==b 恒等
        if (r > 60 && r > 2.2 * g && g > b) {
          bodyPixels += 1;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        // 占位框（紫色线框 #7a6bff，70% 透明度叠背景 ≈ (91,82,188)）必须已全部替换。
        // 紫色相 b>r>g；示例球体 #4dabf7 是蓝色相 b>g>r（阴影面 (44,127,181) 会误命中
        // 宽松的 b>180 条件），用 g<r 区分两色相
        if (b > 150 && g < r && g < 120) placeholderPixels += 1;
      }
    }
    // 真实材质：GLB 的 MeshStandardMaterial 颜色经生产解析/挂载路径渲染成片
    expect(bodyPixels).toBeGreaterThan(100);
    expect(placeholderPixels).toBe(0);
    // 嵌套几何：2×0.6×1 车身（45° 视角）在画面中宽显著大于高，且聚类居中。
    // 像素尺寸与画布高度成正比（投影缩放 ∝ H），阈值按画布高度等比例校准
    const clusterWidth = maxX - minX + 1;
    const clusterHeight = maxY - minY + 1;
    expect(clusterWidth).toBeGreaterThanOrEqual(Math.round(png.height * 0.18));
    expect(clusterHeight).toBeGreaterThanOrEqual(20);
    expect(clusterWidth).toBeGreaterThan(1.5 * clusterHeight);
    expect((minX + maxX) / 2).toBeCloseTo(png.width / 2, -1);
  });

  test('AC3 Gizmo 生产路径：拖动实时预览、撤销/重做精确恢复、中断回滚（preview→rollback）', async ({ page }) => {
    await centerCubeAndScale(page);
    const canvas = page.locator('.lumora-viewport canvas');

    // 基准画面 A：Escape 清选（点击画布角落可能命中地面对象）→ 无 gizmo、缩放 1
    await page.keyboard.press('Escape');
    await page.waitForTimeout(150);
    const shotA = await canvas.screenshot();

    // 重新选中 → 拖动开始：立方体随指针实时缩放（预览生效，画面变化）
    await page.getByTestId('tree-row-sample-cube').click();
    await page.waitForTimeout(150);
    const h = await uniformScaleHandle(page);
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    for (let i = 1; i <= 4; i += 1) {
      await page.mouse.move(h.x, h.y - i * 2);
    }
    await page.waitForTimeout(120);
    const shotB = await canvas.screenshot();
    expect(shotB.equals(shotA)).toBe(false);

    // 提交 → 一步历史；撤销精确回 1、重做精确恢复提交值
    await page.mouse.up();
    const scaleValue = await page.getByTestId('inspector-scale-0').inputValue();
    expect(scaleValue).not.toBe('1');
    await expect(page.getByTestId('inspector-axis-0')).toHaveValue('0');
    await page.getByTestId('undo').click();
    await expect(page.getByTestId('inspector-scale-0')).toHaveValue('1');
    await expect(page.getByTestId('inspector-axis-0')).toHaveValue('0');
    await page.getByTestId('redo').click();
    await expect(page.getByTestId('inspector-scale-0')).toHaveValue(scaleValue);
    await expect(page.getByTestId('inspector-axis-0')).toHaveValue('0');

    // 中断路径（Escape）：先归位缩放使 gizmo 手柄回到已知位置
    for (const axis of ['0', '1', '2']) {
      await page.getByTestId(`inspector-scale-${axis}`).fill('1');
      await page.getByTestId(`inspector-scale-${axis}`).press('Enter');
    }
    await page.waitForTimeout(150);
    const shotA2 = await canvas.screenshot(); // 拖动前：gizmo、缩放 1

    const h2 = await uniformScaleHandle(page);
    await page.mouse.move(h2.x, h2.y);
    await page.mouse.down();
    await page.mouse.move(h2.x, h2.y - 4);
    await page.waitForTimeout(120);
    const shotB2 = await canvas.screenshot(); // 预览中：画面已变化
    expect(shotB2.equals(shotA2)).toBe(false);

    // Escape 回滚：节点回到拖动前缩放；中断不产生历史。
    // Escape 同时清除了选择（属性面板显示「未选择对象」），先重新选中再断言数值
    await page.keyboard.press('Escape');
    await page.mouse.up();
    await page.waitForTimeout(150);
    await page.getByTestId('tree-row-sample-cube').click();
    await page.waitForTimeout(150);
    await expect(page.getByTestId('inspector-scale-0')).toHaveValue('1');
    // 回滚后画面与拖动前逐像素一致（Escape 清选，重新选中后对比）
    const shotC2 = await canvas.screenshot();
    expect(shotC2.equals(shotA2)).toBe(true);

    // 中断拖动未入历史：撤销耗尽后缩放仍是 1
    await undoUntilDisabled(page);
    await expect(page.getByTestId('inspector-scale-0')).toHaveValue('1');
  });

  test('AC4 生产路径：16:9 画幅逐像素对齐、辅助线重合、50mm 已知点投影', async ({ page }) => {
    // 注入确定性探针项目：50mm 相机位于 (0,2,10) 平视 -Z，红色探针盒位于已知点。
    // 相机视图把渲染区域收窄到 16:9 画幅并保持投影纵横比 → 探针顶面中心应
    // 精确投影到预期像素：NDC x=0.25、NDC y=(1-2)/(10·tan(50mm FOV/2))=-0.4167
    const fovDeg = (2 * Math.atan(24 / 2 / 50) * 180) / Math.PI;
    const halfH = 10 * Math.tan((fovDeg * Math.PI) / 360);
    const halfW = (halfH * 16) / 9;
    const probeX = halfW * 0.25;
    await page.evaluate(
      ({ fovDeg: fov, probeX: px }) => {
        const project = {
          uri: 'lumora://probe-project',
          name: '投影探针',
          schemaVersion: 4,
          createdAt: new Date().toISOString(),
          revision: 0,
          settings: { fps: 24, aspect: [16, 9] },
          activeSceneId: 'scene-1',
          scenes: [
            {
              id: 'scene-1',
              name: '主场景',
              rootObjectIds: ['probe-camera', 'probe-box', 'probe-light'],
              activeCameraId: 'probe-camera',
            },
          ],
          objects: [
            {
              id: 'probe-camera',
              type: 'camera',
              name: '探针相机',
              parentId: null,
              transform: { position: [0, 2, 10], rotation: [0, 0, 0], scale: [1, 1, 1] },
              visible: true,
              locked: false,
              camera: {
                projection: 'perspective',
                focalLength: 50,
                fov,
                sensorWidth: 36,
                sensorHeight: 24,
                near: 0.1,
                far: 200,
                aspect: null,
              },
            },
            {
              id: 'probe-box',
              type: 'primitive',
              name: '探针盒',
              parentId: null,
              transform: { position: [px, 0.5, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
              visible: true,
              locked: false,
              geometry: { kind: 'box' },
              material: { color: '#ff0000' },
            },
            {
              id: 'probe-light',
              type: 'light',
              name: '主光',
              parentId: null,
              transform: { position: [4, 8, 4], rotation: [0, 0, 0], scale: [1, 1, 1] },
              visible: true,
              locked: false,
              light: { kind: 'directional', color: '#ffffff', intensity: 1.4 },
            },
          ],
          tracks: [],
          shots: [],
          assets: [],
        };
        localStorage.setItem('lumora.demo.last-export', JSON.stringify(project));
      },
      { fovDeg, probeX },
    );
    await page.reload();
    await page.getByTestId('reopen-last-export').click();
    await expect(page.getByTestId('tree-row-probe-box')).toBeVisible();

    // 隐藏宿主调试日志面板（340px）：否则 Studio 被压到 940px，340px 宽的画布上
    // ±1px 整数量化即可让 16:9 比值在 1.7801（340×191）/1.7708（340×192）间翻转，
    // 恰好落在 toBeCloseTo(16/9, 2) 容差边界上（工具栏换行等任意布局变化都会触发）。
    // 全宽布局下画幅 680×382，量化噪声 0.0026 远小于容差，比值断言恢复真实精度。
    await page.addStyleTag({ content: '.host__log { display: none }' });

    // 进入相机视图：画幅矩形与辅助线由同一 fitRect 计算，应逐像素重合
    await page.getByTestId('view-mode-select').selectOption('probe-camera');
    await expect(page.getByTestId('lumora-guides')).toBeVisible();
    await page.waitForTimeout(400);

    const canvas = page.locator('.lumora-viewport canvas');
    const canvasBox = (await canvas.boundingBox())!;
    const guidesBox = (await page.getByTestId('lumora-guides').boundingBox())!;
    await hideOverlays(page, '.lumora-viewport-toolbar');
    await hideOverlays(page, '.lumora-guides');
    const shot = await canvas.screenshot();
    await showOverlays(page, '.lumora-viewport-toolbar');
    await showOverlays(page, '.lumora-guides');

    // 逐像素扫描画幅边界（letterbox 纯黑，画幅内为场景背景 #14161f）→ 精确 16:9
    const png = decodePng(shot);
    const frame = scanFrameBounds(png);
    const frameW = frame.maxX - frame.minX + 1;
    const frameH = frame.maxY - frame.minY + 1;
    expect(frameW / frameH).toBeCloseTo(16 / 9, 2);

    // 辅助线 DOM 矩形与 WebGL 画幅重合（同一 fitRect 计算；CSS 高度含小数时
    // gl.viewport 整数截断致画幅边界 ±1px 偏差，允许 1px 容差）
    const guideX = guidesBox.x - canvasBox.x;
    const guideY = guidesBox.y - canvasBox.y;
    expect(Math.abs(guideX - frame.minX)).toBeLessThanOrEqual(1);
    expect(Math.abs(guideY - frame.minY)).toBeLessThanOrEqual(1);
    expect(Math.abs(guidesBox.width - frameW)).toBeLessThanOrEqual(1);
    expect(Math.abs(guidesBox.height - frameH)).toBeLessThanOrEqual(1);

    // 50mm 已知点投影：探针盒顶面中心（NDC (0.25, -0.4167)）落在亮红像素上
    const px = frame.minX + ((0.25 + 1) / 2) * frameW;
    const py = frame.minY + ((1 + 1 / 2.4) / 2) * frameH; // (1-2)/2.4 = -0.4167
    let hit = false;
    for (let dy = -3; dy <= 3 && !hit; dy += 1) {
      for (let dx = -3; dx <= 3; dx += 1) {
        const [r, g, b] = pngPixel(png, Math.round(px + dx), Math.round(py + dy));
        if (r > 150 && g < 90 && b < 90) {
          hit = true;
          break;
        }
      }
    }
    expect(hit).toBe(true);

    // 负向对照：画幅右上空区（NDC (0.5, 0.5)）非红（背景 #14161f）
    const [nr, ng, nb] = pngPixel(png, Math.round(frame.minX + 0.75 * frameW), Math.round(frame.minY + 0.25 * frameH));
    expect(nr).toBeLessThan(90);
    expect(ng).toBeLessThan(90);
    expect(nb).toBeLessThan(90);
  });
});
