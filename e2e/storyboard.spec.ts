import { expect, test } from '@playwright/test';
import type { Download, Page } from '@playwright/test';

async function readDownload(download: Download): Promise<string> {
  const stream = await download.createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function openStoryboard(page: Page): Promise<void> {
  await page.getByTestId('open-storyboard-workspace').click();
  await expect(page.getByTestId('storyboard-workspace')).toBeVisible();
  await expect(page.getByTestId('storyboard-provider')).toHaveValue('com.lumora.mock.ai');
}

async function configureOpenAi(
  page: Page,
  endpoint: string,
  model: string,
  apiKey = '',
): Promise<void> {
  await page.getByTestId('panel-tab-com.lumora.openai.compatible.settings').click();
  await page.getByTestId('openai-endpoint').fill(endpoint);
  await page.getByTestId('openai-model').fill(model);
  await page.getByTestId('openai-api-key').fill(apiKey);
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
}

async function openOpenAiStoryboard(page: Page, model: string): Promise<void> {
  await openStoryboard(page);
  await page.getByTestId('storyboard-provider').selectOption('com.lumora.openai.compatible.ai');
  await expect(page.getByTestId('storyboard-model')).toHaveValue(model);
  await page.getByTestId('storyboard-concept').fill(
    'A courier crosses a neon market while protecting a mysterious case.',
  );
}

const COMPATIBLE_DRAFT = {
  title: 'Compatible endpoint storyboard',
  summary: 'Three structured shots from a route-backed compatible endpoint.',
  shots: [
    { title: 'Market arrival', shotSize: 'wide', movement: 'dolly-in', durationSeconds: 4, prompt: 'Rainy market arrival.' },
    { title: 'Courier pursuit', shotSize: 'medium', movement: 'tracking', durationSeconds: 4, prompt: 'Track beside the courier.' },
    { title: 'Case reveal', shotSize: 'close-up', movement: 'static', durationSeconds: 4, prompt: 'Reveal the protected case.' },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.getByTestId('open-sample-project').click();
  await expect(page.getByTestId('tree-row-sample-cube')).toBeVisible();
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(3);
});

test('generates three validated shots and adopts them with editable metadata in one project update', async ({ page }) => {
  await openStoryboard(page);
  await page.getByTestId('storyboard-concept').fill('A courier crosses a neon market while protecting a mysterious case.');
  await expect(page.getByTestId('storyboard-cost-hint')).toContainText('0.00 USD');
  await page.getByTestId('storyboard-generate').click();

  await expect(page.getByText('Offline storyboard draft')).toBeVisible();
  await expect(page.getByTestId('storyboard-draft-shot')).toHaveCount(3);
  await page.getByTestId('storyboard-draft-prompt-0').fill('Edited browser acceptance prompt');
  await page.getByTestId('storyboard-accept-all').click();
  await expect(page.getByTestId('lumora-toasts')).toContainText('已采用 3 个分镜');

  await page.getByTestId('storyboard-tab-adopted').click();
  await expect(page.getByTestId('storyboard-adopted-shot')).toHaveCount(6);
  await page.getByRole('button', { name: '关闭 AI 分镜工作台' }).click();
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(6);

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const exported = JSON.parse(await readDownload(await downloadPromise));
  expect(exported.shots.slice(-3)).toMatchObject([
    {
      name: 'Shot 1',
      startTime: 4.5,
      endTime: 8.5,
      shotSize: 'wide',
      movement: 'dolly-in',
      prompt: 'Edited browser acceptance prompt',
      aiSource: {
        providerId: 'com.lumora.mock.ai',
        model: 'mock-storyboard-success',
      },
    },
    {
      name: 'Shot 2',
      startTime: 8.5,
      endTime: 12.5,
      shotSize: 'medium',
      movement: 'tracking',
    },
    {
      name: 'Shot 3',
      startTime: 12.5,
      endTime: 16.5,
      shotSize: 'close-up',
      movement: 'static',
    },
  ]);
});

test('configures an OpenAI-compatible endpoint and keeps its runtime key out of persistence and exports', async ({ page }) => {
  const endpointOrigin = 'http://127.0.0.1:48765';
  const endpoint = `${endpointOrigin}/v1/chat/completions`;
  const apiKey = 'sk-e2e-runtime-only-marker';
  const requests: Array<{
    authorization?: string;
    model?: string;
    connectionTest: boolean;
    bodyKeys: string[];
    messageKeys: string[][];
    containsApiKey: boolean;
  }> = [];
  await page.route(`${endpointOrigin}/**`, async (route) => {
    const request = route.request();
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    const rawBody = request.postData() ?? '';
    const body = request.postDataJSON() as {
      model?: string;
      max_tokens?: number;
      messages?: Array<Record<string, unknown>>;
    };
    requests.push({
      authorization: request.headers().authorization,
      model: body.model,
      connectionTest: body.max_tokens === 1,
      bodyKeys: Object.keys(body).sort(),
      messageKeys: (body.messages ?? []).map((message) => Object.keys(message).sort()),
      containsApiKey: rawBody.includes(apiKey),
    });
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        choices: [{ message: { content: body.max_tokens === 1 ? 'OK' : JSON.stringify(COMPATIBLE_DRAFT) } }],
      }),
    });
  });

  await page.getByTestId('panel-tab-com.lumora.openai.compatible.settings').click();
  await page.getByTestId('openai-endpoint').fill(`${endpointOrigin}/v1`);
  await page.getByTestId('openai-model').fill('vendor/custom-storyboard-v2');
  await page.getByTestId('openai-api-key').fill(apiKey);
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('status')).toContainText('已保存');
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByRole('status')).toContainText('连接成功');

  await openStoryboard(page);
  await page.getByTestId('storyboard-provider').selectOption('com.lumora.openai.compatible.ai');
  await expect(page.getByTestId('storyboard-model')).toHaveValue('vendor/custom-storyboard-v2');
  await expect(page.getByTestId('storyboard-cost-hint')).toContainText('未知');
  await page.getByTestId('storyboard-concept').fill('A courier crosses a neon market while protecting a mysterious case.');
  await page.getByTestId('storyboard-generate').click();

  await expect(page.getByText('Compatible endpoint storyboard')).toBeVisible();
  await expect(page.getByTestId('storyboard-draft-shot')).toHaveCount(3);
  await page.getByTestId('storyboard-draft-prompt-0').fill('Edited compatible endpoint prompt');
  await page.getByTestId('storyboard-accept-all').click();
  await expect(page.getByTestId('lumora-toasts')).toContainText('已采用 3 个分镜');
  await page.getByRole('button', { name: '关闭 AI 分镜工作台' }).click();

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const exportedText = await readDownload(await downloadPromise);
  const exported = JSON.parse(exportedText);
  expect(exported.shots.slice(-3)).toMatchObject([
    {
      name: 'Market arrival',
      shotSize: 'wide',
      movement: 'dolly-in',
      prompt: 'Edited compatible endpoint prompt',
      aiSource: {
        providerId: 'com.lumora.openai.compatible.ai',
        model: 'vendor/custom-storyboard-v2',
      },
    },
    { name: 'Courier pursuit', shotSize: 'medium', movement: 'tracking' },
    { name: 'Case reveal', shotSize: 'close-up', movement: 'static' },
  ]);
  expect(exportedText).not.toContain(apiKey);
  expect(requests).toEqual([
    {
      authorization: `Bearer ${apiKey}`,
      model: 'vendor/custom-storyboard-v2',
      connectionTest: true,
      bodyKeys: ['max_tokens', 'messages', 'model', 'temperature'],
      messageKeys: [['content', 'role'], ['content', 'role']],
      containsApiKey: false,
    },
    {
      authorization: `Bearer ${apiKey}`,
      model: 'vendor/custom-storyboard-v2',
      connectionTest: false,
      bodyKeys: ['messages', 'model', 'temperature'],
      messageKeys: [['content', 'role'], ['content', 'role']],
      containsApiKey: false,
    },
  ]);

  const persistedText = await page.evaluate(async () => {
    const local = Array.from({ length: localStorage.length }, (_, index) => {
      const key = localStorage.key(index)!;
      return [key, localStorage.getItem(key)];
    });
    const session = Array.from({ length: sessionStorage.length }, (_, index) => {
      const key = sessionStorage.key(index)!;
      return [key, sessionStorage.getItem(key)];
    });
    const indexed: unknown[] = [];
    for (const info of await indexedDB.databases()) {
      if (!info.name) continue;
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(info.name!);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const names = Array.from(database.objectStoreNames);
      if (names.length > 0) {
        const transaction = database.transaction(names, 'readonly');
        for (const name of names) {
          const values = await new Promise<unknown[]>((resolve, reject) => {
            const request = transaction.objectStore(name).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          indexed.push(values);
        }
      }
      database.close();
    }
    return JSON.stringify({ local, session, indexed });
  });
  expect(persistedText).not.toContain(apiKey);
  await expect(page.getByTestId('event-log')).not.toContainText(apiKey);

  await page.getByTestId('open-plugin-manager').click();
  await page.getByTestId('plugin-toggle-com.lumora.openai.compatible').click();
  await expect(page.getByTestId('plugin-state-com.lumora.openai.compatible')).toContainText('已禁用');
  await page.getByTestId('plugin-toggle-com.lumora.openai.compatible').click();
  await expect(page.getByTestId('plugin-state-com.lumora.openai.compatible')).toContainText('运行中');
  await page.getByTestId('close-plugin-manager').click();
  await page.getByTestId('panel-tab-com.lumora.openai.compatible.settings').click();
  await expect(page.getByTestId('openai-endpoint')).toHaveValue(endpoint);
  await expect(page.getByTestId('openai-model')).toHaveValue('vendor/custom-storyboard-v2');
  await expect(page.getByTestId('openai-api-key')).toHaveValue('');
});

