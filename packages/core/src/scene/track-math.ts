/**
 * 轨道求值与采样数学（TML-52，虚拟拍摄）：
 * - evaluateTrack：给定时刻的确定性插值（step / linear / smooth），
 *   纯函数：同一轨道 + 同一时刻恒得同一值（AC：回放确定性）；
 * - getTrackDuration / getProjectDuration：轨道/项目有效时长（禁用轨道不计）；
 * - simplifySamples：录制采样简化（RDP 式按通道容差抽稀，保留首尾）。
 */

import type { Project, TrackData, TrackKeyframeData, TrackKeyframeValue, Vec3 } from './types';

/** 插值模式归属约定：区段 [kf[i], kf[i+1]] 使用左端点 kf[i] 的插值（出站插值），
 *  缺省 linear。step = 保持左端点值到下一帧（跳变）。 */
export function segmentInterpolation(keyframe: TrackKeyframeData): 'linear' | 'step' | 'smooth' {
  return keyframe.interpolation ?? 'linear';
}

/** 关键帧时刻是否单调升序（与 schema 校验同语义） */
export function isSortedKeyframes(keyframes: TrackKeyframeData[]): boolean {
  for (let i = 1; i < keyframes.length; i += 1) {
    if (keyframes[i]!.time <= keyframes[i - 1]!.time) return false;
  }
  return true;
}

/** 轨道有效时长：最后一个关键帧时刻；无关键帧为 0 */
export function getTrackDuration(track: TrackData): number {
  const last = track.keyframes[track.keyframes.length - 1];
  return last ? last.time : 0;
}

/** 项目有效时长：启用轨道的最晚关键帧时刻与全部分镜区段终点的最大值；全空为 0。
 *  禁用轨道不参与（禁用轨道、有效时长：NFR-018）。 */
export function getProjectDuration(project: Project): number {
  let duration = 0;
  for (const track of project.tracks) {
    if (track.disabled) continue;
    const trackEnd = getTrackDuration(track);
    if (trackEnd > duration) duration = trackEnd;
  }
  for (const shot of project.shots) {
    if (shot.endTime > duration) duration = shot.endTime;
  }
  return duration;
}

/** 单个分镜的有效时长 */
export function getShotDuration(shot: { startTime: number; endTime: number }): number {
  return Math.max(0, shot.endTime - shot.startTime);
}

export interface TrackEvaluation {
  /** 求值时刻（越界时收敛到首/末关键帧时刻） */
  time: number;
  /** 求值结果；标量通道为 number，Vec3 通道为 [x, y, z] */
  value: TrackKeyframeValue;
  /** 命中的关键帧区间（[left, right] 下标；单帧/越界时区间退化） */
  span: [number, number];
}

function lerpNumber(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function lerpVec3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [lerpNumber(a[0], b[0], t), lerpNumber(a[1], b[1], t), lerpNumber(a[2], b[2], t)];
}

/** Catmull-Rom 段求值（时间均匀参数化）：四个控制点 P0..P3 对应时刻 t0..t3，
 *  段 [t1, t2] 内插值；端点处用单侧切线（钳制端）。确定性纯函数。
 *  切线尺度修正：导数项乘当前段时长 (t2 - t1) —— 否则时间缩放 2 倍后
 *  相对中点值漂移（Hermite 基 h10/h11 中的 u 是无量纲参数，切线须换算回
 *  时间单位）。 */
function catmullRomAt(
  p0: number[], p1: number[], p2: number[], p3: number[],
  t0: number, t1: number, t2: number, t3: number,
  t: number,
): number[] {
  const u = (t - t1) / (t2 - t1);
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const seg = t2 - t1;
  const m1 = p0.map((v, i) => ((p2[i]! - v) * seg) / (t2 - t0));
  const m2 = p2.map((v, i) => ((p3[i]! - p1[i]!) * seg) / (t3 - t1));
  return p1.map((v, i) => h00 * v + h10 * m1[i]! + h01 * p2[i]! + h11 * m2[i]!);
}

/**
 * 保形（单调）三次插值段求值（Fritsch-Carlson）：控制点 P0..P3 对应时刻
 * t0..t3，段 [t1, t2] 内插值。端斜率取相邻分段差商的调和均值，符号反转时
 * 置 0（局部极值变平）；端点缺失侧用单侧差商（钳制端）。保证值不出段两端
 * 范围 —— 焦距等正值通道不会因过冲产生负值。确定性纯函数。
 */
