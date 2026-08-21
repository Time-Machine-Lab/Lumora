import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { decodePng, pngPixel } from './helpers/png';
import { ONE_PIXEL_PNG, buildTriangleGltf } from './helpers/gltf';

/**
 * R6 生产浏览器用例（TML-57 第六轮复审 AC1 与外部资源）：
 * - 同 hash 内容两实例同帧渲染、无占位框（逐像素证明）；
 * - 删除任一实例后另一实例仍渲染；导出 → 全新运行时重开数据与渲染一致；
 * - 生产目录入口（webkitdirectory）保留嵌套目录相对路径；重复 basename 真机歧义失败。
 */

const FIXTURE_GLB = fileURLToPath(new URL('../packages/studio/test/fixtures/nested-mesh.glb', import.meta.url));

/** 轮子橙（baseColor ≈ 0.69/0.065/0.005，环境光 0.35 → 约 (62,6,0)） */
function isWheelPixel(r: number, g: number, b: number): boolean {
  return r >= 35 && r <= 160 && g <= r * 0.55 && b <= 12;
}

/** 占位框紫（#7a6bff 线框 0.7 叠背景 ≈ (91,82,188)） */
function isPlaceholderPixel(r: number, g: number, b: number): boolean {
  return r >= 60 && r <= 130 && b >= 150 && g >= 55 && g <= 120 && b > r + 60;
}

/** 三角形红（材质贴 1×1 红纹理，环境光 0.35 → 约 (89,18,9)） */
function isTriPixel(r: number, g: number, b: number): boolean {
  return r >= 45 && r <= 160 && g <= r * 0.5 && b <= r * 0.45;
}

async function viewportPng(page: Page): Promise<ReturnType<typeof decodePng>> {
  const shot = await page.locator('.lumora-viewport canvas').screenshot();
  return decodePng(shot);
}

/** 区域内满足谓词的像素计数（x∈[x0,x1)，全高度） */
function countPixels(
  png: ReturnType<typeof decodePng>,
  predicate: (r: number, g: number, b: number) => boolean,
  x0 = 0,
  x1 = Number.POSITIVE_INFINITY,
): number {
  let count = 0;
  const endX = Math.min(x1, png.width);
  for (let y = 0; y < png.height; y += 1) {
    for (let x = x0; x < endX; x += 1) {
      const [r, g, b] = pngPixel(png, x, y);
      if (predicate(r, g, b)) count += 1;
    }
  }
  return count;
}

const pollCount = (page: Page, predicate: (r: number, g: number, b: number) => boolean, x0 = 0, x1 = Number.POSITIVE_INFINITY) =>
  expect.poll(
    async () => countPixels(await viewportPng(page), predicate, x0, x1),
    { timeout: 20_000 },
  );

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-group')).toBeVisible();
});

test('R6-AC1 同内容两实例同帧渲染：逐像素证明并存、无占位框、删除后另一实例仍渲染', async ({ page }) => {
  await page.getByTestId('toolbar-model-file-input').setInputFiles(FIXTURE_GLB);
  await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');
  const rows = page.locator('.lumora-tree-row', { hasText: 'nested-mesh' });
  await expect(rows).toHaveCount(1);

  // 实例 1 移到 x=-4（避开示例对象），等内容挂载后取基线像素
  await rows.click();
  await page.getByTestId('inspector-axis-0').fill('-4');
  await page.getByTestId('inspector-axis-0').press('Enter');
  await page.keyboard.press('Escape'); // 清除选择，避免 gizmo 像素
  await pollCount(page, isWheelPixel).toBeGreaterThanOrEqual(60);
  const base = countPixels(await viewportPng(page), isWheelPixel);
  expect(base).toBeGreaterThanOrEqual(60);
  // 无占位框：内容挂载后线框占位盒像素为零（逐像素证明）
  expect(countPixels(await viewportPng(page), isPlaceholderPixel)).toBe(0);

  // 同内容再次导入：资源去重、新增一个实例
  await page.getByTestId('toolbar-model-file-input').setInputFiles(FIXTURE_GLB);
  await expect(page.getByTestId('lumora-toasts')).toContainText('资源已复用');
  await expect(rows).toHaveCount(2);

  // 实例 2 移到 x=3.5：两实例分开放置，不得重叠
  await rows.nth(1).click();
  await page.getByTestId('inspector-axis-0').fill('3.5');
  await page.getByTestId('inspector-axis-0').press('Enter');
  await page.keyboard.press('Escape');

  // 两实例同帧渲染：左右两半都有轮子像素，总量不低于单实例基线
  await pollCount(page, isWheelPixel).toBeGreaterThanOrEqual(base * 1.6);
  const png = await viewportPng(page);
  const left = countPixels(png, isWheelPixel, 0, png.width / 2);
  const right = countPixels(png, isWheelPixel, png.width / 2, png.width);
  expect(left).toBeGreaterThanOrEqual(base * 0.6);
  expect(right).toBeGreaterThanOrEqual(base * 0.6);
  expect(countPixels(png, isPlaceholderPixel)).toBe(0);

  // 删除实例 1：实例 2 仍渲染（左半轮子像素消失、右半保留）
  await rows.nth(0).click();
  await page.keyboard.press('Delete');
  await expect(rows).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect.poll(async () => {
    const after = await viewportPng(page);
    return countPixels(after, isWheelPixel, 0, after.width / 2);
  }).toBeLessThan(base * 0.3);
  await expect.poll(async () => {
    const after = await viewportPng(page);
    return countPixels(after, isWheelPixel, after.width / 2, after.width);
  }).toBeGreaterThanOrEqual(base * 0.6);
});