test('clears the runtime key from the keyboard without replacing unsaved endpoint or model drafts', async ({ page }) => {
  const apiKey = 'sk-e2e-clear-key-marker';
  await page.getByTestId('panel-tab-com.lumora.openai.compatible.settings').click();
  await page.getByTestId('openai-endpoint').fill('https://saved.example/v1');
  await page.getByTestId('openai-model').fill('saved-model');
  await page.getByTestId('openai-api-key').fill(apiKey);
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByRole('status')).toContainText('已保存');

  await page.getByTestId('openai-endpoint').fill('https://dirty.example/v1');
  await page.getByTestId('openai-model').fill('dirty-model');
  await page.getByRole('button', { name: /Key$/ }).focus();
  await page.keyboard.press('Enter');

  await expect(page.getByTestId('openai-endpoint')).toHaveValue('https://dirty.example/v1');
  await expect(page.getByTestId('openai-model')).toHaveValue('dirty-model');
  await expect(page.getByTestId('openai-api-key')).toHaveValue('');
  const persistedText = await page.evaluate(() => JSON.stringify(localStorage));
  expect(persistedText).toContain('saved-model');
  expect(persistedText).not.toContain('dirty-model');
  expect(persistedText).not.toContain(apiKey);

  const downloadPromise = page.waitForEvent('download');
  await page.getByTestId('toolbar-com.lumora.mock.toolbar.export').click();
  const exportedText = await readDownload(await downloadPromise);
  expect(exportedText).not.toContain(apiKey);
});