function monotoneHermiteAt(
  p0: number, p1: number, p2: number, p3: number,
  t0: number, t1: number, t2: number, t3: number,
  t: number,
): number {
  const dLeft = t1 > t0 ? (p1 - p0) / (t1 - t0) : null;
  const dMid = (p2 - p1) / (t2 - t1);
  const dRight = t3 > t2 ? (p3 - p2) / (t3 - t2) : null;
  const slope = (dA: number | null, dB: number): number => {
    if (dA === null) return dB;
    if (dA * dB <= 0) return 0;
    return 2 / (1 / dA + 1 / dB);
  };
  const m1 = slope(dLeft, dMid);
  const m2 = slope(dRight, dMid);
  const u = (t - t1) / (t2 - t1);
  const u2 = u * u;
  const u3 = u2 * u;
  const h00 = 2 * u3 - 3 * u2 + 1;
  const h10 = u3 - 2 * u2 + u;
  const h01 = -2 * u3 + 3 * u2;
  const h11 = u3 - u2;
  const seg = t2 - t1;
  return h00 * p1 + h10 * seg * m1 + h01 * p2 + h11 * seg * m2;
}

// ---------- 旋转通道：四元数 slerp（TML-52 回放一致性） ----------
// Euler 三分量逐分量插值在表示边界（THREE 由四元数导出欧拉时把 yaw 规范到
// [-π, π]，纯 yaw 连续推进会在 π 处把 x/z 一并翻转）产生物理位姿几乎不变、
// 数值却跳变 π 的相邻采样，逐分量 lerp 会插出一条完全错误的路径。旋转通道
// 统一走最短弧 slerp：录制采样与回放求值同一语义，跨边界不再跳变。
// 约定与 three.js 默认一致：Euler order 'XYZ'（内在 X→Y→Z，q = qx·qy·qz）。

type Quat = [number, number, number, number]; // [x, y, z, w]

function eulerToQuat(x: number, y: number, z: number): Quat {
  const cx = Math.cos(x / 2);
  const sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2);
  const sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2);
  const sz = Math.sin(z / 2);
  return [
    sx * cy * cz + cx * sy * sz,
    cx * sy * cz - sx * cy * sz,
    cx * cy * sz + sx * sy * cz,
    cx * cy * cz - sx * sy * sz,
  ];
}

/** 四元数 → Euler（three.js Euler.setFromQuaternion 的 'XYZ' 提取） */
function quatToEuler(q: Quat): Vec3 {
  const [x, y, z, w] = q;
  const m13 = 2 * (x * z + y * w);
  const eulerY = Math.asin(Math.min(1, Math.max(-1, m13)));
  if (Math.abs(m13) < 0.9999999) {
    const m23 = 2 * (y * z - x * w);
    const m33 = 1 - 2 * (x * x + y * y);
    const m12 = 2 * (x * y - z * w);
    const m11 = 1 - 2 * (y * y + z * z);
    return [Math.atan2(-m23, m33), eulerY, Math.atan2(-m12, m11)];
  }
  const m32 = 2 * (y * z + x * w);
  const m22 = 1 - 2 * (x * x + z * z);
  return [Math.atan2(m32, m22), eulerY, 0];
}

/** 最短弧球面插值（标准 slerp，含共线/同向退化处理） */
function slerpQuat(a: Quat, b: Quat, t: number): Quat {
  const [ax, ay, az, aw] = a;
  let [bx, by, bz, bw] = b;
  let dot = ax * bx + ay * by + az * bz + aw * bw;
  if (dot < 0) {
    bx = -bx; by = -by; bz = -bz; bw = -bw;
    dot = -dot;
  }
  if (dot > 0.9995) {
    // 近似同向：线性插值 + 归一化（避免 acos(≈1) 数值病态）
    const k = t;
    const inv = 1 - t;
    const len = Math.hypot(ax * inv + bx * k, ay * inv + by * k, az * inv + bz * k, aw * inv + bw * k);
    return [(ax * inv + bx * k) / len, (ay * inv + by * k) / len, (az * inv + bz * k) / len, (aw * inv + bw * k) / len];
  }
  const omega = Math.acos(dot);
  const sinOmega = Math.sin(omega);
  const ka = Math.sin((1 - t) * omega) / sinOmega;
  const kb = Math.sin(t * omega) / sinOmega;
  return [ax * ka + bx * kb, ay * ka + by * kb, az * ka + bz * kb, aw * ka + bw * kb];
}

