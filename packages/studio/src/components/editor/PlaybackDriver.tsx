/**
 * 回放驱动（TML-52）：订阅时间引擎事件，把启用轨道的求值结果应用到场景节点。
 * - time:changed → 对当前播放头时间求值并写入节点（跳过录制机位与 gizmo 拖拽中的对象）
 * - state:changed(false)（暂停/停止）→ 还原全部节点到项目静态位姿
 * - project:changed（提交）→ 下一帧重放求值（同步场景已把节点还原为项目位姿，
 *   驱动须在其后把轨道值重新盖回，避免提交后视图与播放头脱节）
 * - 录制机位（recorder.active 期间）完全由驱动接管，既不应用也不还原 ——
 *   录制暂停（失焦）时节点停留在驾驶位姿，停止录制后由下一次事件统一收敛
 */

import { useEffect, useRef } from 'react';
import * as THREE from 'three';
import {
  evaluateTrack,
  focalLengthToFovDeg,
} from '@lumora/core';
import type { SceneEditor, TrackTargetPath, TrackKeyframeValue } from '@lumora/core';
import type { RefObject } from 'react';
import type { TimelineSession } from '../../hooks/use-timeline-session';
import { findNode } from './scene-builder';
import { restoreObjectOnNode } from './camera-drive';

export interface PlaybackDriverProps {
  session: TimelineSession;
  editor: SceneEditor;
  rootRef: RefObject<THREE.Group | null>;
  /** gizmo 拖拽中的对象 id：拖拽期间不覆盖节点（结束后提交会自然收敛） */
  skipIdsRef: RefObject<Set<string> | null>;
}

function applyTrackValue(node: THREE.Object3D, targetPath: TrackTargetPath, value: TrackKeyframeValue): void {
  switch (targetPath) {
    case 'position': {
      const v = value as [number, number, number];
      node.position.set(v[0], v[1], v[2]);
      break;
    }
    case 'rotation': {
      const v = value as [number, number, number];
      node.rotation.set(v[0], v[1], v[2]);
      break;
    }
    case 'scale': {
      const v = value as [number, number, number];
      node.scale.set(v[0], v[1], v[2]);
      break;
    }
    case 'focalLength': {
      if (node instanceof THREE.PerspectiveCamera) {
        (node.userData as Record<string, unknown>).focalLength = value as number;
        node.fov = focalLengthToFovDeg(value as number);
        node.updateProjectionMatrix();
      }
      break;
    }
  }
}

export function PlaybackDriver({ session, editor, rootRef, skipIdsRef }: PlaybackDriverProps) {
  const rootRefRef = useRef(rootRef);
  rootRefRef.current = rootRef;
  const skipRef = useRef(skipIdsRef);
  skipRef.current = skipIdsRef;
  // session.timeline / session.recorder 是稳定的实例（会话内部 useRef），
  // 事件订阅只依赖它们，状态驱动的 session 重建不引起重复订阅
  const { timeline, recorder } = session;

  useEffect(() => {
    let pendingRaf = 0;

    const apply = () => {
      const root = rootRefRef.current.current;
      const project = editor.getProject();
      if (!root || !project) return;
      const time = timeline.getTime();
      const skip = skipRef.current.current;
      for (const track of project.tracks) {
        if (track.disabled) continue;
        if (recorder.active && track.objectId === recorder.recordingCameraId) continue;
        if (skip?.has(track.objectId)) continue;
        const node = findNode(root, track.objectId);
        if (!node) continue;
        const evaluated = evaluateTrack(track, time);
        if (!evaluated) continue;
        applyTrackValue(node, track.targetPath, evaluated.value);
      }
    };

    const restore = () => {
      const root = rootRefRef.current.current;
      const project = editor.getProject();
      if (!root || !project) return;
      for (const object of project.objects) {
        if (recorder.active && object.id === recorder.recordingCameraId) continue;
        const node = findNode(root, object.id);
        if (!node) continue;
        restoreObjectOnNode(node, object);
      }
    };

    const subs = [
      timeline.events.on('time:changed', apply),
      timeline.events.on('state:changed', ({ playing }) => {
        if (!playing) restore();
      }),
      editor.events.on('project:changed', () => {
        // 提交后 scene sync 先把节点还原为项目位姿，驱动在下一帧把轨道值盖回
        cancelAnimationFrame(pendingRaf);
        pendingRaf = requestAnimationFrame(apply);
      }),
    ];
    return () => {
      cancelAnimationFrame(pendingRaf);
      for (const sub of subs) sub.dispose();
    };
  }, [timeline, recorder, editor]);

  return null;
}
