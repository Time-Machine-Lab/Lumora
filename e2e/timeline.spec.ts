import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

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

test('AC1 浏览器级：录制 → 抽稀覆盖轨道 → 停止回 0 → 可重复回放', async ({ page }) => {
  await startRecording(page);
  await page.waitForTimeout(1600);
  const during = await timeSeconds(page);
  expect(during).toBeGreaterThan(1.2); // 录制中播放头持续前进

  // 停止：播放头归零；位置轨道被抽稀覆盖（旧 4s 关键帧消失，仅剩录制两端）
  await page.getByTestId('timeline-record').click(); // ■ = 停止
  await expect(page.getByTestId('timeline-time')).toHaveText('00:00.00');
  await expect(page.locator('[data-testid^="keyframe-sample-track-camera-dolly-"]')).toHaveCount(2);
  await expect(page.getByTestId('keyframe-sample-track-camera-dolly-4')).toHaveCount(0);

  // 回放可重复：播放推进 → 暂停冻结 → 再次播放从暂停点继续
  await page.getByTestId('timeline-play').click();
  await page.waitForTimeout(500);
  const t1 = await timeSeconds(page);
  expect(t1).toBeGreaterThan(0.3);
  await page.getByTestId('timeline-play').click(); // 暂停
  await page.waitForTimeout(200);
  const t2 = await timeSeconds(page);
  expect(Math.abs(t2 - t1)).toBeLessThan(0.15); // 暂停冻结
  await page.getByTestId('timeline-play').click();
  await page.waitForTimeout(500);
  const t3 = await timeSeconds(page);
  expect(t3 - t2).toBeGreaterThan(0.3); // 继续推进
});

test('AC2 浏览器级：录制中页面失焦 → 时间冻结零漂移；恢复后继续', async ({ page }) => {
  await startRecording(page);
  await page.waitForTimeout(400);
  const before = await timeSeconds(page);

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByTestId('timeline-record')).toHaveText('▶'); // 进入暂停态
  await page.waitForTimeout(700);
  const frozen = await timeSeconds(page);
  expect(Math.abs(frozen - before)).toBeLessThan(0.15); // 失焦期间无失控位移

  // 恢复录制：继续采样推进
  await page.getByTestId('timeline-record').click(); // ▶ = 恢复
  await expect(page.getByTestId('timeline-record')).toHaveText('■');
  await page.waitForTimeout(400);
  const resumed = await timeSeconds(page);
  expect(resumed - frozen).toBeGreaterThan(0.25);
  await page.getByTestId('timeline-record').click(); // 停止收尾
});

test('AC3 浏览器级：关键帧点击与标尺拖拽定位到确定性时间', async ({ page }) => {
  // 关键帧菱形点击 → 精确跳转
  await page.getByTestId('keyframe-sample-track-camera-dolly-2').click();
  await expect(page.getByTestId('timeline-time')).toHaveText('00:02.00');
  await page.getByTestId('keyframe-sample-track-camera-dolly-0').click();
  await expect(page.getByTestId('timeline-time')).toHaveText('00:00.00');

  // 标尺拖拽：中点位按下 → 左移到 1/4 位抬起 → 时间落在 (0, 4.5) 且小于中点对应值
  const ruler = page.getByTestId('timeline-ruler');
  const box = (await ruler.boundingBox())!;
  const midX = box.x + box.width * 0.5;
  const y = box.y + box.height / 2;
  await page.mouse.move(midX, y);
  await page.mouse.down();
  const midTime = await timeSeconds(page);
  expect(midTime).toBeGreaterThan(0);
  await page.mouse.move(midX - box.width * 0.25, y, { steps: 4 });
  await page.mouse.up();
  const leftTime = await timeSeconds(page);
  expect(leftTime).toBeLessThan(midTime);
  expect(leftTime).toBeLessThan(4.5); // 项目时长内
});

test('AC4 浏览器级：分镜重排 → 自动保存 → 刷新重开后顺序一致', async ({ page }) => {
  const order = () =>
    page
      .locator('[data-testid^="shot-block-"]')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-testid')));
  expect(await order()).toEqual([
    'shot-block-sample-shot-1',
    'shot-block-sample-shot-2',
    'shot-block-sample-shot-3',
  ]);

  // 相邻交换：1 → 右移两次 → [2, 3, 1]
  await page.getByTestId('shot-move-right-sample-shot-1').click();
  await page.getByTestId('shot-move-right-sample-shot-1').click();
  expect(await order()).toEqual([
    'shot-block-sample-shot-2',
    'shot-block-sample-shot-3',
    'shot-block-sample-shot-1',
  ]);

  // 等待自动保存落盘
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 10_000 });

  // 刷新 → 从最近项目重开 → 顺序一致（AC4 重开持久）
  await page.reload();
  await page.getByTestId('project-menu').click();
  await page
    .locator('[data-testid="recent-project"]')
    .filter({ hasText: '示例项目' })
    .locator('.lumora-project-menu__recent-open')
    .click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  expect(await order()).toEqual([
    'shot-block-sample-shot-2',
    'shot-block-sample-shot-3',
    'shot-block-sample-shot-1',
  ]);
});
