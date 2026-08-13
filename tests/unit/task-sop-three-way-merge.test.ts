import { describe, expect, it } from 'vitest';
import { mergeTaskSopDraft, setMergedValue } from '../../src/persistence/taskSopThreeWayMerge';

describe('TaskSop three-way merge', () => {
  it('automatically merges edits to different fields', () => {
    const base = { title: 'Base', description: 'Base description', scene: 'scene-a' };
    const local = { ...base, title: 'Local title' };
    const remote = { ...base, description: 'Remote description' };

    expect(mergeTaskSopDraft(base, local, remote)).toEqual({
      value: { title: 'Local title', description: 'Remote description', scene: 'scene-a' },
      conflicts: [],
    });
  });

  it('reports a real same-field conflict without discarding either value', () => {
    const result = mergeTaskSopDraft(
      { title: 'Base' },
      { title: 'Local' },
      { title: 'Remote' },
    );

    expect(result.value).toEqual({ title: 'Local' });
    expect(result.conflicts).toEqual([expect.objectContaining({
      path: ['title'], baseValue: 'Base', localValue: 'Local', remoteValue: 'Remote', reason: 'value',
    })]);
  });

  it('merges different stable-id items and detects delete-versus-edit', () => {
    const base = { steps: [{ id: 'a', text: 'A' }, { id: 'b', text: 'B' }] };
    const disjoint = mergeTaskSopDraft(
      base,
      { steps: [{ id: 'a', text: 'Local A' }, { id: 'b', text: 'B' }] },
      { steps: [{ id: 'a', text: 'A' }, { id: 'b', text: 'Remote B' }] },
    );
    expect(disjoint.conflicts).toEqual([]);
    expect(disjoint.value.steps).toEqual([{ id: 'a', text: 'Local A' }, { id: 'b', text: 'Remote B' }]);

    const deletion = mergeTaskSopDraft(
      base,
      { steps: [{ id: 'b', text: 'B' }] },
      { steps: [{ id: 'a', text: 'Remote A' }, { id: 'b', text: 'B' }] },
    );
    expect(deletion.conflicts).toEqual([expect.objectContaining({ path: ['steps', 'id:a'], reason: 'delete-edit' })]);
    expect(setMergedValue(deletion.value, ['steps', 'id:a'], undefined).steps).toEqual([{ id: 'b', text: 'B' }]);
  });

  it('treats incompatible reorder and non-addressable lists conservatively', () => {
    const reordered = mergeTaskSopDraft(
      { steps: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
      { steps: [{ id: 'b' }, { id: 'a' }, { id: 'c' }] },
      { steps: [{ id: 'a' }, { id: 'c' }, { id: 'b' }] },
    );
    expect(reordered.conflicts).toEqual([expect.objectContaining({ path: ['steps'], reason: 'order' })]);

    const unaddressable = mergeTaskSopDraft(
      { labels: ['a'] },
      { labels: ['a', 'b'] },
      { labels: ['a', 'c'] },
    );
    expect(unaddressable.conflicts).toEqual([expect.objectContaining({ path: ['labels'], reason: 'unaddressable-list' })]);
  });
});
