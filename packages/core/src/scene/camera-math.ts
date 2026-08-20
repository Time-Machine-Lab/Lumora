/** 摄像机数学：焦距/FOV 换算与画幅适配（FR-005）。 */

export const FULL_FRAME_SENSOR = { width: 36, height: 24 } as const;

/** 焦距（mm）→ 垂直视场角（度） */
export function focalLengthToFovDeg(focalLengthMm: number, sensorHeightMm = FULL_FRAME_SENSOR.height): number {
  return (2 * Math.atan(sensorHeightMm / (2 * focalLengthMm)) * 180) / Math.PI;
}

/** 垂直视场角（度）→ 焦距（mm） */
export function fovDegToFocalLength(fovDeg: number, sensorHeightMm = FULL_FRAME_SENSOR.height): number {
  return sensorHeightMm / (2 * Math.tan((fovDeg * Math.PI) / 360));
}

/**
 * 将内容按目标宽高比适配进容器，返回居中黑边矩形（CSS 像素）。
 * 视口渲染与构图辅助线共用同一计算，保证画面与辅助线对齐。
 */
export function fitRect(
  containerWidth: number,
  containerHeight: number,
  aspect: number,
): { x: number; y: number; width: number; height: number } {
  if (containerWidth <= 0 || containerHeight <= 0 || !Number.isFinite(aspect) || aspect <= 0) {
    return { x: 0, y: 0, width: Math.max(containerWidth, 0), height: Math.max(containerHeight, 0) };
  }
  const containerAspect = containerWidth / containerHeight;
  if (containerAspect > aspect) {
    const height = containerHeight;
    const width = height * aspect;
    return { x: (containerWidth - width) / 2, y: 0, width, height };
  }
  const width = containerWidth;
  const height = width / aspect;
  return { x: 0, y: (containerHeight - height) / 2, width, height };
}
