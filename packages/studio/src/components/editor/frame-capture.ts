import * as THREE from 'three';

const MAX_CAPTURE_DIMENSION = 320;

function captureSize(aspect: number): { width: number; height: number; aspect: number } {
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  if (safeAspect >= 1) {
    return {
      width: MAX_CAPTURE_DIMENSION,
      height: Math.max(1, Math.round(MAX_CAPTURE_DIMENSION / safeAspect)),
      aspect: safeAspect,
    };
  }
  return {
    width: Math.max(1, Math.round(MAX_CAPTURE_DIMENSION * safeAspect)),
    height: MAX_CAPTURE_DIMENSION,
    aspect: safeAspect,
  };
}

function writePixelsToCanvas(
  pixels: Uint8Array,
  width: number,
  height: number,
  canvas: HTMLCanvasElement,
): boolean {
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return false;
  const image = context.createImageData(width, height);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row += 1) {
    const sourceStart = (height - row - 1) * rowBytes;
    image.data.set(pixels.subarray(sourceStart, sourceStart + rowBytes), row * rowBytes);
  }
  context.putImageData(image, 0, 0);
  return true;
}

export interface ProjectFrameRenderOptions {
  width: number;
  height: number;
  aspect: number;
  excludeEditorHelpers?: boolean;
}

export type ProjectFrameCapture = (
  cameraObjectId: string,
  canvas: HTMLCanvasElement,
  options: ProjectFrameRenderOptions,
) => boolean;

function fitViewport(
  width: number,
  height: number,
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  const outputAspect = width / height;
  // 854x480 is the conventional integer 480p representation of 16:9. The
  // exact ratio differs by less than one output pixel, so letterboxing would
  // create a visible one-sided column without preserving meaningful geometry.
  if (Math.abs(width - height * aspect) <= 1 || Math.abs(height - width / aspect) <= 1) {
    return { x: 0, y: 0, width, height };
  }
  if (aspect >= outputAspect) {
    const fittedHeight = Math.min(height, Math.max(1, Math.round(width / aspect)));
    return { x: 0, y: Math.floor((height - fittedHeight) / 2), width, height: fittedHeight };
  }
  const fittedWidth = Math.min(width, Math.max(1, Math.round(height * aspect)));
  return { x: Math.floor((width - fittedWidth) / 2), y: 0, width: fittedWidth, height };
}

/** Render an exact-size project frame into a caller-owned 2D canvas. */
export function renderProjectFrameToCanvas(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  canvas: HTMLCanvasElement,
  options: ProjectFrameRenderOptions,
): boolean {
  const width = Math.floor(options.width);
  const height = Math.floor(options.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return false;
  }
  const aspect = Number.isFinite(options.aspect) && options.aspect > 0
    ? options.aspect
    : width / height;
  const viewport = fitViewport(width, height, aspect);
  const previousTarget = renderer.getRenderTarget();
  const previousCubeFace = renderer.getActiveCubeFace();
  const previousMipmapLevel = renderer.getActiveMipmapLevel();
  const previousViewport = renderer.getViewport(new THREE.Vector4()).clone();
  const previousScissor = renderer.getScissor(new THREE.Vector4()).clone();
  const previousScissorTest = renderer.getScissorTest();
  const previousClearColor = renderer.getClearColor(new THREE.Color()).clone();
  const previousClearAlpha = renderer.getClearAlpha();
  const perspectiveCamera = camera instanceof THREE.PerspectiveCamera ? camera : null;
  const previousCameraAspect = perspectiveCamera?.aspect ?? null;
  const hiddenHelpers: Array<{ object: THREE.Object3D; visible: boolean }> = [];
  if (options.excludeEditorHelpers) {
    scene.traverse((object) => {
      const transformControls = object as THREE.Object3D & { isTransformControls?: boolean };
      if (!(object instanceof THREE.GridHelper) && transformControls.isTransformControls !== true) return;
      hiddenHelpers.push({ object, visible: object.visible });
      object.visible = false;
    });
  }
  const target = new THREE.WebGLRenderTarget(width, height, {
    depthBuffer: true,
    stencilBuffer: false,
  });
  target.texture.colorSpace = renderer.outputColorSpace;
  target.viewport.set(0, 0, width, height);
  target.scissor.set(0, 0, width, height);
  target.scissorTest = false;

  try {
    if (perspectiveCamera) {
      perspectiveCamera.aspect = aspect;
      perspectiveCamera.updateProjectionMatrix();
    }
    renderer.setRenderTarget(target);
    renderer.setClearColor('#14161f', 1);
    renderer.clear();
    renderer.setViewport(viewport.x, viewport.y, viewport.width, viewport.height);
    renderer.render(scene, camera);
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    return writePixelsToCanvas(pixels, width, height, canvas);
  } catch {
    return false;
  } finally {
    // getViewport/getScissor expose default-framebuffer state even when a
    // render target is active. Restore those defaults while null is bound,
    // then rebind the previous target so Three restores its target-local state.
    renderer.setRenderTarget(null);
    renderer.setViewport(previousViewport);
    renderer.setScissor(previousScissor);
    renderer.setScissorTest(previousScissorTest);
    if (previousTarget) {
      renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmapLevel);
    }
    renderer.setClearColor(previousClearColor, previousClearAlpha);
    if (perspectiveCamera && previousCameraAspect !== null) {
      perspectiveCamera.aspect = previousCameraAspect;
      perspectiveCamera.updateProjectionMatrix();
    }
    for (const helper of hiddenHelpers) helper.object.visible = helper.visible;
    target.dispose();
  }
}

/** Render a project-aspect thumbnail without drawing into the visible canvas. */
export function captureProjectFrame(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  projectAspect: number,
): string | null {
  const size = captureSize(projectAspect);
  const canvas = document.createElement('canvas');
  if (!renderProjectFrameToCanvas(renderer, scene, camera, canvas, size)) return null;
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return null;
  }
}
