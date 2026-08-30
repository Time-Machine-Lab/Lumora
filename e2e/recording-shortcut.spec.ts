import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

async function readStoredRecording(page: Page): Promise<{ revision: number; keyframes: number } | null> {
  return page.evaluate(
    () =>
      new Promise<{ revision: number; keyframes: number } | null>((resolve) => {
        const open = indexedDB.open('lumora-studio');
        open.onerror = () => resolve(null);
        open.onsuccess = () => {
          const db = open.result;
          const request = db.transaction('projects', 'readonly').objectStore('projects').get('lumora://sample-project');
          request.onerror = () => {
            db.close();
            resolve(null);
          };
          request.onsuccess = () => {
            const project = request.result?.project as
              | { revision?: number; tracks?: Array<{ keyframes?: unknown[] }> }
              | undefined;
            db.close();
            resolve(
              project
                ? {
                    revision: project.revision ?? -1,
                    keyframes: project.tracks?.reduce((total, track) => total + (track.keyframes?.length ?? 0), 0) ?? 0,
                  }
                : null,
            );
          };
        };
      }),
  );
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.evaluate(() => localStorage.removeItem('lumora.recording-shortcut.v1'));
  await page.reload();
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-camera')).toBeVisible();
});

test('default recording shortcut and reserved-shortcut validation stay aligned', async ({ page }) => {
  const record = page.getByTestId('timeline-record');
  await expect(record).toHaveAttribute('title', /Shift\+R/);
  await page.getByTestId('tree-row-sample-camera').click();
  await page.keyboard.press('Shift+R');
  await expect(page.getByTestId('overwrite-confirm')).toBeVisible();
  await page.getByText('取消').click();

  await page.getByTestId('recording-shortcut-settings').click();
  const dialog = page.getByTestId('recording-shortcut-dialog');
  await dialog.getByTestId('recording-shortcut-key').selectOption('w');
  await dialog.getByLabel('Ctrl', { exact: true }).check();
  await dialog.getByLabel('Shift', { exact: true }).uncheck();

  await expect(dialog.getByRole('alert')).toContainText('Ctrl+W');
  await expect(dialog.getByTestId('recording-shortcut-save')).toBeDisabled();
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('lumora.recording-shortcut.v1')))
    .toBeNull();

  await dialog.getByTestId('recording-shortcut-key').selectOption('r');
  await dialog.getByLabel('Alt', { exact: true }).check();
  await dialog.getByTestId('recording-shortcut-save').click();
  await expect(record).toHaveAttribute('title', /Ctrl\+Alt\+R/);
  await expect
    .poll(() => page.evaluate(() => localStorage.getItem('lumora.recording-shortcut.v1')))
    .toBe('Ctrl+Alt+R');

  await page.reload();
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('timeline-record')).toHaveAttribute('title', /Ctrl\+Alt\+R/);
  await page.getByTestId('tree-row-sample-camera').click();
  await page.keyboard.press('Control+Alt+R');
  await expect(page.getByTestId('overwrite-confirm')).toBeVisible();
});

test('active recordings prompt before tab close while saved projects close and restore normally', async ({ page, context }) => {
  await page.getByTestId('tree-row-sample-camera').click();
  await page.keyboard.press('Shift+R');
  await page.getByText('覆盖录制').click();
  const record = page.getByTestId('timeline-record');
  await expect(record).toHaveText('■');

  const warning = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const dialog = await warning;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  expect(page.isClosed()).toBe(false);

  if ((await record.textContent()) === '▶') {
    await page.keyboard.press('Shift+R');
    await expect(record).toHaveText('■');
  }
  await page.keyboard.press('Shift+R');
  await expect(record).toHaveText('●');
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });
  const storedBeforeClose = await readStoredRecording(page);
  expect(storedBeforeClose?.revision).toBeGreaterThan(0);
  expect(storedBeforeClose?.keyframes).toBeGreaterThan(0);

  let unexpectedDialog = false;
  page.once('dialog', async (nextDialog) => {
    unexpectedDialog = true;
    await nextDialog.dismiss();
  });
  await page.close({ runBeforeUnload: true });
  await expect.poll(() => page.isClosed()).toBe(true);
  expect(unexpectedDialog).toBe(false);

  const restoredPage = await context.newPage();
  await restoredPage.goto('/');
  await expect.poll(() => readStoredRecording(restoredPage)).toEqual(storedBeforeClose);
  await restoredPage.getByTestId('project-menu').click();
  await expect(restoredPage.getByTestId('recent-project')).toContainText('示例项目');
  await restoredPage.locator('[data-testid="recent-project"] .lumora-project-menu__recent-open').click();
  await expect(restoredPage.getByTestId('timeline-record')).toBeVisible();
});
