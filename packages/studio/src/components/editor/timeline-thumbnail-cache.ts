import type { Project } from '@lumora/core';

/** Stable projection of persisted data that can affect a rendered shot frame. */
export function projectContentFingerprint(project: Project): string {
  const projection = {
    activeSceneId: project.activeSceneId,
    settings: project.settings,
    scenes: project.scenes,
    objects: project.objects,
    tracks: project.tracks,
    shots: project.shots,
    assets: project.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      name: asset.name,
      format: asset.format,
      mime: asset.mime,
      hash: asset.hash,
      size: asset.size,
      source: asset.source,
    })),
  };
  let hash = 5381;
  for (const char of JSON.stringify(projection)) {
    hash = ((hash << 5) + hash + char.charCodeAt(0)) >>> 0;
  }
  return hash.toString(36);
}
