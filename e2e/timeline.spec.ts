import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

/** 标签列宽度（px），与 TimelinePanel 导出的 TIMELINE_LABEL_WIDTH 一致；
 *  播放头 = 标签列 + time * zoom，关键帧/分镜/标尺刻度 = time * zoom（时间画布内） */
const LABEL_WIDTH = 186;

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
});

/** 解析「00:00.00」时间显示 → 秒 */
async function timeSeconds(page: Page): Promise<number> {
  const text = await page.getByTestId('timeline-time').textContent();
  const m = /(\d+):(\d+)\.(\d+)/.exec(text ?? '');
  if (!m) throw new Error(`无法解析时间显示: ${text}`);
  return Number(m[1]) * 60 + Number(m[2]) + Number(m[3]) / 100;
}

/** 选中主摄像机 → 录制（示例项目已有录制轨道 → 覆盖确认）→ 进入录制态 */
async function startRecording(page: Page): Promise<void> {
  await page.getByTestId('tree-row-sample-camera').click();
  await page.getByTestId('timeline-record').click();
  await expect(page.getByTestId('overwrite-confirm')).toBeVisible();
  await page.getByText('覆盖录制').click();
  await expect(page.getByTestId('timeline-record')).toHaveText('■');
}

/** 隐藏视口上的 DOM 覆盖层（工具条/辅助线），让 canvas 截图只含 WebGL 像素 */
async function hideViewportOverlays(page: Page): Promise<void> {
  for (const testid of ['viewport-toolbar', 'lumora-guides']) {
    const overlay = page.getByTestId(testid);
    if ((await overlay.count()) > 0) {
      await overlay.evaluate((el) => {
        (el as HTMLElement).style.display = 'none';
      });
    }
  }
}

/** 画布截图：先等一帧渲染（seek/暂停后场景经 rAF 重绘） */
async function canvasShot(page: Page): Promise<Buffer> {
  await page.waitForTimeout(120);
  return page.locator('.lumora-viewport canvas').screenshot();
}

/** 播放头横向位置（行内 px，含标签列）：186 + time * zoom */
async function playheadPx(page: Page): Promise<number> {
  return page.getByTestId('timeline-playhead').evaluate((el) => parseFloat((el as HTMLElement).style.left));
}

/** 当前 zoom：点击时刻为 kfTime 的关键帧后由播放头位置反推（吸附应已关闭，跳转精确） */
async function measureZoom(page: Page, kfTestId: string, kfTime: number): Promise<number> {
  await page.getByTestId(kfTestId).click();
  const zoom = (await playheadPx(page) - LABEL_WIDTH) / kfTime;
  expect(zoom).toBeGreaterThan(20); // 合理性：默认 ~64 px/s
  return zoom;
}

/** 在标尺上点击时刻 t（吸附关闭时精确）：先把目标时刻滚动到时间线可见范围
 *  （画布内坐标 = 标签列 + time * zoom），再以时间画布的实时视口矩形计算点击位，
 *  与面板 seekFromEvent 使用同一坐标空间 */
async function seekByRuler(page: Page, t: number, zoom: number): Promise<void> {
  const body = page.getByTestId('timeline-body');
  await body.evaluate((el, targetX) => {
    el.scrollLeft = Math.max(0, targetX - el.clientWidth / 2);
  }, 186 + t * zoom);
  const timeArea = page.locator('[data-testid="timeline-ruler"] .lumora-timeline__time-area');
  const box = await timeArea.boundingBox();
  if (!box) throw new Error('标尺不可见');
  await page.mouse.click(box.x + t * zoom, box.y + box.height / 2);
}

async function shotLeft(page: Page, shotId: string): Promise<number> {
  return page.getByTestId(`shot-block-${shotId}`).evaluate((el) => parseFloat((el as HTMLElement).style.left));
}

