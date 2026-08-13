import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryTaskSopDraftStore, type TaskSopDraftStore } from '../../src/persistence/taskSopDraftStore';
import { TaskSopSyncEngine, type TaskSopSyncState } from '../../src/persistence/taskSopSyncEngine';

type Value = { title: string; description: string };

afterEach(() => vi.useRealTimers());

describe('TaskSopSyncEngine', () => {
  it('durably journals rapid edits and coalesces them into one server save', async () => {
    vi.useFakeTimers();
    const save = vi.fn().mockResolvedValue({ etag: 'e2' });
    const store = new MemoryTaskSopDraftStore<Value>();
    const engine = new TaskSopSyncEngine({
      resourceName: 'taskSops/demo',
      initial: { value: { title: 'Base', description: '' }, etag: 'e1' },
      store,
      transport: { save, read: vi.fn() },
    });
    await engine.initialized();

    for (let index = 1; index <= 100; index += 1) {
      await engine.submit({ title: 'Base', description: 'x'.repeat(index) });
    }
    expect(save).not.toHaveBeenCalled();
    expect((await store.load('taskSops/demo'))?.journal).toHaveLength(100);

    await vi.advanceTimersByTimeAsync(600);
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(
      'taskSops/demo',
      { title: 'Base', description: 'x'.repeat(100) },
      'e1',
      expect.objectContaining({ mutationId: expect.any(String), editorSessionId: expect.any(String) }),
    );
    expect(engine.hasUnsavedChanges).toBe(false);
    expect((await store.load('taskSops/demo'))?.journal).toEqual([]);
  });

  it('automatically retries an unknown result with the same mutation id', async () => {
    vi.useFakeTimers();
    const save = vi.fn()
      .mockRejectedValueOnce({ kind: 'retryable', message: 'lost response', unknownOutcome: true })
      .mockResolvedValueOnce({ etag: 'e2' });
    const engine = new TaskSopSyncEngine({
      resourceName: 'taskSops/demo',
      initial: { value: { title: 'Base', description: '' }, etag: 'e1' },
      store: new MemoryTaskSopDraftStore(),
      transport: { save, read: vi.fn() },
      random: () => 0.5,
    });
    await engine.initialized();
    await engine.submit({ title: 'Local', description: '' }, 'immediate');
    await vi.advanceTimersByTimeAsync(0);
    expect(save).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][3].mutationId).toBe(save.mock.calls[0][3].mutationId);
    expect(engine.hasUnsavedChanges).toBe(false);
  });

  it('auto-merges disjoint remote changes and exposes only genuine conflicts', async () => {
    vi.useFakeTimers();
    const states: Array<TaskSopSyncState<Value>> = [];
    const save = vi.fn()
      .mockRejectedValueOnce({
        kind: 'conflict', message: 'stale', serverEtag: 'e2',
        serverValue: { title: 'Base', description: 'Remote' },
      })
      .mockResolvedValueOnce({ etag: 'e3' });
    const engine = new TaskSopSyncEngine({
      resourceName: 'taskSops/demo',
      initial: { value: { title: 'Base', description: '' }, etag: 'e1' },
      store: new MemoryTaskSopDraftStore(),
      transport: { save, read: vi.fn() },
      onStateChange: (state) => states.push(state),
    });
    await engine.initialized();
    await engine.submit({ title: 'Local', description: '' }, 'immediate');
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toEqual({ title: 'Local', description: 'Remote' });
    expect(states.some((state) => state.kind === 'conflict')).toBe(false);

    const conflictingSave = vi.fn().mockRejectedValue({
      kind: 'conflict', message: 'stale', serverEtag: 'e2',
      serverValue: { title: 'Remote', description: '' },
    });
    const conflicting = new TaskSopSyncEngine({
      resourceName: 'taskSops/conflict',
      initial: { value: { title: 'Base', description: '' }, etag: 'e1' },
      store: new MemoryTaskSopDraftStore(),
      transport: { save: conflictingSave, read: vi.fn() },
    });
    await conflicting.initialized();
    await conflicting.submit({ title: 'Local', description: '' }, 'immediate');
    await vi.runAllTimersAsync();
    expect(conflicting.state).toMatchObject({
      kind: 'conflict',
      conflict: { conflicts: [expect.objectContaining({ path: ['title'] })] },
    });
    expect(conflicting.localValue.title).toBe('Local');
  });

  it('falls back to the server when browser durability is unavailable and blocks if both fail', async () => {
    const unavailable: TaskSopDraftStore<Value> = {
      load: vi.fn().mockRejectedValue(new Error('unavailable')),
      initialize: vi.fn().mockRejectedValue(new Error('unavailable')),
      mutate: vi.fn().mockRejectedValue(new Error('unavailable')),
      remove: vi.fn(),
    };
    const online = new TaskSopSyncEngine({
      resourceName: 'taskSops/online',
      initial: { value: { title: 'Base', description: '' }, etag: 'e1' },
      store: unavailable,
      transport: { save: vi.fn().mockResolvedValue({ etag: 'e2' }), read: vi.fn() },
    });
    await online.initialized();
    await expect(online.submit({ title: 'Server only', description: '' })).resolves.toBe(true);
    expect(online.hasUnsavedChanges).toBe(false);

    const offline = new TaskSopSyncEngine({
      resourceName: 'taskSops/offline',
      initial: { value: { title: 'Base', description: '' }, etag: 'e1' },
      store: unavailable,
      transport: {
        save: vi.fn().mockRejectedValue({ kind: 'retryable', message: 'offline', unknownOutcome: true }),
        read: vi.fn(),
      },
    });
    await offline.initialized();
    await expect(offline.submit({ title: 'Unsafe', description: '' })).resolves.toBe(false);
    expect(offline.state).toMatchObject({ kind: 'blocked' });
    expect(offline.localValue.title).toBe('Unsafe');
  });

  it('recovers a journaled draft after a new engine instance is created', async () => {
    vi.useFakeTimers();
    const store = new MemoryTaskSopDraftStore<Value>();
    const first = new TaskSopSyncEngine({
      resourceName: 'taskSops/recover',
      initial: { value: { title: 'Base', description: '' }, etag: 'e1' },
      store,
      transport: { save: vi.fn(), read: vi.fn() },
    });
    await first.initialized();
    await first.submit({ title: 'Recovered', description: 'draft' });
    first.destroy();

    const save = vi.fn().mockResolvedValue({ etag: 'e2' });
    const second = new TaskSopSyncEngine({
      resourceName: 'taskSops/recover',
      initial: { value: { title: 'Base', description: '' }, etag: 'e1' },
      store,
      transport: { save, read: vi.fn() },
    });
    await second.initialized();
    expect(second.localValue).toEqual({ title: 'Recovered', description: 'draft' });
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledOnce();
    expect(second.hasUnsavedChanges).toBe(false);
  });

  it('starts a new mutation after the user fixes a terminal validation error', async () => {
    vi.useFakeTimers();
    const save = vi.fn()
      .mockRejectedValueOnce({ kind: 'terminal', code: 'VALIDATION', message: 'invalid' })
      .mockResolvedValueOnce({ etag: 'e2' });
    const engine = new TaskSopSyncEngine({
      resourceName: 'taskSops/validation',
      initial: { value: { title: 'Base', description: '' }, etag: 'e1' },
      store: new MemoryTaskSopDraftStore(),
      transport: { save, read: vi.fn() },
    });
    await engine.initialized();
    await engine.submit({ title: '', description: '' }, 'immediate');
    await vi.runAllTimersAsync();
    expect(engine.state).toMatchObject({ kind: 'terminal', code: 'VALIDATION' });

    await engine.submit({ title: 'Fixed', description: '' }, 'immediate');
    await vi.runAllTimersAsync();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][1]).toEqual({ title: 'Fixed', description: '' });
    expect(save.mock.calls[1][3].mutationId).not.toBe(save.mock.calls[0][3].mutationId);
    expect(engine.hasUnsavedChanges).toBe(false);
  });
});
