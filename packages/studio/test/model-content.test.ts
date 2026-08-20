import { describe, expect, it } from 'vitest';
import { createSampleProject } from '@lumora/core';
import type { AssetData, SceneObjectData } from '@lumora/core';
import { collectModelObjectIds } from '../src/components/editor/model-content';

/**
 * M2 SceneContent 消费收敛（TML-57 第五轮复审）：
 * hash → 活动场景全部 objectIds 映射。Ctrl+D 复制/多对象共享同一资源时，
 * 内容就绪后必须挂到全部节点而不是只挂首个；跨场景模型不消费当前视口内容。
 */

function modelObject(id: string, assetId?: string): SceneObjectData {
  return {
    id,
    type: 'model',
    name: id,
    parentId: null,
    transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] },
    visible: true,
    locked: false,
    ...(assetId ? { assetId } : {}),
  };
}

function asset(id: string, hash: string): AssetData {
  return {
    id,
    kind: 'gltf',
    name: `${id}.glb`,
    format: 'glb',
    mime: 'model/gltf-binary',
    hash,
    size: 1,
    source: 'file',
    storageRef: '',
    createdAt: '',
  };
}

describe('M2 collectModelObjectIds：活动场景 hash → 全部模型对象 id', () => {
  it('Ctrl+D 复制/多对象共享资源：同 assetId 多对象归并到同一 hash 条目', () => {
    const project = createSampleProject();
    project.objects.push(modelObject('model-a', 'asset-a'));
    project.objects.push(modelObject('model-b', 'asset-a')); // Ctrl+D 副本
    project.scenes[0]!.rootObjectIds.push('model-a', 'model-b');
    project.assets.push(asset('asset-a', 'hash-a'));

    const byHash = collectModelObjectIds(project);
    expect(byHash.size).toBe(1);
    expect(byHash.get('hash-a')).toEqual(['model-a', 'model-b']);
  });

  it('跨场景隔离：仅活动场景可达的模型入映射，其他场景不消费当前视口内容', () => {
    const project = createSampleProject();
    project.objects.push(modelObject('model-a', 'asset-a')); // 活动场景（scene-1）根
    project.scenes[0]!.rootObjectIds.push('model-a');
    project.objects.push(modelObject('model-b', 'asset-b')); // 场景 B 根：不可达
    project.scenes.push({ id: 'scene-2', name: '场景 B', rootObjectIds: ['model-b'], activeCameraId: null });
    project.assets.push(asset('asset-a', 'hash-a'), asset('asset-b', 'hash-b'));

    const byHash = collectModelObjectIds(project);
    expect(byHash.get('hash-a')).toEqual(['model-a']);
    expect(byHash.has('hash-b')).toBe(false);
  });

  it('挂载在组下的模型（非根）同样按可达集归并', () => {
    const project = createSampleProject();
    project.objects.push({ ...modelObject('model-a', 'asset-a'), parentId: 'sample-group' });
    project.assets.push(asset('asset-a', 'hash-a'));

    const byHash = collectModelObjectIds(project);
    expect(byHash.get('hash-a')).toEqual(['model-a']);
  });

  it('多资源各自成组；无 assetId/asset 不存在的对象不产生条目', () => {
    const project = createSampleProject();
    project.objects.push(modelObject('model-a', 'asset-a'));
    project.objects.push(modelObject('model-b', 'asset-b'));
    project.objects.push(modelObject('model-orphan', 'ghost-asset')); // asset 不存在
    project.objects.push(modelObject('model-no-asset')); // 无 assetId
    project.scenes[0]!.rootObjectIds.push('model-a', 'model-b', 'model-orphan', 'model-no-asset');
    project.assets.push(asset('asset-a', 'hash-a'), asset('asset-b', 'hash-b'));

    const byHash = collectModelObjectIds(project);
    expect(byHash.size).toBe(2);
    expect(byHash.get('hash-a')).toEqual(['model-a']);
    expect(byHash.get('hash-b')).toEqual(['model-b']);
  });
});
