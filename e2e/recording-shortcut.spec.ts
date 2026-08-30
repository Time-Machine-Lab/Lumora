import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';

interface TrackFingerprint {
  id: string;
  objectId: string;
  targetPath: string;
  keyframes: Array<{ time: number; value: string }>;
}

interface ProjectFingerprint {
  revision: number;
  tracks: TrackFingerprint[];
}

interface RenderedTrackFingerprint {
  id: string;
  targetPath: string;
  keyframes: Array<{ time: string; value: string }>;
}

async function readStoredRecording(page: Page): Promise<ProjectFingerprint | null> {
  return page.evaluate(
    () =>
      new Promise<ProjectFingerprint | null>((resolve) => {
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
              | {
                  revision?: number;
                  tracks?: Array<{
                    id?: string;
                    objectId?: string;
                    targetPath?: string;
                    keyframes?: Array<{ time?: number; value?: unknown }>;
                  }>;
                }
              | undefined;
            db.close();
            resolve(
              project
                ? {
                    revision: project.revision ?? -1,
                    tracks: (project.tracks ?? []).map((track) => ({
                      id: track.id ?? '',
                      objectId: track.objectId ?? '',
                      targetPath: track.targetPath ?? '',
                      keyframes: (track.keyframes ?? []).map((keyframe) => ({
                        time: keyframe.time ?? -1,
                        value: JSON.stringify(keyframe.value ?? null),
                      })),
                    })),
                  }
                : null,
            );
          };
        };
      }),
  );
}

function renderedProjection(fingerprint: ProjectFingerprint): RenderedTrackFingerprint[] {
  return fingerprint.tracks.map((track) => ({
    id: track.id,
    targetPath: track.targetPath,
    keyframes: track.keyframes.map((keyframe) => ({
      time: String(keyframe.time),
      value: keyframe.value,
    })),
  }));
}

async function readRenderedTimelineFingerprint(page: Page): Promise<RenderedTrackFingerprint[]> {
  return page.locator('[data-testid^="track-lane-"]').evaluateAll((nodes) =>
    nodes.map((node) => {
      const testId = node.getAttribute('data-testid') ?? '';
      const id = testId.slice('track-lane-'.length);
      return {
        id,
        targetPath: node.getAttribute('data-track-target-path') ?? '',
        keyframes: Array.from(node.querySelectorAll('[data-testid^="keyframe-"]')).map((keyframe) => ({
          time: (keyframe.getAttribute('data-testid') ?? '').slice(`keyframe-${id}-`.length),
          value: keyframe.getAttribute('data-keyframe-value') ?? '',
        })),
      };
    }),
  );
}

async function openRecentProject(page: Page): Promise<void> {
  await page.getByTestId('project-menu').click();
  await expect(page.getByTestId('recent-project')).toContainText('示例项目');
  await page.locator('[data-testid="recent-project"] .lumora-project-menu__recent-open').click();
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

test('accepting beforeunload discards active uncommitted recording samples', async ({ page, context }) => {
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });
  const baseline = await readStoredRecording(page);
  expect(baseline).not.toBeNull();

  await page.getByTestId('tree-row-sample-camera').click();
  await page.keyboard.press('Shift+R');
  await page.getByText('覆盖录制').click();
  const record = page.getByTestId('timeline-record');
  await expect(record).toHaveText('■');
  await page.keyboard.down('w');
  await page.waitForTimeout(300);
  await page.keyboard.up('w');
  await expect(page.getByTestId('timeline-time')).not.toHaveText('00:00.00');
  expect(await readStoredRecording(page)).toEqual(baseline);

  const warning = page.waitForEvent('dialog');
  await page.close({ runBeforeUnload: true });
  const dialog = await warning;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.accept();
  await expect.poll(() => page.isClosed()).toBe(true);

  const restoredPage = await context.newPage();
  await restoredPage.goto('/');
  await expect.poll(() => readStoredRecording(restoredPage)).toEqual(baseline);
  await openRecentProject(restoredPage);
  await expect.poll(() => readRenderedTimelineFingerprint(restoredPage)).toEqual(renderedProjection(baseline!));
});

test('saved recordings restore the same track and keyframe fingerprint after reopening', async ({ page, context }) => {
  const baseline = await readStoredRecording(page);
  expect(baseline).not.toBeNull();
  await page.getByTestId('tree-row-sample-camera').click();
  await page.keyboard.press('Shift+R');
  await page.getByText('覆盖录制').click();
  const record = page.getByTestId('timeline-record');
  await expect(record).toHaveText('■');
  await page.keyboard.down('w');
  await page.waitForTimeout(300);
  await page.keyboard.up('w');
  await page.keyboard.press('Shift+R');
  await expect(record).toHaveText('●');
  await expect(page.getByTestId('save-state-badge')).toHaveText('已保存', { timeout: 6000 });
  const storedBeforeClose = await readStoredRecording(page);
  expect(storedBeforeClose).not.toBeNull();
  expect(storedBeforeClose).not.toEqual(baseline);
  expect(storedBeforeClose!.tracks.flatMap((track) => track.keyframes).length).toBeGreaterThan(0);

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
  await openRecentProject(restoredPage);
  await expect.poll(() => readRenderedTimelineFingerprint(restoredPage)).toEqual(
    renderedProjection(storedBeforeClose!),
  );
});
