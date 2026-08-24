/**
 * 统一时间引擎（TML-52）：播放头、播放/暂停、缩放、吸附与帧率显示的
 * 框架无关控制器。只持有时间线 UI 运行态（不与项目数据耦合）；回放求值
 * 由 track-math 的纯函数完成，二者共同保证「同一时刻 → 同一画面」的确定性。
 */

import { TypedEventEmitter } from '../events/typed-event-emitter';

export interface TimelineEventMap {
  /** 播放头移动（seek/播放推进/录制推进）；frame = 按 fps 四舍五入的帧号 */
  'time:changed': { time: number; frame: number };
  /** 播放/暂停切换 */
  'state:changed': { playing: boolean };
  /** 缩放/吸附/帧率/时长/循环等设置变化 */
  'settings:changed': {
    fps: number;
    zoom: number;
    snap: boolean;
    loop: boolean;
    duration: number;
  };
  [event: string]: unknown;
}

export interface TimelineControllerOptions {
  fps?: number;
  /** 项目有效时长（秒） */
  duration?: number;
  /** 标尺缩放：像素/秒 */
  zoom?: number;
  /** 播放头/关键帧吸附到帧边界 */
  snap?: boolean;
  /** 播放到末尾后循环（缺省 true） */
  loop?: boolean;
}

/** 默认缩放：24fps 每帧 ≈ 10px（240px/s） */
export const DEFAULT_TIMELINE_ZOOM = 240;
export const MIN_TIMELINE_ZOOM = 30;
export const MAX_TIMELINE_ZOOM = 1200;

/** 时间吸附到帧边界（fps 无效/非正时原样返回） */
export function snapTimeToFrame(time: number, fps: number): number {
  if (!Number.isFinite(fps) || fps <= 0) return time;
  const frame = Math.round(time * fps);
  return Math.max(0, frame / fps);
}

export class TimelineController {
  readonly events = new TypedEventEmitter<TimelineEventMap>();

  private time = 0;
  private playing = false;
  private fps: number;
  private duration: number;
  private zoom: number;
  private snapToFrame: boolean;
  private loop: boolean;

  constructor(options: TimelineControllerOptions = {}) {
    this.fps = options.fps && options.fps > 0 ? options.fps : 24;
    this.duration = options.duration && options.duration > 0 ? options.duration : 0;
    this.zoom = this.clampZoom(options.zoom ?? DEFAULT_TIMELINE_ZOOM);
    this.snapToFrame = options.snap ?? true;
    this.loop = options.loop ?? true;
  }

  getTime(): number {
    return this.time;
  }

  /** 当前帧号（按 fps 四舍五入，非负） */
  getFrame(): number {
    return Math.round(this.time * this.fps);
  }

  isPlaying(): boolean {
    return this.playing;
  }

  getFps(): number {
    return this.fps;
  }

  getDuration(): number {
    return this.duration;
  }

  getZoom(): number {
    return this.zoom;
  }

  isSnapEnabled(): boolean {
    return this.snapToFrame;
  }

  isLoopEnabled(): boolean {
    return this.loop;
  }

  /** 项目设置接入：帧率（同时影响帧号/吸附刻度） */
  setFps(fps: number): void {
    const next = Number.isFinite(fps) && fps > 0 ? fps : 24;
    if (next === this.fps) return;
    this.fps = next;
    this.emitSettings();
  }

  /** 项目有效时长接入；播放中时长缩短到时点之后 → 收敛到新时长 */
  setDuration(duration: number): void {
    const next = Number.isFinite(duration) && duration > 0 ? duration : 0;
    if (next === this.duration) return;
    this.duration = next;
    if (this.time > next) this.seek(next);
    this.emitSettings();
  }

  setZoom(zoom: number): void {
    const next = this.clampZoom(zoom);
    if (next === this.zoom) return;
    this.zoom = next;
    this.emitSettings();
  }

  zoomBy(factor: number): void {
    this.setZoom(this.zoom * factor);
  }

  setSnap(enabled: boolean): void {
    if (enabled === this.snapToFrame) return;
    this.snapToFrame = enabled;
    this.emitSettings();
  }

  setLoop(enabled: boolean): void {
    if (enabled === this.loop) return;
    this.loop = enabled;
    this.emitSettings();
  }

  /** 移动播放头：收敛到 [0, duration]；snap 开启时吸附到帧边界（显式传
   *  snapOverride 可单次覆盖） */
  seek(time: number, snapOverride?: boolean): void {
    const clamped = this.clampTime(time);
    const doSnap = snapOverride ?? this.snapToFrame;
    const next = doSnap ? snapTimeToFrame(clamped, this.fps) : clamped;
    const bounded = Math.min(Math.max(0, next), this.duration);
    if (bounded === this.time) return;
    this.time = bounded;
    this.emitTime();
  }

  play(): void {
    if (this.playing) return;
    if (this.duration <= 0) return; // 空时间线无可播放内容
    if (this.time >= this.duration) this.time = 0; // 末尾重播从头开始
    this.playing = true;
    this.events.emit('state:changed', { playing: true });
  }

  pause(): void {
    if (!this.playing) return;
    this.playing = false;
    this.events.emit('state:changed', { playing: false });
  }

  togglePlay(): void {
    if (this.playing) this.pause();
    else this.play();
  }

  /** 播放推进：由宿主以 rAF/定时器节拍调用（dt 为真实流逝秒数）。
   *  到末尾：loop 开启时绕回，否则停在末尾并暂停。返回新时刻。 */
  tick(deltaSeconds: number): number {
    if (!this.playing || this.duration <= 0) return this.time;
    const dt = Number.isFinite(deltaSeconds) && deltaSeconds > 0 ? deltaSeconds : 0;
    if (dt === 0) return this.time;
    let next = this.time + dt;
    if (next >= this.duration) {
      if (this.loop) {
        next = next % this.duration;
      } else {
        next = this.duration;
        this.playing = false;
        this.time = next;
        this.emitTime();
        this.events.emit('state:changed', { playing: false });
        return next;
      }
    }
    this.time = next;
    this.emitTime();
    return this.time;
  }

  /** 销毁事件总线（宿主卸载时调用；此后事件订阅抛错） */
  dispose(): void {
    this.events.dispose();
  }

  private clampTime(time: number): number {
    if (!Number.isFinite(time)) return this.time;
    return Math.min(Math.max(0, time), this.duration);
  }

  private clampZoom(zoom: number): number {
    if (!Number.isFinite(zoom)) return DEFAULT_TIMELINE_ZOOM;
    return Math.min(MAX_TIMELINE_ZOOM, Math.max(MIN_TIMELINE_ZOOM, zoom));
  }

  private emitTime(): void {
    this.events.emit('time:changed', { time: this.time, frame: this.getFrame() });
  }

  private emitSettings(): void {
    this.events.emit('settings:changed', {
      fps: this.fps,
      zoom: this.zoom,
      snap: this.snapToFrame,
      loop: this.loop,
      duration: this.duration,
    });
  }
}
