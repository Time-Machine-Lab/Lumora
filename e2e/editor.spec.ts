import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Download } from '@playwright/test';

/** 生成最小合法 GLB（仅 JSON chunk，无缓冲）：{asset, scenes, nodes} */
function buildGlb(json: Record<string, unknown>): Buffer {
  const jsonText = JSON.stringify(json);
  const pad = (4 - (jsonText.length % 4)) % 4;
  const jsonBytes = Buffer.concat([Buffer.from(jsonText, 'utf8'), Buffer.alloc(pad, 0x20)]);
  const total = 12 + 8 + jsonBytes.length;
  const header = Buffer.alloc(12);
  header.writeUInt32LE(0x46546c67, 0); // 'glTF'
  header.writeUInt32LE(2, 4);
  header.writeUInt32LE(total, 8);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.writeUInt32LE(jsonBytes.length, 0);
  chunkHeader.writeUInt32LE(0x4e4f534a, 4); // 'JSON'
  return Buffer.concat([header, chunkHeader, jsonBytes]);
}

const MINIMAL_GLB = buildGlb({
  asset: { version: '2.0' },
  scenes: [{ nodes: [0] }],
  nodes: [{ name: 'EmptyRoot' }],
});

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

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-group')).toBeVisible();
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

  const canvas = page.locator('.lumora-viewport canvas');
  const box = (await canvas.boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  // 均匀缩放手柄（XYZY）在 gizmo 中心正上方约 100px（three-stdlib 的
  // 缩放手柄烘焙在对象局部轴 +1.1 处，屏幕投影 ≈104px；中心无手柄）。
  // 拖动时每次 pointermove 都会重算 axis，指针离开手柄范围拖动即断，
  // 因此拖距限制在手柄 ~19px 屏幕尺寸内，最终缩放比 ≈108/100
  await page.mouse.move(cx, cy - 100);
  await page.mouse.down();
  for (let i = 1; i <= 4; i += 1) {
    await page.mouse.move(cx, cy - 100 - i * 2);
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
