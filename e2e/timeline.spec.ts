import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { resolve } from 'node:path';

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

/** 数值位姿读取：CameraPoseReadout 序列化的 JSON（e2e 数值断言，复审 AC 补强） */
async function cameraPose(
  page: Page,
  cameraId = 'sample-camera',
): Promise<{ position: [number, number, number]; rotation: [number, number, number]; focalLength: number | null }> {
  const text = await page.getByTestId('camera-pose-readout').textContent();
  if (!text) throw new Error('位姿读取钩子不可用');
  const pose = JSON.parse(text)[cameraId];
  if (!pose) throw new Error(`机位 ${cameraId} 不在位姿钩子输出中`);
  return pose;
}

/** 两张 PNG 截图的像素差异比例（0..1）：任一通道差绝对值之和 > 30 的像素占比；
 *  在页面内用 canvas 解码比对（两帧经同一截图管线，编码参数一致） */
async function pixelDiffRatio(page: Page, a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    ([a64, b64]) => {
      const load = (src: string) =>
        new Promise<HTMLImageElement>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve(img);
          img.onerror = reject;
          img.src = `data:image/png;base64,${src}`;
        });
      return (async () => {
        const [ia, ib] = await Promise.all([load(a64), load(b64)]);
        const w = Math.min(ia.width, ib.width);
        const h = Math.min(ia.height, ib.height);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d')!;
        ctx.drawImage(ia, 0, 0, w, h);
        const da = ctx.getImageData(0, 0, w, h).data;
        ctx.drawImage(ib, 0, 0, w, h);
        const db = ctx.getImageData(0, 0, w, h).data;
        let diff = 0;
        for (let i = 0; i < da.length; i += 4) {
          const delta =
            Math.abs(da[i]! - db[i]!) + Math.abs(da[i + 1]! - db[i + 1]!) + Math.abs(da[i + 2]! - db[i + 2]!);
          if (delta > 30) diff += 1;
        }
        return diff / (da.length / 4);
      })();
    },
    [a.toString('base64'), b.toString('base64')],
  );
}

async function shotLeft(page: Page, shotId: string): Promise<number> {
  return page.getByTestId(`shot-block-${shotId}`).evaluate((el) => parseFloat((el as HTMLElement).style.left));
}

async function expectShotLeft(page: Page, shotId: string, expectedPx: number): Promise<void> {
  const actual = await shotLeft(page, shotId);
  expect(Math.abs(actual - expectedPx)).toBeLessThan(1);
}

