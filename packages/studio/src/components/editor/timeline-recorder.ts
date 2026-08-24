/**
 * 录制采样器（TML-52）：按播放头时间对机位节点采样 position/rotation/focalLength
 * 通道，停止后由 use-timeline-session 抽稀为关键帧。pause() 期间 sample() 为
 * no-op —— 页面失焦时暂停录制即不再采集（AC2）。
 */

import type { TrackSample } from '@lumora/core';
import type { CaptureNodeSample } from './camera-drive';

/** 采样源：给定机位对象 id 返回节点通道值；无节点或不可采时返回 null */
export type CaptureSource = (cameraObjectId: string) => CaptureNodeSample | null;

export interface RecorderChannels {
  position: TrackSample[];
  rotation: TrackSample[];
  /** focalLength 无有效值（非相机载荷）时为 null，对应通道不落轨 */
  focalLength: TrackSample[] | null;
}

export class TimelineRecorder {
  private cameraId: string | null = null;
  /** 录制绑定项目身份：提交前须与当前项目 uri 一致，否则样本作废（TML-52 审查第 7 项） */
  private projectUri: string | null = null;
  private paused = true;
  private source: CaptureSource | null = null;
  private positionSamples: TrackSample[] = [];
  private rotationSamples: TrackSample[] = [];
  private focalSamples: TrackSample[] = [];
  private focalSeen = false;

  setCaptureSource(source: CaptureSource | null): void {
    this.source = source;
  }

  get active(): boolean {
    return this.cameraId !== null;
  }

  get recordingCameraId(): string | null {
    return this.cameraId;
  }

  get boundProjectUri(): string | null {
    return this.projectUri;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  /** 开始录制：绑定机位（及所属项目）并清空上一轮样本 */
  start(cameraObjectId: string, projectUri: string | null): void {
    this.cameraId = cameraObjectId;
    this.projectUri = projectUri;
    this.paused = false;
    this.positionSamples = [];
    this.rotationSamples = [];
    this.focalSamples = [];
    this.focalSeen = false;
  }

  /** 暂停采样（页面失焦时调用）；不结束录制，之后可 resume */
  pause(): void {
    this.paused = true;
  }

  /** 恢复采样（仅录制进行中生效） */
  resume(): void {
    if (this.active) this.paused = false;
  }

  /** 采样当前时刻节点状态；返回是否采集到样本 */
  sample(time: number): boolean {
    if (!this.active || this.paused || !this.source) return false;
    const capture = this.source(this.cameraId!);
    if (!capture) return false;
    this.positionSamples.push({ time, value: capture.position });
    this.rotationSamples.push({ time, value: capture.rotation });
    if (capture.focalLength !== null) {
      this.focalSamples.push({ time, value: capture.focalLength });
      this.focalSeen = true;
    }
    return true;
  }

  /** 结束录制并返回各通道样本；未在录制中返回 null */
  stop(): RecorderChannels | null {
    if (!this.active) return null;
    const channels: RecorderChannels = {
      position: this.positionSamples,
      rotation: this.rotationSamples,
      focalLength: this.focalSeen ? this.focalSamples : null,
    };
    this.cameraId = null;
    this.projectUri = null;
    this.paused = true;
    this.positionSamples = [];
    this.rotationSamples = [];
    this.focalSamples = [];
    this.focalSeen = false;
    return channels;
  }
}