function rotationEulerAt(left: Vec3, right: Vec3, t: number): Vec3 {
  return quatToEuler(slerpQuat(eulerToQuat(left[0], left[1], left[2]), eulerToQuat(right[0], right[1], right[2]), t));
}

/**
 * 轨道确定性求值：时刻 t 处的目标值。
 * - 无关键帧（或禁用轨道）→ null；
 * - t 落在首/末关键帧之外 → 保持端点值；
 * - 段内：step 保持左值；linear 线性插值；smooth 平滑插值；
 *   旋转通道（linear/smooth 一致）走最短弧四元数 slerp，跨表示边界不翻转；
 *   标量通道 smooth 走保形三次（正值域不越界）；其余 Vec3 smooth 经
 *   Catmull-Rom 平滑（端点钳制）。
 */
export function evaluateTrack(track: TrackData, time: number): TrackEvaluation | null {
  if (track.disabled || track.keyframes.length === 0) return null;
  const keyframes = track.keyframes;
  if (!isSortedKeyframes(keyframes)) return null;
  const first = keyframes[0]!;
  const last = keyframes[keyframes.length - 1]!;
  const scalar = typeof first.value === 'number';
  const asArray = (value: TrackKeyframeValue): number[] =>
    typeof value === 'number' ? [value] : [...value];

  if (time <= first.time) {
    return { time: first.time, value: first.value, span: [0, 0] };
  }
  if (time >= last.time) {
    return { time: last.time, value: last.value, span: [keyframes.length - 1, keyframes.length - 1] };
  }
  // 二分定位区间 [i, i+1]（关键帧升序）
  let lo = 0;
  let hi = keyframes.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (keyframes[mid]!.time <= time) lo = mid;
    else hi = mid;
  }
  const left = keyframes[lo]!;
  const right = keyframes[hi]!;
  const mode = segmentInterpolation(left);

  if (mode === 'step') {
    return { time, value: left.value, span: [lo, hi] };
  }
  const t = (time - left.time) / (right.time - left.time);
  const isRotation = track.targetPath === 'rotation';
  if (mode === 'linear') {
    if (isRotation) {
      return { time, value: rotationEulerAt(left.value as Vec3, right.value as Vec3, t), span: [lo, hi] };
    }
    const value = scalar
      ? lerpNumber(left.value as number, right.value as number, t)
      : lerpVec3(left.value as Vec3, right.value as Vec3, t);
    return { time, value, span: [lo, hi] };
  }
  // smooth：Vec3 走 Catmull-Rom（端点钳制单侧切线）；旋转统一走最短弧 slerp
  // （跨表示边界逐分量 Hermite 同样会翻转）；标量走保形三次（焦距正值域）。
  if (isRotation) {
    return { time, value: rotationEulerAt(left.value as Vec3, right.value as Vec3, t), span: [lo, hi] };
  }
  if (scalar) {
    const p0 = lo > 0 ? (keyframes[lo - 1]!.value as number) : (left.value as number);
    const p1 = left.value as number;
    const p2 = right.value as number;
    const p3 = hi < keyframes.length - 1 ? (keyframes[hi + 1]!.value as number) : (right.value as number);
    const t0 = lo > 0 ? keyframes[lo - 1]!.time : left.time;
    const t1 = left.time;
    const t2 = right.time;
    const t3 = hi < keyframes.length - 1 ? keyframes[hi + 1]!.time : right.time;
    const value = monotoneHermiteAt(p0, p1, p2, p3, t0, t1, t2, t3, time);
    return { time, value, span: [lo, hi] };
  }
  const p0 = lo > 0 ? asArray(keyframes[lo - 1]!.value) : asArray(left.value);
  const p1 = asArray(left.value);
  const p2 = asArray(right.value);
  const p3 = hi < keyframes.length - 1 ? asArray(keyframes[hi + 1]!.value) : asArray(right.value);
  const t0 = lo > 0 ? keyframes[lo - 1]!.time : left.time;
  const t1 = left.time;
  const t2 = right.time;
  const t3 = hi < keyframes.length - 1 ? keyframes[hi + 1]!.time : right.time;
  const result = catmullRomAt(p0, p1, p2, p3, t0, t1, t2, t3, time);
  return { time, value: [result[0]!, result[1]!, result[2]!], span: [lo, hi] };
}

/** 录制采样：时刻 + 该时刻的目标值（与关键帧同型） */
export interface TrackSample {
  time: number;
  value: TrackKeyframeValue;
}