test('overwrite confirmation portal retains resolved Studio theme styles', async ({ page }) => {
  await page.getByTestId('tree-row-sample-camera').click();
  await page.getByTestId('timeline-record').click();
  const overlay = page.getByTestId('overwrite-confirm');
  await expect(overlay).toBeVisible();

  const styles = await overlay.evaluate((element) => {
    const overlayStyle = getComputedStyle(element);
    const modal = element.querySelector<HTMLElement>('.lumora-timeline__modal')!;
    const button = modal.querySelector<HTMLElement>('.lumora-button')!;
    const modalStyle = getComputedStyle(modal);
    const buttonStyle = getComputedStyle(button);
    return {
      surfaceVariable: overlayStyle.getPropertyValue('--lumora-surface-2').trim(),
      modalBackground: modalStyle.backgroundColor,
      modalBorderStyle: modalStyle.borderTopStyle,
      modalBorderWidth: modalStyle.borderTopWidth,
      buttonBackground: buttonStyle.backgroundColor,
      buttonBorderStyle: buttonStyle.borderTopStyle,
      buttonColor: buttonStyle.color,
    };
  });
  expect(styles.surfaceVariable).toBe('#232734');
  expect(styles.modalBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(styles.modalBorderStyle).toBe('solid');
  expect(styles.modalBorderWidth).toBe('1px');
  expect(styles.buttonBackground).not.toBe('rgba(0, 0, 0, 0)');
  expect(styles.buttonBorderStyle).toBe('solid');
  expect(styles.buttonColor).not.toBe('rgba(0, 0, 0, 0)');
  await page.getByText('取消').click();
});

test('offscreen capture preserves a non-default cube face/mip and encodes real WebGL pixels upright', async ({ page }) => {
  const frameCaptureUrl = `/@fs/${resolve('packages/studio/src/components/editor/frame-capture.ts').replace(/\\/g, '/')}`;
  const threeUrl = `/@fs/${resolve('node_modules/three/build/three.module.js').replace(/\\/g, '/')}`;
  const result = await page.evaluate(
    async ({ frameCaptureUrl, threeUrl }) => {
      const THREE = await import(threeUrl);
      const { captureProjectFrame } = (await import(frameCaptureUrl)) as {
        captureProjectFrame: (
          renderer: InstanceType<typeof THREE.WebGLRenderer>,
          scene: InstanceType<typeof THREE.Scene>,
          camera: InstanceType<typeof THREE.Camera>,
          aspect: number,
        ) => string | null;
      };
      const canvas = document.createElement('canvas');
      document.body.append(canvas);
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
      renderer.setPixelRatio(1);
      renderer.setSize(64, 64, false);
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const defaultViewport = [7, 8, 40, 36];
      const defaultScissor = [5, 6, 30, 28];
      const targetViewport = [2, 3, 20, 18];
      const targetScissor = [1, 2, 16, 14];
      const cubeTarget = new THREE.WebGLCubeRenderTarget(64, {
        generateMipmaps: true,
        minFilter: THREE.LinearMipmapLinearFilter,
      });
      cubeTarget.viewport.fromArray(targetViewport);
      cubeTarget.scissor.fromArray(targetScissor);
      cubeTarget.scissorTest = true;

      const bindOriginalState = (face: number) => {
        renderer.setRenderTarget(null);
        renderer.setViewport(...defaultViewport);
        renderer.setScissor(...defaultScissor);
        renderer.setScissorTest(true);
        renderer.setRenderTarget(cubeTarget, face, 1);
      };
      const values = (vector: { toArray: () => number[] }) => vector.toArray();
      const snapshot = () => {
        const gl = renderer.getContext();
        return {
          target: renderer.getRenderTarget() === cubeTarget,
          face: renderer.getActiveCubeFace(),
          mip: renderer.getActiveMipmapLevel(),
          defaultViewport: values(renderer.getViewport(new THREE.Vector4())),
          defaultScissor: values(renderer.getScissor(new THREE.Vector4())),
          defaultScissorTest: renderer.getScissorTest(),
          currentViewport: values(renderer.getCurrentViewport(new THREE.Vector4())),
          glScissor: Array.from(gl.getParameter(gl.SCISSOR_BOX) as Int32Array),
          glScissorTest: gl.isEnabled(gl.SCISSOR_TEST),
        };
      };

      const scene = new THREE.Scene();
      scene.background = new THREE.Color('#000000');
      const camera = new THREE.PerspectiveCamera(50, 1.5, 0.1, 10);
      camera.position.z = 2;
      const geometry = new THREE.PlaneGeometry(3, 0.94);
      const top = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#ff0000' }));
      top.position.y = 0.47;
      const bottom = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ color: '#0000ff' }));
      bottom.position.y = -0.47;
      scene.add(top, bottom);

      bindOriginalState(3);
      const png = captureProjectFrame(renderer, scene, camera, 1);
      if (!png) throw new Error('real WebGL capture returned null');
      const image = await new Promise<HTMLImageElement>((resolveImage, rejectImage) => {
        const next = new Image();
        next.onload = () => resolveImage(next);
        next.onerror = rejectImage;
        next.src = png;
      });
      const decodeCanvas = document.createElement('canvas');
      decodeCanvas.width = image.width;
      decodeCanvas.height = image.height;
      const context = decodeCanvas.getContext('2d')!;
      context.drawImage(image, 0, 0);
      const sample = (x: number, y: number) =>
        Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3));
      const successState = snapshot();

      bindOriginalState(5);
      const realRender = renderer.render.bind(renderer);
      renderer.render = () => {
        throw new Error('forced render failure');
      };
      const failedCapture = captureProjectFrame(renderer, scene, camera, 1);
      renderer.render = realRender;
      const failureState = snapshot();

      top.material.dispose();
      bottom.material.dispose();
      geometry.dispose();
      cubeTarget.dispose();
      renderer.dispose();
      canvas.remove();
      return {
        size: [image.width, image.height],
        top: sample(Math.floor(image.width / 2), Math.floor(image.height / 4)),
        bottom: sample(Math.floor(image.width / 2), Math.floor((image.height * 3) / 4)),
        successState,
        failedCapture,
        failureState,
        defaultViewport,
        defaultScissor,
        targetViewport,
        targetScissor,
      };
    },
    { frameCaptureUrl, threeUrl },
  );

  expect(result.size).toEqual([320, 320]);
  expect(result.top[0]).toBeGreaterThan(180);
  expect(result.top[1]).toBeLessThan(80);
  expect(result.top[2]).toBeLessThan(80);
  expect(result.bottom[0]).toBeLessThan(80);
  expect(result.bottom[1]).toBeLessThan(80);
  expect(result.bottom[2]).toBeGreaterThan(180);
  expect(result.successState).toEqual({
    target: true,
    face: 3,
    mip: 1,
    defaultViewport: result.defaultViewport,
    defaultScissor: result.defaultScissor,
    defaultScissorTest: true,
    currentViewport: result.targetViewport,
    glScissor: result.targetScissor,
    glScissorTest: true,
  });
  expect(result.failedCapture).toBeNull();
  expect(result.failureState).toEqual({
    target: true,
    face: 5,
    mip: 1,
    defaultViewport: result.defaultViewport,
    defaultScissor: result.defaultScissor,
    defaultScissorTest: true,
    currentViewport: result.targetViewport,
    glScissor: result.targetScissor,
    glScissorTest: true,
  });
});

