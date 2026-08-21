import { expect, test } from '@playwright/test';
import { buildGlbWithBin } from './helpers/glb';
import { SUMMARY_CHAR_BUDGET } from '../examples/embedded-host/src/summarize';

/**
 * TML-87 回归：onAny 不再序列化完整 payload。
 * 大载荷（base64 资源）导入 + 变换后，默认日志只含摘要；
 * 仅 ?debug=full 时输出完整 payload。
 */
const LEAK_CHECK_GLB = buildGlbWithBin(2 * 1024 * 1024);
const GLB_BASE64_PREFIX = LEAK_CHECK_GLB.toString('base64').slice(0, 100);

async function openSampleProject(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('open-sample-project').click();
  await page.getByTestId('tree-row-sample-group').waitFor();
}

async function importGlb(page: import('@playwright/test').Page): Promise<void> {
  await page.getByTestId('toolbar-model-file-input').setInputFiles({
    name: 'leak-check.glb',
    mimeType: 'model/gltf-binary',
    buffer: LEAK_CHECK_GLB,
  });
  await expect(page.getByTestId('lumora-toasts')).toContainText('已导入模型');
}

async function countProjectChanged(page: import('@playwright/test').Page): Promise<number> {
  const text = await page.getByTestId('event-log').innerText();
  return text.split('\n').filter((line) => line.startsWith('project:changed ')).length;
}

test('默认模式：导入大模型并变换后，事件日志只含摘要，无 base64 载荷', async ({ page }) => {
  await page.goto('/');
  await openSampleProject(page);
  await importGlb(page);

  // 导入即产生一次 project:changed；等 React 渲染落盘后取基线
  await expect.poll(() => countProjectChanged(page)).toBeGreaterThanOrEqual(1);
  const afterImport = await countProjectChanged(page);

  // 三次变换提交，每次 project:changed 载荷含整段 base64
  for (let i = 1; i <= 3; i++) {
    await page.getByTestId('tree-row-sample-cube').click();
    await page.getByTestId('inspector-axis-0').fill(String(i));
    await page.getByTestId('inspector-axis-0').press('Enter');
  }

  // 三次变换恰好新增三条 project:changed（无遗漏也无多余事件）
  await expect.poll(() => countProjectChanged(page)).toBe(afterImport + 3);
  // 最后一次输入已提交生效（值写入项目内容，而非仅留在输入框）
  await expect(page.getByTestId('inspector-axis-0')).toHaveValue('3');

  const logText = await page.getByTestId('event-log').innerText();
  // 摘要行不含已知 base64 载荷前缀，也无超过 150 字符的 base64 连续串
  expect(logText).not.toContain(GLB_BASE64_PREFIX);
  expect(logText.match(/[A-Za-z0-9+/]{150,}/g)).toBeNull();
  // 摘要行不超共享预算（2MB GLB 的 base64 ≈ 2.7M 字符，完整序列化已被杜绝）
  const maxLine = Math.max(...logText.split('\n').map((line) => line.length));
  expect(maxLine).toBeLessThanOrEqual(SUMMARY_CHAR_BUDGET);
  // 50 行保留上限仍生效
  expect(logText.split('\n').length).toBeLessThanOrEqual(50);
});

test('?debug=full：输出完整 payload，行为与修复前一致', async ({ page }) => {
  await page.goto('/?debug=full');
  await openSampleProject(page);
  await expect(page.getByTestId('event-log')).toContainText('完整 payload 模式');
  await importGlb(page);

  const logText = await page.getByTestId('event-log').innerText();
  expect(logText).toContain('project:changed');
  // 完整 payload 行包含整段 base64：已知前缀与尾缀都在日志中，证明载荷完整无截断
  const GLB_BASE64 = LEAK_CHECK_GLB.toString('base64');
  expect(logText).toContain(GLB_BASE64.slice(0, 100));
  expect(logText).toContain(GLB_BASE64.slice(-100));
  expect(logText).toContain(GLB_BASE64);
  // 完整 payload 行包含整段 base64（远大于摘要上限）
  const maxLine = Math.max(...logText.split('\n').map((line) => line.length));
  expect(maxLine).toBeGreaterThan(1_000_000);
  expect(maxLine).toBeGreaterThan(GLB_BASE64.length);
});