async function expectShotLeft(page: Page, shotId: string, expectedPx: number): Promise<void> {
  const actual = await shotLeft(page, shotId);
  expect(Math.abs(actual - expectedPx)).toBeLessThan(1);
}

test('AC1 浏览器级：真实约 5s 持续驾驶录制 → 抽稀覆盖轨道 → 两次回放位姿/画面逐像素一致', async ({ page }) => {
  await page.getByTestId('view-mode-select').selectOption('sample-camera'); // 主摄像机 POV
  await startRecording(page);

  // 真实约 5s 持续驾驶输入（KeyW 按住）：录制后半段驾驶输入不被清空（审查第 1 项）
  await page.keyboard.down('w');
  await page.waitForTimeout(5000);
  await page.keyboard.up('w');
  await page.getByTestId('timeline-record').click(); // ■ = 停止
  await expect(page.getByTestId('timeline-time')).toHaveText('00:00.00');

  // 位置轨道被抽稀覆盖：2-10 个关键帧、首帧≈0、末帧≈5s；旧 4s 关键帧消失
  const dollyKfs = page.locator('[data-testid^="keyframe-sample-track-camera-dolly-"]');
  const kfCount = await dollyKfs.count();
  expect(kfCount).toBeGreaterThanOrEqual(2);
  expect(kfCount).toBeLessThanOrEqual(10);
  await expect(page.getByTestId('keyframe-sample-track-camera-dolly-4')).toHaveCount(0);
  const kfTimes = await dollyKfs.evaluateAll((els) =>
    els.map((el) =>
      Number(/keyframe-sample-track-camera-dolly-([0-9.]+)$/.exec(el.getAttribute('data-testid') ?? '')?.[1]),
    ),
  );
  expect(Math.min(...kfTimes)).toBeLessThan(0.1);
  const lastKfTime = Math.max(...kfTimes);
  expect(lastKfTime).toBeGreaterThan(4.7);
  expect(lastKfTime).toBeLessThan(5.6);

  // 关闭吸附 → 坐标换算精确
  await page.getByTestId('timeline-snap').setChecked(false);
  const zoom = await measureZoom(page, `keyframe-sample-track-camera-dolly-${lastKfTime}`, lastKfTime);

  // 回到起点 → 起点画面
  await seekByRuler(page, 0.02, zoom);
  await hideViewportOverlays(page);
  const s0 = await canvasShot(page);

  // 第一次回放：播放推进 → 暂停 → 画面与起点不同
  await page.getByTestId('timeline-play').click();
  await page.waitForTimeout(800);
  await page.getByTestId('timeline-play').click(); // 暂停
  const tA = await timeSeconds(page);
  expect(tA).toBeGreaterThan(0.6);
  const pApx = await playheadPx(page);
  const pA = await canvasShot(page);
  expect(pA.equals(s0)).toBe(false);

  // 审查第 2 项：暂停画面与播放头一致 —— 标尺拖到播放头同一像素位 → 时间一致、画面逐像素一致
  await seekByRuler(page, (pApx - LABEL_WIDTH) / zoom, zoom);
  await expect.poll(() => timeSeconds(page)).toBeCloseTo(tA, 1);
  const pA2 = await canvasShot(page);
  expect(pA2.equals(pA)).toBe(true);

  // 第二次回放：同样从起点播放 → 暂停点一致（回放时钟 1:1）
  await seekByRuler(page, 0.02, zoom);
  await page.getByTestId('timeline-play').click();
  await page.waitForTimeout(800);
  await page.getByTestId('timeline-play').click();
  const tB = await timeSeconds(page);
  expect(Math.abs(tB - tA)).toBeLessThan(0.15);

  // 两次回放同一时刻 → 位姿/画面逐像素一致
  await seekByRuler(page, (pApx - LABEL_WIDTH) / zoom, zoom);
  await expect.poll(() => timeSeconds(page)).toBeCloseTo(tA, 1);
  const pB = await canvasShot(page);
  expect(pB.equals(pA)).toBe(true);
});