test('AC1 浏览器级：真实约 5s 持续驾驶录制 → 抽稀覆盖轨道 → 晚段位姿 late delta + 两次回放同一确定终点严格一致', async ({ page }) => {
  await page.getByTestId('view-mode-select').selectOption('sample-camera'); // 主摄像机 POV
  await startRecording(page);
  await hideViewportOverlays(page);

  // 真实约 5s 持续驾驶输入（KeyS 后退按住）：录制后半段仍持续位移（复审 AC 补强）——
  // ~1s / ~2.5s / ~4.5s 三张画面逐步不同（而非仅开头有运动）；
  // 后退保持场景物体始终在视锥内（前进 ~2.8s 后物体出镜，只剩纯色地面，画面逐帧相同）
  await page.keyboard.down('s');
  await page.waitForTimeout(1000);
  const rec1 = await canvasShot(page);
  await page.waitForTimeout(1500);
  const rec25 = await canvasShot(page);
  await page.waitForTimeout(2000);
  const rec45 = await canvasShot(page);
  await page.keyboard.up('s');
  expect(rec25.equals(rec1)).toBe(false);
  expect(rec45.equals(rec25)).toBe(false);
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

  // 回到起点 → 起点画面 + 起点数值位姿
  await seekByRuler(page, 0.02, zoom);
  const s0 = await canvasShot(page);
  const pose0 = await cameraPose(page);

  // 晚于故障阈值（~3.5s）的两个时点直接读 camera pose 断言 late delta：
  // 示例 cube 自身 0-4s 有旋转轨道，仅画面变化无法证明相机在动（复审阻断 5
  // 反例：相机自 3.5s 起停住，2.5→4.5 画面仍变）；相机位姿是直接证据 ——
  // 后段关键帧错位/平台化时 4.0 与 4.5 的插值位姿相同或滞留。驾驶约 2.5m/s
  // 持续后移 → 0.5s 理论位移 ~1.25m，阈值 0.25m 留 5 倍余量
  await seekByRuler(page, 4.0, zoom);
  const pose40 = await cameraPose(page);
  const p40 = await canvasShot(page);
  await seekByRuler(page, 4.5, zoom);
  const pose45 = await cameraPose(page);
  const p45 = await canvasShot(page);
  expect(Math.abs(pose45.position[2]! - pose40.position[2]!)).toBeGreaterThan(0.25);
  expect(Math.abs(pose45.rotation[0]! - pose40.rotation[0]!)).toBeLessThan(0.05); // 驾驶仅平移
  expect(p45.equals(p40)).toBe(false);

  // Two independent real playbacks: start at zero, run to the natural non-looping
  // endpoint, and read immediately. No endpoint seek is allowed in this helper.
  await page.getByTestId('timeline-loop').setChecked(false);
  const playToNaturalEnd = async () => {
    await seekByRuler(page, 0, zoom);
    await expect(page.getByTestId('timeline-time')).toHaveText('00:00.00');
    const play = page.getByTestId('timeline-play');
    await play.click();
    await expect(play).toHaveAttribute('title', '暂停（空格）');
    await expect(play).toHaveAttribute('title', '播放（空格）', { timeout: 10_000 });
    const endTime = await timeSeconds(page);
    expect(Math.abs(endTime - lastKfTime)).toBeLessThan(0.08);
    const pose = await cameraPose(page);
    const pixels = await canvasShot(page);
    return { endTime, pose, pixels };
  };

  const runA = await playToNaturalEnd();
  expect(Math.abs(runA.pose.position[2]! - pose0.position[2]!)).toBeGreaterThan(0.5);
  expect(runA.pixels.equals(s0)).toBe(false);
  const runB = await playToNaturalEnd();
  expect(runB.endTime).toBe(runA.endTime);
  expect(runB.pose.position).toEqual(runA.pose.position);
  expect(runB.pose.rotation).toEqual(runA.pose.rotation);
  expect(runB.pose.focalLength).toEqual(runA.pose.focalLength);
  const diffEnd = await pixelDiffRatio(page, runA.pixels, runB.pixels);
  expect(diffEnd).toBeLessThan(0.01);
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

  // 数值断言（复审 AC 补强）：dolly 段 [0,2] 左端点无插值字段 → 线性插值，
  // t=1 处位置恰为两端中点 z=5.75；焦距段 [0,4] 线性（50→35）→ t=1 为 46.25
  const poseAt = async (t: number) => {
    await at(t);
    return cameraPose(page);
  };
  const pose1 = await poseAt(1);
  expect(pose1.position[2]).toBeCloseTo(5.75, 2);
  expect(pose1.focalLength).toBeCloseTo(46.25, 2);
  // 重复求值：回到起点再求值同一时刻 → 数值逐位一致（回放确定性）
  const pose0 = await poseAt(0);
  const pose1Again = await poseAt(1);
  expect(pose0.position[2]).toBeCloseTo(7, 2);
  expect(pose1Again.position[2]).toBeCloseTo(5.75, 2);
  expect(pose1Again.position).toEqual(pose1.position);
  expect(pose1Again.focalLength).toEqual(pose1.focalLength);

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
  // 机位绑定（复审 AC 补强：至少两台机位，按分镜身份校验绑定）
  await expect(page.getByTestId('shot-block-sample-shot-1')).toHaveAttribute('title', '机位：主摄像机');
  for (const shotId of ['sample-shot-2', 'sample-shot-3']) {
    await expect(page.getByTestId(`shot-block-${shotId}`)).toHaveAttribute('title', '机位：俯拍机位');
  }

  // 重排 1 → 右移两次 → [2, 3, 1]：区段时间按新顺序原子重算（视觉/时间顺序同变，审查第 3 项）
  await page.getByTestId('shot-move-right-sample-shot-1').click();
  await page.getByTestId('shot-move-right-sample-shot-1').click();
  await expectShotLeft(page, 'sample-shot-2', 0);
  await expectShotLeft(page, 'sample-shot-3', 1.5 * zoom);
  await expectShotLeft(page, 'sample-shot-1', 3 * zoom);
  // 机位绑定随分镜保留
  // 机位绑定（复审 AC 补强：至少两台机位，按分镜身份校验绑定）
  await expect(page.getByTestId('shot-block-sample-shot-1')).toHaveAttribute('title', '机位：主摄像机');
  for (const shotId of ['sample-shot-2', 'sample-shot-3']) {
    await expect(page.getByTestId(`shot-block-${shotId}`)).toHaveAttribute('title', '机位：俯拍机位');
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
  // 机位绑定（复审 AC 补强：至少两台机位，按分镜身份校验绑定）
  await expect(page.getByTestId('shot-block-sample-shot-1')).toHaveAttribute('title', '机位：主摄像机');
  for (const shotId of ['sample-shot-2', 'sample-shot-3']) {
    await expect(page.getByTestId(`shot-block-${shotId}`)).toHaveAttribute('title', '机位：俯拍机位');
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
