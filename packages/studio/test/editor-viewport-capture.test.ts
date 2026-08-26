import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import {
  captureProjectFrame,
  renderProjectFrameToCanvas,
} from '../src/components/editor/frame-capture';

function createRenderer(options: { throwOnRender?: boolean } = {}) {
  const visibleToDataUrl = vi.fn(() => 'visible-canvas');
  const previousTarget = new THREE.WebGLCubeRenderTarget(64);
  const targetViewport = new THREE.Vector4(2, 3, 40, 36);
  const targetScissor = new THREE.Vector4(4, 5, 32, 28);
  previousTarget.viewport.copy(targetViewport);
  previousTarget.scissor.copy(targetScissor);
  previousTarget.scissorTest = true;
  const defaultViewport = new THREE.Vector4(11, 12, 640, 360);
  const defaultScissor = new THREE.Vector4(13, 14, 620, 340);
  const clearColor = new THREE.Color('#123456');
  const renderer = {
    domElement: { toDataURL: visibleToDataUrl },
    outputColorSpace: THREE.SRGBColorSpace,
    getRenderTarget: vi.fn(() => previousTarget),
    getActiveCubeFace: vi.fn(() => 4),
    getActiveMipmapLevel: vi.fn(() => 2),
    setRenderTarget: vi.fn(),
    getViewport: vi.fn((target: THREE.Vector4) => target.copy(defaultViewport)),
    setViewport: vi.fn(),
    getScissor: vi.fn((target: THREE.Vector4) => target.copy(defaultScissor)),
    setScissor: vi.fn(),
    getScissorTest: vi.fn(() => true),
    setScissorTest: vi.fn(),
    getClearColor: vi.fn((target: THREE.Color) => target.copy(clearColor)),
    getClearAlpha: vi.fn(() => 0.4),
    setClearColor: vi.fn(),
    clear: vi.fn(),
    render: vi.fn((_scene: THREE.Scene, _camera: THREE.Camera) => {
      if (options.throwOnRender) throw new Error('render failed');
    }),
    readRenderTargetPixels: vi.fn(
      (_target: THREE.WebGLRenderTarget, _x: number, _y: number, _width: number, _height: number, pixels: Uint8Array) => {
        pixels.fill(127);
      },
    ),
  };
  return {
    renderer: renderer as unknown as THREE.WebGLRenderer,
    raw: renderer,
    previousTarget,
    targetViewport,
    targetScissor,
    visibleToDataUrl,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('captureProjectFrame', () => {
  it('renders an exact 1280x720 export frame into the caller canvas', () => {
    const { renderer, raw } = createRenderer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 4 / 3);
    const target = document.createElement('canvas');
    const putImageData = vi.fn();
    const createImageData = vi.fn((width: number, height: number) => ({
      width,
      height,
      data: new Uint8ClampedArray(width * height * 4),
    }));
    vi.spyOn(target, 'getContext').mockReturnValue({ createImageData, putImageData } as never);

    const rendered = renderProjectFrameToCanvas(renderer, scene, camera, target, {
      width: 1280,
      height: 720,
      aspect: 16 / 9,
    });

    expect(rendered).toBe(true);
    expect(target.width).toBe(1280);
    expect(target.height).toBe(720);
    expect(createImageData).toHaveBeenCalledWith(1280, 720);
    expect(putImageData).toHaveBeenCalledTimes(1);
    expect(raw.readRenderTargetPixels.mock.calls[0]?.slice(1, 5)).toEqual([0, 0, 1280, 720]);
    expect(camera.aspect).toBe(4 / 3);
  });

  it('letterboxes a 4:3 project inside a 16:9 export frame', () => {
    const { renderer, raw } = createRenderer();
    const target = document.createElement('canvas');
    vi.spyOn(target, 'getContext').mockReturnValue({
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
    } as never);

    expect(renderProjectFrameToCanvas(
      renderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      target,
      { width: 1280, height: 720, aspect: 4 / 3 },
    )).toBe(true);

    expect(raw.setViewport).toHaveBeenCalledWith(160, 0, 960, 720);
  });

  it('pillarboxes a portrait project inside a 16:9 export frame', () => {
    const { renderer, raw } = createRenderer();
    const target = document.createElement('canvas');
    vi.spyOn(target, 'getContext').mockReturnValue({
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
    } as never);

    expect(renderProjectFrameToCanvas(
      renderer,
      new THREE.Scene(),
      new THREE.PerspectiveCamera(),
      target,
      { width: 1280, height: 720, aspect: 9 / 16 },
    )).toBe(true);

    expect(raw.setViewport).toHaveBeenCalledWith(437, 0, 405, 720);
  });

  it('omits editor helpers from export frames and restores their visibility', () => {
    const { renderer, raw } = createRenderer();
    const scene = new THREE.Scene();
    const grid = new THREE.GridHelper();
    const transformControls = new THREE.Group() as THREE.Group & { isTransformControls: boolean };
    transformControls.isTransformControls = true;
    const content = new THREE.Mesh();
    scene.add(grid, transformControls, content);
    const target = document.createElement('canvas');
    vi.spyOn(target, 'getContext').mockReturnValue({
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData: vi.fn(),
    } as never);
    raw.render.mockImplementation(() => {
      expect(grid.visible).toBe(false);
      expect(transformControls.visible).toBe(false);
      expect(content.visible).toBe(true);
    });

    const rendered = renderProjectFrameToCanvas(
      renderer,
      scene,
      new THREE.PerspectiveCamera(),
      target,
      { width: 1280, height: 720, aspect: 16 / 9, excludeEditorHelpers: true },
    );

    expect(rendered).toBe(true);
    expect(grid.visible).toBe(true);
    expect(transformControls.visible).toBe(true);
  });

  it('renders offscreen at project aspect and restores all renderer and camera state', () => {
    const { renderer, raw, previousTarget, targetViewport, targetScissor, visibleToDataUrl } = createRenderer();
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 4 / 3);
    const putImageData = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      createImageData: (width: number, height: number) => ({
        width,
        height,
        data: new Uint8ClampedArray(width * height * 4),
      }),
      putImageData,
    } as never);
    const encode = vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(function (this: HTMLCanvasElement) {
      return `data:image/png;base64,${this.width}x${this.height}`;
    });
    raw.render.mockImplementation((_scene, activeCamera) => {
      expect((activeCamera as THREE.PerspectiveCamera).aspect).toBeCloseTo(16 / 9);
    });

    const result = captureProjectFrame(renderer, scene, camera, 16 / 9);

    expect(result).toBe('data:image/png;base64,320x180');
    expect(camera.aspect).toBe(4 / 3);
    expect(raw.render).toHaveBeenCalledWith(scene, camera);
    const restoreCalls = raw.setRenderTarget.mock.calls.slice(-2);
    expect(restoreCalls[0]?.[0]).toBeNull();
    expect(restoreCalls[1]?.[0]).toBe(previousTarget);
    expect(restoreCalls[1]?.slice(1)).toEqual([4, 2]);
    expect(raw.setViewport.mock.calls.at(-1)?.[0]).toEqual(new THREE.Vector4(11, 12, 640, 360));
    expect(raw.setScissor.mock.calls.at(-1)?.[0]).toEqual(new THREE.Vector4(13, 14, 620, 340));
    expect(raw.setScissorTest.mock.calls.at(-1)?.[0]).toBe(true);
    expect(raw.setViewport.mock.invocationCallOrder.at(-1)).toBeLessThan(
      raw.setRenderTarget.mock.invocationCallOrder.at(-1)!,
    );
    expect(previousTarget.viewport).toEqual(targetViewport);
    expect(previousTarget.scissor).toEqual(targetScissor);
    expect(previousTarget.scissorTest).toBe(true);
    expect(raw.setClearColor.mock.calls.at(-1)).toEqual([new THREE.Color('#123456'), 0.4]);
    expect(putImageData).toHaveBeenCalledTimes(1);
    expect(encode).toHaveBeenCalledTimes(1);
    expect(visibleToDataUrl).not.toHaveBeenCalled();
  });

  it('restores renderer and camera state when offscreen rendering throws', () => {
    const { renderer, raw, previousTarget, targetViewport, targetScissor } = createRenderer({ throwOnRender: true });
    const camera = new THREE.PerspectiveCamera(45, 1.25);
    const scene = new THREE.Scene();
    const grid = new THREE.GridHelper();
    scene.add(grid);

    const result = renderProjectFrameToCanvas(
      renderer,
      scene,
      camera,
      document.createElement('canvas'),
      { width: 320, height: 180, aspect: 9 / 16, excludeEditorHelpers: true },
    );

    expect(result).toBe(false);
    expect(camera.aspect).toBe(1.25);
    expect(grid.visible).toBe(true);
    const restoreCalls = raw.setRenderTarget.mock.calls.slice(-2);
    expect(restoreCalls[0]?.[0]).toBeNull();
    expect(restoreCalls[1]?.[0]).toBe(previousTarget);
    expect(restoreCalls[1]?.slice(1)).toEqual([4, 2]);
    expect(raw.setViewport.mock.calls.at(-1)?.[0]).toEqual(new THREE.Vector4(11, 12, 640, 360));
    expect(raw.setScissorTest.mock.calls.at(-1)?.[0]).toBe(true);
    expect(raw.setViewport.mock.invocationCallOrder.at(-1)).toBeLessThan(
      raw.setRenderTarget.mock.invocationCallOrder.at(-1)!,
    );
    expect(previousTarget.viewport).toEqual(targetViewport);
    expect(previousTarget.scissor).toEqual(targetScissor);
  });
});
