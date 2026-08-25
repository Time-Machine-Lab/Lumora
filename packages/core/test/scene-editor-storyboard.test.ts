import { describe, expect, it } from 'vitest';
import { SceneEditor } from '../src/editor/scene-editor';
import { createBlankProject } from '../src/project/create-project';
import type { ShotClipData } from '../src/scene/types';

type StoryboardShot = ShotClipData & {
  shotSize: 'wide' | 'medium' | 'close-up';
  movement: 'static' | 'tracking' | 'dolly-in';
  prompt: string;
  aiSource: { providerId: string; model: string; draftId: string };
};

const SHOTS: StoryboardShot[] = [
  {
    id: 'shot-ai-1',
    name: 'Arrival',
    cameraObjectId: null,
    startTime: 0,
    endTime: 4,
    shotSize: 'wide',
    movement: 'dolly-in',
    prompt: 'Wide market arrival in rain.',
    aiSource: { providerId: 'com.example.storyboard', model: 'storyboard-1', draftId: 'draft-1' },
  },
  {
    id: 'shot-ai-2',
    name: 'Pursuit',
    cameraObjectId: null,
    startTime: 4,
    endTime: 8,
    shotSize: 'medium',
    movement: 'tracking',
    prompt: 'Track beside the courier.',
    aiSource: { providerId: 'com.example.storyboard', model: 'storyboard-1', draftId: 'draft-1' },
  },
  {
    id: 'shot-ai-3',
    name: 'Reveal',
    cameraObjectId: null,
    startTime: 8,
    endTime: 12,
    shotSize: 'close-up',
    movement: 'static',
    prompt: 'Close on the opened case.',
    aiSource: { providerId: 'com.example.storyboard', model: 'storyboard-1', draftId: 'draft-1' },
  },
];

describe('SceneEditor storyboard adoption', () => {
  it('adopts three enriched shots in one undoable atomic mutation', () => {
    const editor = new SceneEditor();
    editor.openProject(createBlankProject('lumora://storyboard', 'Storyboard'));

    const result = editor.addShots(SHOTS, 'Adopt AI storyboard');

    expect(result.ok).toBe(true);
    expect(editor.getProject()?.shots).toEqual(SHOTS);
    expect(editor.getProject()?.revision).toBe(1);
    expect(editor.getHistoryState().undoLabel).toBe('Adopt AI storyboard');

    expect(editor.undo().ok).toBe(true);
    expect(editor.getProject()?.shots).toEqual([]);
    expect(editor.redo().ok).toBe(true);
    expect(editor.getProject()?.shots).toEqual(SHOTS);
  });

  it('rejects the whole batch when any enriched shot is invalid', () => {
    const editor = new SceneEditor();
    editor.openProject(createBlankProject('lumora://storyboard-invalid', 'Storyboard'));
    const invalid = SHOTS.map((shot) => structuredClone(shot));
    invalid[1]!.prompt = '';

    const result = editor.addShots(invalid, 'Adopt invalid storyboard');

    expect(result.ok).toBe(false);
    expect(editor.getProject()?.shots).toEqual([]);
    expect(editor.getProject()?.revision).toBe(0);
    expect(editor.getHistoryState().canUndo).toBe(false);
  });

  it('rejects credential-shaped and unexpected AI provenance fields', () => {
    const editor = new SceneEditor();
    editor.openProject(createBlankProject('lumora://storyboard-secret-source', 'Storyboard'));
    const shot = structuredClone(SHOTS[0]!) as StoryboardShot & { aiSource: StoryboardShot['aiSource'] & { apiKey: string } };
    shot.aiSource.apiKey = 'sk-should-never-persist';

    expect(editor.addShot(shot).ok).toBe(false);
    expect(editor.getProject()?.shots).toEqual([]);
  });

  it('rejects blank or unbounded AI provenance identifiers', () => {
    const editor = new SceneEditor();
    editor.openProject(createBlankProject('lumora://storyboard-invalid-source', 'Storyboard'));
    const blank = structuredClone(SHOTS[0]!);
    blank.aiSource.providerId = '   ';
    const unbounded = structuredClone(SHOTS[1]!);
    unbounded.aiSource.model = 'm'.repeat(257);

    expect(editor.addShot(blank).ok).toBe(false);
    expect(editor.addShot(unbounded).ok).toBe(false);
    expect(editor.getProject()?.shots).toEqual([]);
  });
});
