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

function encodePixels(pixels: Uint8Array, width: number, height: number): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;
  const image = context.createImageData(width, height);
  const rowBytes = width * 4;
  for (let row = 0; row < height; row += 1) {
    const sourceStart = (height - row - 1) * rowBytes;
    image.data.set(pixels.subarray(sourceStart, sourceStart + rowBytes), row * rowBytes);
  }
  context.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** Render a project-aspect thumbnail without drawing into the visible canvas. */
export function captureProjectFrame(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene,
  camera: THREE.Camera,
  projectAspect: number,
): string | null {
  const { width, height, aspect } = captureSize(projectAspect);
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
    renderer.render(scene, camera);
    const pixels = new Uint8Array(width * height * 4);
    renderer.readRenderTargetPixels(target, 0, 0, width, height, pixels);
    return encodePixels(pixels, width, height);
  } catch {
    return null;
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
    target.dispose();
  }
}