test('uses a changed endpoint and model on the next empty-key generation', async ({ page }) => {
  const firstOrigin = 'http://127.0.0.1:48767';
  const secondOrigin = 'http://127.0.0.1:48768';
  const requests: Array<{ url: string; authorization?: string; model?: string; connectionTest: boolean }> = [];
  await page.route(/http:\/\/127\.0\.0\.1:4876[78]\/.*$/, async (route) => {
    const request = route.request();
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    const body = request.postDataJSON() as { model?: string; max_tokens?: number };
    requests.push({
      url: request.url(),
      authorization: request.headers().authorization,
      model: body.model,
      connectionTest: body.max_tokens === 1,
    });
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        choices: [{ message: { content: body.max_tokens === 1 ? 'OK' : JSON.stringify(COMPATIBLE_DRAFT) } }],
      }),
    });
  });

  await configureOpenAi(page, `${firstOrigin}/v1`, 'vendor/first-model', 'first-runtime-key');
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect(page.getByRole('status')).toContainText('连接成功');
  await configureOpenAi(page, `${secondOrigin}/compatible`, 'vendor/second-model');
  await openOpenAiStoryboard(page, 'vendor/second-model');
  await page.getByTestId('storyboard-generate').click();

  await expect(page.getByText('Compatible endpoint storyboard')).toBeVisible();
  expect(requests).toEqual([
    {
      url: `${firstOrigin}/v1/chat/completions`,
      authorization: 'Bearer first-runtime-key',
      model: 'vendor/first-model',
      connectionTest: true,
    },
    {
      url: `${secondOrigin}/compatible/chat/completions`,
      authorization: undefined,
      model: 'vendor/second-model',
      connectionTest: false,
    },
  ]);
});