test('AC2 浏览器级：按住驾驶键时页面失焦 → 相机 transform 冻结（录制暂停、画面逐像素不变）', async ({ page }) => {
  await page.getByTestId('view-mode-select').selectOption('sample-camera');
  await startRecording(page);
  await hideViewportOverlays(page);
  const s0 = await canvasShot(page);

  // 按住驾驶键（KeyS 后退）：相机持续后移，场景物体保持可见 —— 位移在画面上
  // 显著可辨（前进会很快把物体推出视锥，只剩纯色地面，位移不可见）
  await page.keyboard.down('s');
  await page.waitForTimeout(600);
  const moving = await canvasShot(page);
  expect(moving.equals(s0)).toBe(false); // 画面持续变化（相机在动）

  // 按键仍按住、驾驶仍在推进时失焦：驾驶硬停 + 录制暂停 —— 相机 transform
  // 冻结在失焦瞬间（与 moving 帧之间隔了 300ms 的持续驾驶，位移必定可辨）
  await page.waitForTimeout(300);
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByTestId('timeline-record')).toHaveText('▶'); // 进入暂停态
  await page.waitForTimeout(600);
  const frozen1 = await canvasShot(page);
  await page.waitForTimeout(400);
  const frozen2 = await canvasShot(page);
  expect(frozen2.equals(frozen1)).toBe(true); // 期间零位移（transform 冻结）
  expect(frozen1.equals(moving)).toBe(false); // 冻结在失焦瞬间的画面，而非失焦前

  // 松开按键 → 恢复录制 → 停止
  await page.keyboard.up('s');
  await page.getByTestId('timeline-record').click(); // ▶ = 恢复
  await expect(page.getByTestId('timeline-record')).toHaveText('■');
  await page.waitForTimeout(200);
  await page.getByTestId('timeline-record').click(); // 停止
});

test('AC3 浏览器级：关键帧间平滑插值 —— 中间帧与端点帧互不相同、同时刻确定性一致', async ({ page }) => {
  await page.getByTestId('view-mode-select').selectOption('sample-camera');
  await page.getByTestId('timeline-snap').setChecked(false); // 精确坐标换算
  await hideViewportOverlays(page);

  const zoom = await measureZoom(page, 'keyframe-sample-track-camera-dolly-2', 2);
  const at = async (t: number) => {
    if (t === 0 || t === 2 || t === 4) {
      await page.getByTestId(`keyframe-sample-track-camera-dolly-${t}`).click();
    } else {
      await seekByRuler(page, t, zoom);
    }
    return canvasShot(page);
  };

  // 端点画面互不相同（推镜路径：z 7 → 4.5 → 3 + 焦距 50 → 35）
  const s0 = await at(0);
  const s2 = await at(2);
  const s4 = await at(4);
  expect(s0.equals(s2)).toBe(false);
  expect(s2.equals(s4)).toBe(false);
  expect(s0.equals(s4)).toBe(false);

  // 中间帧：与相邻端点均不同（插值生效，而非端点保持）
  const s1 = await at(1);
  const s3 = await at(3);
  expect(s1.equals(s0)).toBe(false);
  expect(s1.equals(s2)).toBe(false);
  expect(s3.equals(s2)).toBe(false);
  expect(s3.equals(s4)).toBe(false);

  // 确定性：同一时刻两次 seek → 画面逐像素一致
  const s2Again = await at(2);
  expect(s2Again.equals(s2)).toBe(true);

  // 关键帧点击精确定位到该帧时间
  await page.getByTestId('keyframe-sample-track-camera-dolly-0').click();
  await expect(page.getByTestId('timeline-time')).toHaveText('00:00.00');
  await page.getByTestId('keyframe-sample-track-camera-dolly-2').click();
  await expect(page.getByTestId('timeline-time')).toHaveText('00:02.00');
});

