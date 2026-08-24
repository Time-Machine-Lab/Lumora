import { describe, expect, it } from 'vitest';
import {
  DEFAULT_TIMELINE_ZOOM,
  MAX_TIMELINE_ZOOM,
  MIN_TIMELINE_ZOOM,
  TimelineController,
  snapTimeToFrame,
} from '../src/timeline/timeline-controller';

describe('snapTimeToFrame：帧吸附', () => {
  it('24fps 下吸附到 1/24 秒刻度', () => {
    expect(snapTimeToFrame(0.3, 24)).toBeCloseTo(7 / 24);
    expect(snapTimeToFrame(1.001, 24)).toBe(1);
  });

  it('非正/无效 fps 原样返回', () => {
    expect(snapTimeToFrame(0.3, 0)).toBe(0.3);
    expect(snapTimeToFrame(0.3, NaN)).toBe(0.3);
  });

  it('负时间吸附后收敛为 0', () => {
    expect(snapTimeToFrame(-0.2, 24)).toBe(0);
  });
});

describe('TimelineController：统一时间引擎', () => {
  it('默认配置：24fps、时长 0、240px/s 缩放、吸附与循环开启', () => {
    const timeline = new TimelineController();
    expect(timeline.getFps()).toBe(24);
    expect(timeline.getDuration()).toBe(0);
    expect(timeline.getZoom()).toBe(DEFAULT_TIMELINE_ZOOM);
    expect(timeline.isSnapEnabled()).toBe(true);
    expect(timeline.isLoopEnabled()).toBe(true);
    expect(timeline.isPlaying()).toBe(false);
    expect(timeline.getTime()).toBe(0);
    expect(timeline.getFrame()).toBe(0);
  });

  it('seek：吸附到帧边界并收敛到 [0, duration]；帧号按 fps 取整', () => {
    const timeline = new TimelineController({ fps: 24, duration: 10 });
    timeline.seek(0.3);
    expect(timeline.getTime()).toBeCloseTo(7 / 24);
    expect(timeline.getFrame()).toBe(7);
    timeline.seek(-5);
    expect(timeline.getTime()).toBe(0);
    timeline.seek(99);
    expect(timeline.getTime()).toBe(10);
    expect(timeline.getFrame()).toBe(240);
  });

  it('seek snapOverride=false 跳过吸附；seek 时触发 time:changed（含 frame）', () => {
    const timeline = new TimelineController({ fps: 24, duration: 10 });
    const events: Array<{ time: number; frame: number }> = [];
    timeline.events.on('time:changed', (p) => events.push(p));
    timeline.seek(0.3, false);
    expect(timeline.getTime()).toBeCloseTo(0.3);
    expect(events).toHaveLength(1);
    expect(events[0]!.frame).toBe(7);
  });

  it('seek 到相同位置不重复发事件', () => {
    const timeline = new TimelineController({ fps: 24, duration: 10 });
    let count = 0;
    timeline.events.on('time:changed', () => count++);
    timeline.seek(0.3);
    timeline.seek(7 / 24);
    expect(count).toBe(1);
  });

  it('缩放：夹取到 [MIN, MAX]，zoomBy 相对缩放', () => {
    const timeline = new TimelineController();
    timeline.setZoom(1);
    expect(timeline.getZoom()).toBe(MIN_TIMELINE_ZOOM);
    timeline.setZoom(1e9);
    expect(timeline.getZoom()).toBe(MAX_TIMELINE_ZOOM);
    timeline.setZoom(240);
    timeline.zoomBy(2);
    expect(timeline.getZoom()).toBe(480);
  });

  it('设置变化触发 settings:changed；同值不触发', () => {
    const timeline = new TimelineController({ fps: 24, duration: 10 });
    const payloads: unknown[] = [];
    timeline.events.on('settings:changed', (p) => payloads.push(p));
    timeline.setFps(30);
    timeline.setSnap(false);
    timeline.setLoop(false);
    timeline.setZoom(500);
    timeline.setDuration(20);
    timeline.setFps(30); // 同值
    expect(payloads).toHaveLength(5);
    const last = payloads[4] as { fps: number; zoom: number; snap: boolean; loop: boolean; duration: number };
    expect(last).toEqual({ fps: 30, zoom: 500, snap: false, loop: false, duration: 20 });
  });

  it('时长缩短到播放头之后：播放头收敛到新时长', () => {
    const timeline = new TimelineController({ duration: 10 });
    timeline.seek(8);
    timeline.setDuration(5);
    expect(timeline.getTime()).toBe(5);
  });
});

