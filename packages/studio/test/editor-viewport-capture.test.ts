import { afterEach, describe, expect, it, vi } from 'vitest';
import * as THREE from 'three';
import { captureProjectFrame } from '../src/components/editor/frame-capture';

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

    const result = captureProjectFrame(renderer, new THREE.Scene(), camera, 9 / 16);

    expect(result).toBeNull();
    expect(camera.aspect).toBe(1.25);
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