test('maps compatible endpoint failures once each without changing the project', async ({ page }) => {
  const endpointOrigin = 'http://127.0.0.1:48769';
  const attempts = new Map<string, number>();
  await page.route(`${endpointOrigin}/**`, async (route) => {
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'authorization, content-type',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    };
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: corsHeaders });
      return;
    }
    const body = route.request().postDataJSON() as { model: string };
    attempts.set(body.model, (attempts.get(body.model) ?? 0) + 1);
    const headers = { ...corsHeaders, 'Content-Type': 'application/json' };
    switch (body.model) {
      case 'network-model':
        await route.abort('failed');
        return;
      case 'invalid-json-model':
        await route.fulfill({ status: 200, headers, body: '{PRIVATE_NOT_JSON' });
        return;
      case 'invalid-schema-model':
        await route.fulfill({
          status: 200,
          headers,
          body: JSON.stringify({
            choices: [{ message: { content: JSON.stringify({
              title: 'Invalid',
              summary: 'Missing shot fields',
              shots: [{ title: 'One' }, { title: 'Two' }, { title: 'Three' }],
            }) } }],
          }),
        });
        return;
      default: {
        const status = Number(body.model.split('-')[1]);
        await route.fulfill({ status, headers, body: 'PRIVATE_PROVIDER_FAILURE' });
      }
    }
  });

  const cases = [
    ['status-429', 'rate_limited'],
    ['status-503', 'provider_unavailable'],
    ['status-408', 'timeout'],
    ['network-model', 'network_error'],
    ['invalid-json-model', 'schema_invalid'],
    ['invalid-schema-model', 'schema_invalid'],
  ] as const;

  for (const [model, code] of cases) {
    await configureOpenAi(page, `${endpointOrigin}/v1`, model);
    await openOpenAiStoryboard(page, model);
    await page.getByTestId('storyboard-generate').click();
    await expect(page.getByTestId('storyboard-error')).toContainText(code);
    await expect(page.getByTestId('storyboard-error')).not.toContainText('PRIVATE');
    expect(attempts.get(model)).toBe(1);
    await page.getByRole('button', { name: '关闭 AI 分镜工作台' }).click();
    await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(3);
  }
});