test('R6-AC1 导出 → 全新运行时重开：两实例数据与渲染一致', async ({ page }) => {
  await page.getByTestId('toolbar-model-file-input').setInputFiles(FIXTURE_GLB);
  await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');
  await page.getByTestId('toolbar-model-file-input').setInputFiles(FIXTURE_GLB);
  await expect(page.getByTestId('lumora-toasts')).toContainText('资源已复用');
  const rows = page.locator('.lumora-tree-row', { hasText: 'nested-mesh' });
  await expect(rows).toHaveCount(2);

  await rows.nth(0).click();
  await page.getByTestId('inspector-axis-0').fill('-4');
  await page.getByTestId('inspector-axis-0').press('Enter');
  await rows.nth(1).click();
  await page.getByTestId('inspector-axis-0').fill('3.5');
  await page.getByTestId('inspector-axis-0').press('Enter');
  await page.keyboard.press('Escape');
  await pollCount(page, isWheelPixel).toBeGreaterThanOrEqual(60);
  const png = await viewportPng(page);
  expect(countPixels(png, isWheelPixel, 0, png.width / 2)).toBeGreaterThanOrEqual(20);
  expect(countPixels(png, isWheelPixel, png.width / 2, png.width)).toBeGreaterThanOrEqual(20);

  // 保存：导出全量项目 JSON（写入 localStorage 供宿主重开）
  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(exported.objects.filter((o: { type: string }) => o.type === 'model')).toHaveLength(2);
  expect(exported.assets).toHaveLength(1);

  // 全新运行时重开：reload 清空会话，宿主按钮以导出 JSON 重建项目
  await page.reload();
  await expect(page.getByTestId('lumora-studio')).toBeVisible();
  await page.getByTestId('reopen-last-export').click();
  await expect(rows).toHaveCount(2);

  // 数据一致：实例 2 的变换恢复；渲染一致：两实例像素仍在（seed 重建内容）
  await rows.nth(1).click();
  await expect(page.getByTestId('inspector-axis-0')).toHaveValue('3.5');
  await page.keyboard.press('Escape');
  await pollCount(page, isWheelPixel).toBeGreaterThanOrEqual(60);
  const reopened = await viewportPng(page);
  expect(countPixels(reopened, isWheelPixel, 0, reopened.width / 2)).toBeGreaterThanOrEqual(20);
  expect(countPixels(reopened, isWheelPixel, reopened.width / 2, reopened.width)).toBeGreaterThanOrEqual(20);
  expect(countPixels(reopened, isPlaceholderPixel)).toBe(0);
});

test('R6 目录导入：嵌套目录相对路径保留，编码 URI 真机解析成功', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumora-gltf-'));
  try {
    const { gltf, bin } = buildTriangleGltf('textures/my%20tex.png');
    writeFileSync(join(dir, 'model.gltf'), gltf);
    writeFileSync(join(dir, 'mesh.bin'), bin);
    mkdirSync(join(dir, 'textures'), { recursive: true });
    writeFileSync(join(dir, 'textures/my tex.png'), ONE_PIXEL_PNG);
    // 目录选择：Playwright 以目录路径填充 webkitdirectory 输入，
    // 浏览器按目录相对结构给出 webkitRelativePath（真机等价）
    await page.getByTestId('toolbar-model-dir-input').setInputFiles(dir);
    await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');
    const row = page.locator('.lumora-tree-row', { hasText: 'model' });
    await expect(row).toBeVisible();

    // 内容真实挂载：三角形红色像素出现（不依赖占位框）
    await pollCount(page, isTriPixel).toBeGreaterThanOrEqual(20);

    // 保留嵌套目录相对路径：parts 路径是 textures/my tex.png，而非 basename
    const downloadPromise = page.waitForEvent('download');
    await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
    const download = await downloadPromise;
    const stream = await download.createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const asset = exported.assets[0];
    expect(asset.parts.map((p: { path: string }) => p.path)).toEqual([
      'mesh.bin',
      'textures/my tex.png',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('R6 目录导入：重复 basename 真机歧义必须失败', async ({ page }) => {
  const dir = mkdtempSync(join(tmpdir(), 'lumora-gltf-amb-'));
  try {
    const { gltf, bin } = buildTriangleGltf('tex.png'); // 裸 basename，两个目录各有一份
    writeFileSync(join(dir, 'scene.gltf'), gltf);
    writeFileSync(join(dir, 'mesh.bin'), bin);
    mkdirSync(join(dir, 'a'), { recursive: true });
    mkdirSync(join(dir, 'b'), { recursive: true });
    writeFileSync(join(dir, 'a/tex.png'), ONE_PIXEL_PNG);
    writeFileSync(join(dir, 'b/tex.png'), ONE_PIXEL_PNG);

    await page.getByTestId('toolbar-model-dir-input').setInputFiles(dir);
    await expect(page.getByTestId('lumora-toasts')).toContainText('依赖文件歧义：tex.png');
    await expect(page.locator('.lumora-tree-row', { hasText: 'scene' })).toHaveCount(0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