export interface SimplifyOptions {
  /** 通道语义：rotation 走最短弧 slerp 角距离（与回放 evaluateTrack 同源，
   *  兼容 Euler 直线误差反例）；缺省按值类型推断（标量=绝对值，Vec3=欧氏距离） */
  channel?: 'position' | 'rotation' | 'focalLength';
  /** Vec3 通道容差（欧氏距离）：position 单位米（默认 0.01）、rotation 单位弧度（默认 0.01） */
  vecEpsilon?: number;
  /** 标量通道容差（默认 0.1，如焦距 mm） */
  scalarEpsilon?: number;
}

const DEFAULT_VEC_EPSILON = 0.01;
const DEFAULT_SCALAR_EPSILON = 0.1;

/** 样本到区间 [a, b] 线性插值的偏差（Vec3 欧氏距离 / 标量绝对值） */
function deviationToSegment(sample: TrackSample, a: TrackSample, b: TrackSample): number {
  if (b.time === a.time) return 0;
  const t = (sample.time - a.time) / (b.time - a.time);
  if (typeof a.value === 'number') {
    const interpolated = lerpNumber(a.value as number, b.value as number, t);
    return Math.abs(sample.value as number - interpolated);
  }
  const interpolated = lerpVec3(a.value as Vec3, b.value as Vec3, t);
  const dx = (sample.value as Vec3)[0] - interpolated[0];
  const dy = (sample.value as Vec3)[1] - interpolated[1];
  const dz = (sample.value as Vec3)[2] - interpolated[2];
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** 旋转样本到区间 [a, b] 的偏差：回放求值为两端 quaternion 最短弧 slerp 的
 *  角距离（与 evaluateTrack 同源）—— 抽稀判定与回放数学一致。Euler 直线
 *  误差会把落在直线弦上的复合旋转样本误判为「无偏差」而抽成 2 帧，回放却
 *  走 slerp 产生 0.34rad 级夹角误差（TML-52 复审阻断 1）。 */
function rotationDeviationToSegment(sample: TrackSample, a: TrackSample, b: TrackSample): number {
  if (b.time === a.time) return 0;
  const t = (sample.time - a.time) / (b.time - a.time);
  const interpolated = rotationEulerAt(a.value as Vec3, b.value as Vec3, t);
  const q1 = eulerToQuat(
    (sample.value as Vec3)[0], (sample.value as Vec3)[1], (sample.value as Vec3)[2],
  );
  const q2 = eulerToQuat(interpolated[0], interpolated[1], interpolated[2]);
  const dot = Math.abs(q1[0] * q2[0] + q1[1] * q2[1] + q1[2] * q2[2] + q1[3] * q2[3]);
  return 2 * Math.acos(Math.min(1, dot));
}

/**
 * 采样简化（RDP 抽稀）：始终保留首尾样本，递归剔除与「两端连线的插值」偏差
 * 不超过容差的中间样本（rotation 通道按 slerp 角距离判定，与回放求值同源，
 * 其余按欧氏距离/绝对值）。结果保持时间升序；输入须已按时间升序（非法输入
 * 原样返回防御）。递归深度受样本数限制（最坏 O(n) 栈深，n 为 5s@60Hz≈300 级）。
 */
export function simplifySamples(samples: TrackSample[], options: SimplifyOptions = {}): TrackSample[] {
  if (samples.length <= 2) return [...samples];
  for (let i = 1; i < samples.length; i += 1) {
    if (!(samples[i]!.time > samples[i - 1]!.time)) return [...samples];
  }
  const scalar = typeof samples[0]!.value === 'number';
  const epsilon = scalar ? options.scalarEpsilon ?? DEFAULT_SCALAR_EPSILON : options.vecEpsilon ?? DEFAULT_VEC_EPSILON;
  const isRotation = options.channel === 'rotation';
  const kept: TrackSample[] = [samples[0]!];

  const rdp = (start: number, end: number): void => {
    let maxDeviation = 0;
    let maxIndex = -1;
    for (let i = start + 1; i < end; i += 1) {
      const deviation = isRotation
        ? rotationDeviationToSegment(samples[i]!, samples[start]!, samples[end]!)
        : deviationToSegment(samples[i]!, samples[start]!, samples[end]!);
      if (deviation > maxDeviation) {
        maxDeviation = deviation;
        maxIndex = i;
      }
    }
    if (maxIndex === -1 || maxDeviation <= epsilon) return;
    rdp(start, maxIndex);
    kept.push(samples[maxIndex]!);
    rdp(maxIndex, end);
  };

  rdp(0, samples.length - 1);
  kept.push(samples[samples.length - 1]!);
  return kept;
}