test('cancels an in-flight compatible request without accepting its late success', async ({ page }) => {
  const endpointOrigin = 'http://127.0.0.1:48770';
  let attempts = 0;
  let release!: () => void;
  let markRouteSettled!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const routeSettled = new Promise<void>((resolve) => { markRouteSettled = resolve; });
  await page.route(`${endpointOrigin}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'authorization, content-type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
        },
      });
      return;
    }
    attempts += 1;
    await gate;
    try {
      await route.fulfill({
        status: 200,
        headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
        body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(COMPATIBLE_DRAFT) } }] }),
      }).catch(() => undefined);
    } finally {
      markRouteSettled();
    }
  });

  await configureOpenAi(page, `${endpointOrigin}/v1`, 'cancel-model');
  await openOpenAiStoryboard(page, 'cancel-model');
  await page.getByTestId('storyboard-generate').click();
  await expect.poll(() => attempts).toBe(1);
  await page.getByTestId('storyboard-cancel').click();
  await expect(page.getByTestId('storyboard-error')).toContainText('cancelled');
  release();
  await routeSettled;
  await expect(page.getByText('Compatible endpoint storyboard')).toHaveCount(0);
  await page.getByRole('button', { name: '关闭 AI 分镜工作台' }).click();
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(3);
});

test('disabling the plugin aborts an in-flight connection request and clears only the runtime key', async ({ page }) => {
  const endpointOrigin = 'http://127.0.0.1:48771';
  let attempts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  await page.route(`${endpointOrigin}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'authorization, content-type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
        },
      });
      return;
    }
    attempts += 1;
    await gate;
    await route.fulfill({
      status: 200,
      headers: { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' },
      body: JSON.stringify({ choices: [{ message: { content: JSON.stringify(COMPATIBLE_DRAFT) } }] }),
    }).catch(() => undefined);
  });

  await configureOpenAi(page, `${endpointOrigin}/v1`, 'disable-model', 'disable-runtime-key');
  const requestFailed = page.waitForEvent('requestfailed', (request) => (
    request.method() === 'POST' && request.url() === `${endpointOrigin}/v1/chat/completions`
  ));
  await page.getByRole('button', { name: '测试连接' }).click();
  await expect.poll(() => attempts).toBe(1);
  await page.getByTestId('open-plugin-manager').click();
  await expect(page.getByTestId('plugin-manager')).toBeVisible();
  await page.getByTestId('plugin-toggle-com.lumora.openai.compatible').click();
  await expect(page.getByTestId('plugin-state-com.lumora.openai.compatible')).toContainText('已禁用');
  await requestFailed;
  release();

  await page.getByTestId('plugin-toggle-com.lumora.openai.compatible').click();
  await expect(page.getByTestId('plugin-state-com.lumora.openai.compatible')).toContainText('运行中');
  await page.getByTestId('close-plugin-manager').click();
  await page.getByTestId('panel-tab-com.lumora.openai.compatible.settings').click();
  await expect(page.getByTestId('openai-endpoint')).toHaveValue(`${endpointOrigin}/v1/chat/completions`);
  await expect(page.getByTestId('openai-model')).toHaveValue('disable-model');
  await expect(page.getByTestId('openai-api-key')).toHaveValue('');
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(3);
});

test('maps an OpenAI-compatible authentication failure without retrying or changing the project', async ({ page }) => {
  const endpointOrigin = 'http://127.0.0.1:48766';
  let attempts = 0;
  await page.route(`${endpointOrigin}/**`, async (route) => {
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': 'authorization, content-type',
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
        },
      });
      return;
    }
    attempts += 1;
    await route.fulfill({
      status: 401,
      headers: { 'Access-Control-Allow-Origin': '*' },
      body: 'PRIVATE_AUTH_RESPONSE_BODY',
    });
  });
  await page.getByTestId('panel-tab-com.lumora.openai.compatible.settings').click();
  await page.getByTestId('openai-endpoint').fill(`${endpointOrigin}/v1`);
  await page.getByTestId('openai-model').fill('unauthorized-model');
  await page.getByTestId('openai-api-key').fill('sk-rejected-runtime-marker');
  await page.getByRole('button', { name: '保存设置' }).click();

  await openStoryboard(page);
  await page.getByTestId('storyboard-provider').selectOption('com.lumora.openai.compatible.ai');
  await page.getByTestId('storyboard-concept').fill('A complete concept long enough to exercise authentication failure.');
  await page.getByTestId('storyboard-generate').click();

  await expect(page.getByTestId('storyboard-error')).toContainText('authentication_failed');
  await expect(page.getByTestId('storyboard-error')).not.toContainText('PRIVATE_AUTH_RESPONSE_BODY');
  expect(attempts).toBe(1);
  await page.getByRole('button', { name: '关闭 AI 分镜工作台' }).click();
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(3);
});