describe('TimelineController：播放/暂停与 tick 推进', () => {
  it('空时间线（duration=0）：play 被阻塞，state 不变化', () => {
    const timeline = new TimelineController();
    let playing: boolean | null = null;
    timeline.events.on('state:changed', (p) => (playing = p.playing));
    timeline.play();
    expect(timeline.isPlaying()).toBe(false);
    expect(playing).toBeNull();
  });

  it('play → state:changed(true)；pause → state:changed(false)；重复调用不重复触发', () => {
    const timeline = new TimelineController({ duration: 10 });
    const states: boolean[] = [];
    timeline.events.on('state:changed', (p) => states.push(p.playing));
    timeline.play();
    timeline.play();
    timeline.pause();
    timeline.pause();
    expect(states).toEqual([true, false]);
  });

  it('tick 推进：dt 累加、每帧发 time:changed；播放头从末尾重播', () => {
    const timeline = new TimelineController({ fps: 24, duration: 4 });
    timeline.seek(4);
    const times: number[] = [];
    timeline.events.on('time:changed', (p) => times.push(p.time));
    timeline.play();
    timeline.tick(0.5);
    timeline.tick(0.5);
    expect(timeline.getTime()).toBeCloseTo(1);
    // 末尾重播经带事件的 seek(0) 收敛（审查一般项：重播不得静默改时间），
    // 事件序列 = [重播 0, tick 0.5, tick 1]
    expect(times).toHaveLength(3);
    expect(times[0]).toBe(0);
    expect(times[1]).toBeCloseTo(0.5);
    expect(times[2]).toBeCloseTo(1);
  });

  it('播放中把时长设为 0（空时间线）：一并暂停并发出 state:changed(false)', () => {
    const timeline = new TimelineController({ duration: 10 });
    timeline.seek(3);
    const states: boolean[] = [];
    timeline.events.on('state:changed', (p) => states.push(p.playing));
    timeline.play();
    timeline.setDuration(0);
    expect(timeline.isPlaying()).toBe(false);
    expect(timeline.getTime()).toBe(0);
    expect(states).toEqual([true, false]);
  });

  it('loop 开启：越过末尾按 duration 取模绕回', () => {
    const timeline = new TimelineController({ fps: 24, duration: 4, loop: true });
    timeline.seek(3.8); // 吸附到 91/24
    timeline.play();
    timeline.tick(0.5);
    expect(timeline.getTime()).toBeCloseTo(7 / 24); // 91/24 + 0.5 = 4.2916… → mod 4 = 7/24
    expect(timeline.isPlaying()).toBe(true);
  });

  it('loop 关闭：到末尾停住并自动暂停', () => {
    const timeline = new TimelineController({ fps: 24, duration: 4, loop: false });
    timeline.seek(3.8);
    const states: boolean[] = [];
    timeline.events.on('state:changed', (p) => states.push(p.playing));
    timeline.play();
    timeline.tick(0.5);
    expect(timeline.getTime()).toBe(4);
    expect(timeline.isPlaying()).toBe(false);
    expect(states).toEqual([true, false]);
    timeline.tick(0.5); // 已暂停：不再推进
    expect(timeline.getTime()).toBe(4);
  });

  it('暂停时 tick 不推进', () => {
    const timeline = new TimelineController({ duration: 10 });
    timeline.play();
    timeline.pause();
    timeline.tick(1);
    expect(timeline.getTime()).toBe(0);
  });

  it('togglePlay 在播放/暂停间切换；dispose 后事件订阅抛错', () => {
    const timeline = new TimelineController({ duration: 10 });
    timeline.togglePlay();
    expect(timeline.isPlaying()).toBe(true);
    timeline.togglePlay();
    expect(timeline.isPlaying()).toBe(false);
    timeline.dispose();
    expect(() => timeline.events.on('time:changed', () => undefined)).toThrow();
  });
});