test('AC4 浏览器级：分镜区段坐标与机位绑定 → 重排原子重算 → 重开一致', async ({ page }) => {
  const zoom = await measureZoom(page, 'keyframe-sample-track-camera-dolly-2', 2);

  // 初始区段坐标：时间画布内 startTime * zoom —— 0 / 1.5s / 3s
  await expectShotLeft(page, 'sample-shot-1', 0);
  await expectShotLeft(page, 'sample-shot-2', 1.5 * zoom);
  await expectShotLeft(page, 'sample-shot-3', 3 * zoom);
  // 机位绑定：区块 title「机位：主摄像机」
  for (const shotId of ['sample-shot-1', 'sample-shot-2', 'sample-shot-3']) {
    await expect(page.getByTestId(`shot-block-${shotId}`)).toHaveAttribute('title', '机位：主摄像机');
  }

  // 重排 1 → 右移两次 → [2, 3, 1]：区段时间按新顺序原子重算（视觉/时间顺序同变，审查第 3 项）
  await page.getByTestId('shot-move-right-sample-shot-1').click();
  await page.getByTestId('shot-move-right-sample-shot-1').click();
  await expectShotLeft(page, 'sample-shot-2', 0);
  await expectShotLeft(page, 'sample-shot-3', 1.5 * zoom);
  await expectShotLeft(page, 'sample-shot-1', 3 * zoom);
  // 机位绑定随分镜保留
  for (const shotId of ['sample-shot-1', 'sample-shot-2', 'sample-shot-3']) {
    await expect(page.getByTestId(`shot-block-${shotId}`)).toHaveAttribute('title', '机位：主摄像机');
  }

  // 保存 → 刷新重开 → 顺序/区段坐标/机位绑定一致（AC4 重开持久）
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 10_000 });
  await page.reload();
  await page.getByTestId('project-menu').click();
  await page
    .locator('[data-testid="recent-project"]')
    .filter({ hasText: '示例项目' })
    .locator('.lumora-project-menu__recent-open')
    .click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  const order = () =>
    page
      .locator('[data-testid^="shot-block-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(await order()).toEqual([
    'shot-block-sample-shot-2',
    'shot-block-sample-shot-3',
    'shot-block-sample-shot-1',
  ]);
  const zoom2 = await measureZoom(page, 'keyframe-sample-track-camera-dolly-2', 2);
  await expectShotLeft(page, 'sample-shot-2', 0);
  await expectShotLeft(page, 'sample-shot-3', 1.5 * zoom2);
  await expectShotLeft(page, 'sample-shot-1', 3 * zoom2);
  for (const shotId of ['sample-shot-1', 'sample-shot-2', 'sample-shot-3']) {
    await expect(page.getByTestId(`shot-block-${shotId}`)).toHaveAttribute('title', '机位：主摄像机');
  }
});

test('G 一般项：375px 窄视口 —— 运输控制完整可见可点、时间轴横向滚动收纳于内部', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });

  // 页面无横向溢出（窄屏布局纵向堆叠）
  const hOverflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(hOverflow).toBeLessThanOrEqual(0);

  // 运输控制完整可见（flex-wrap 收纳，不被裁剪）
  await expect(page.getByTestId('timeline-play')).toBeVisible();
  await expect(page.getByTestId('timeline-record')).toBeVisible();
  await expect(page.getByTestId('timeline-snap')).toBeVisible();
  await expect(page.getByTestId('timeline-time')).toBeVisible();

  // 时间轴内容横向滚动收纳在面板内部，不撑破页面
  const internalScroll = await page
    .getByTestId('timeline-body')
    .evaluate((el) => el.scrollWidth > el.clientWidth);
  expect(internalScroll).toBe(true);

  // 播放控制可用：点击后时间推进
  await page.getByTestId('timeline-play').click();
  await page.waitForTimeout(400);
  expect(await timeSeconds(page)).toBeGreaterThan(0.25);
});