test('keeps OpenAI-compatible settings usable without horizontal overflow on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.getByTestId('panel-tab-com.lumora.openai.compatible.settings').click();
  const settings = page.getByTestId('openai-compatible-settings');
  await expect(settings).toBeVisible();
  await expect(page.getByRole('heading', { name: 'OpenAI 兼容设置' })).toBeInViewport();
  const dimensions = await settings.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  await expect(page.getByTestId('openai-endpoint')).toBeVisible();
  await expect(page.getByTestId('openai-model')).toBeVisible();
  await expect(page.getByTestId('openai-api-key')).toBeVisible();
  await expect(page.getByRole('button', { name: '保存设置' })).toBeVisible();
  await expect(page.getByRole('button', { name: '测试连接' })).toBeVisible();
});

test('rejects an invalid provider payload without changing the project', async ({ page }) => {
  await openStoryboard(page);
  await page.getByTestId('storyboard-concept').fill('A complete concept long enough to pass request validation.');
  await page.getByTestId('storyboard-model').selectOption('mock-storyboard-schema-error');
  await expect(page.getByTestId('storyboard-cost-hint')).toContainText('未知');
  await page.getByTestId('storyboard-generate').click();

  await expect(page.getByTestId('storyboard-error')).toContainText('schema_invalid');
  await expect(page.getByTestId('storyboard-error')).toContainText('未自动重试');
  await page.getByRole('button', { name: '关闭 AI 分镜工作台' }).click();
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(3);
});

test('cancels a running generation without adopting shots', async ({ page }) => {
  await openStoryboard(page);
  await page.getByTestId('storyboard-concept').fill('A complete concept long enough to pass request validation.');
  await page.getByTestId('storyboard-model').selectOption('mock-storyboard-slow');
  await page.getByTestId('storyboard-generate').click();
  await expect(page.getByTestId('storyboard-cancel')).toBeEnabled();
  await page.getByTestId('storyboard-cancel').click();

  await expect(page.getByTestId('storyboard-error')).toContainText('cancelled');
  await page.getByRole('button', { name: '关闭 AI 分镜工作台' }).click();
  await expect(page.locator('[data-testid^="shot-block-"]')).toHaveCount(3);
});

test('keeps reverse tab focus inside the workspace when the adopted tab is active', async ({ page }) => {
  await openStoryboard(page);
  const workspace = page.getByTestId('storyboard-workspace');
  const adoptedTab = page.getByTestId('storyboard-tab-adopted');
  await adoptedTab.click();
  await adoptedTab.focus();

  await page.keyboard.press('Shift+Tab');

  await expect.poll(() => workspace.evaluate((element) => element.contains(document.activeElement))).toBe(true);
  await expect(page.getByTestId('studio-mount-toggle')).not.toBeFocused();
});

test('keeps the generation workflow usable without horizontal overflow on mobile', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await openStoryboard(page);

  const workspace = page.getByTestId('storyboard-workspace');
  const dimensions = await workspace.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
  }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  await expect(page.getByRole('button', { name: '关闭 AI 分镜工作台' })).toBeVisible();
  await expect(page.getByTestId('storyboard-provider')).toBeVisible();

  await page.getByTestId('storyboard-concept').fill('A courier crosses a neon market while protecting a mysterious case.');
  await page.getByTestId('storyboard-generate').click();
  await expect(page.getByText('Offline storyboard draft')).toBeVisible();
  await expect(page.getByTestId('storyboard-draft-shot')).toHaveCount(3);
});

test('collapses the storyboard layout inside a narrow embed on a wide desktop viewport', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const studio = page.getByTestId('lumora-studio');
  await studio.evaluate((element) => {
    element.style.width = '600px';
    element.style.flex = '0 0 600px';
    element.style.maxWidth = '600px';
  });
  await expect.poll(async () => (await studio.boundingBox())?.width).toBe(600);
  await openStoryboard(page);

  const layout = page.locator('.lumora-storyboard__layout');
  const dimensions = await layout.evaluate((element) => ({
    clientWidth: element.clientWidth,
    scrollWidth: element.scrollWidth,
    display: getComputedStyle(element).display,
  }));
  expect(dimensions.display).toBe('block');
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 1);
  await expect(page.getByTestId('storyboard-provider')).toBeVisible();
  await expect(page.locator('.lumora-storyboard__drafts')).toBeVisible();
});
