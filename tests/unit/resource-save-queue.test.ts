import { describe, expect, it, vi } from 'vitest';
import { ResourceSaveQueue, type ResourceSaveTransport } from '../../src/persistence/resourceSaveQueue';

type Value = { title: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('ResourceSaveQueue', () => {
  it('serializes requests and coalesces pending edits to the latest value', async () => {
    const first = deferred<{ etag: string }>();
    const save = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ etag: 'e3' });
    const transport: ResourceSaveTransport<Value> = {
      save,
      read: vi.fn(),
    };
    const queue = new ResourceSaveQueue({ resourceName: 'materials/cup', initial: { value: { title: 'a' }, etag: 'e1' }, transport });

    queue.submit({ title: 'b' });
    queue.submit({ title: 'c' });
    queue.submit({ title: 'd' });
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenNthCalledWith(1, 'materials/cup', { title: 'b' }, 'e1');

    first.resolve({ etag: 'e2' });
    await settle();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, 'materials/cup', { title: 'd' }, 'e2');
    expect(queue.state).toMatchObject({ kind: 'ready', etag: 'e3' });
    expect(queue.hasUnsavedChanges).toBe(false);
  });

  it('pauses conflicts without losing local content and reloads only after confirmation', async () => {
    const save = vi.fn().mockRejectedValue({
      kind: 'conflict', message: 'stale', serverValue: { title: 'server' }, serverEtag: 'e2',
    });
    const queue = new ResourceSaveQueue({
      resourceName: 'requirements/demo', initial: { value: { title: 'base' }, etag: 'e1' },
      transport: { save, read: vi.fn() },
    });
    queue.submit({ title: 'local' });
    await settle();

    expect(queue.state).toMatchObject({ kind: 'paused-conflict', serverEtag: 'e2' });
    expect(queue.localValue).toEqual({ title: 'local' });
    expect(queue.hasUnsavedChanges).toBe(true);
    queue.reloadServer(false);
    expect(queue.localValue).toEqual({ title: 'local' });
    queue.reloadServer(true);
    expect(queue.localValue).toEqual({ title: 'server' });
    expect(queue.hasUnsavedChanges).toBe(false);
  });

  it('rereads an unknown outcome and adopts an already committed value', async () => {
    const transport: ResourceSaveTransport<Value> = {
      save: vi.fn().mockRejectedValue({ kind: 'retryable', message: 'connection lost', unknownOutcome: true }),
      read: vi.fn().mockResolvedValue({ value: { title: 'local' }, etag: 'e2' }),
    };
    const queue = new ResourceSaveQueue({ resourceName: 'taskSops/demo', initial: { value: { title: 'base' }, etag: 'e1' }, transport });
    queue.submit({ title: 'local' });
    await settle();
    await queue.retry();

    expect(transport.save).toHaveBeenCalledTimes(1);
    expect(queue.state).toMatchObject({ kind: 'ready', etag: 'e2' });
    expect(queue.hasUnsavedChanges).toBe(false);
  });

  it('acknowledges a committed unknown outcome before saving the newest pending edit', async () => {
    const first = deferred<{ etag: string }>();
    const save = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ etag: 'e3' });
    const read = vi.fn().mockResolvedValue({ value: { title: 'a' }, etag: 'e2' });
    const queue = new ResourceSaveQueue({
      resourceName: 'taskSops/demo', initial: { value: { title: 'base' }, etag: 'e1' },
      transport: { save, read },
    });

    queue.submit({ title: 'a' });
    queue.submit({ title: 'b' });
    first.reject({ kind: 'retryable', message: 'connection lost', unknownOutcome: true });
    await settle();
    await queue.retry();

    expect(read).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, 'taskSops/demo', { title: 'b' }, 'e2');
    expect(queue.state).toMatchObject({ kind: 'ready', etag: 'e3' });
    expect(queue.hasUnsavedChanges).toBe(false);
  });

  it('resends the newest local edit when an unknown outcome left the server etag unchanged', async () => {
    const first = deferred<{ etag: string }>();
    const save = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ etag: 'e2' });
    const read = vi.fn().mockResolvedValue({ value: { title: 'base' }, etag: 'e1' });
    const queue = new ResourceSaveQueue({
      resourceName: 'taskSops/demo', initial: { value: { title: 'base' }, etag: 'e1' },
      transport: { save, read },
    });

    queue.submit({ title: 'a' });
    queue.submit({ title: 'b' });
    first.reject({ kind: 'retryable', message: 'connection lost', unknownOutcome: true });
    await settle();
    await queue.retry();

    expect(read).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenNthCalledWith(2, 'taskSops/demo', { title: 'b' }, 'e1');
    expect(queue.state).toMatchObject({ kind: 'ready', etag: 'e2' });
    expect(queue.hasUnsavedChanges).toBe(false);
  });

  it('turns an unknown-outcome reread with newer server content into a conflict', async () => {
    const transport: ResourceSaveTransport<Value> = {
      save: vi.fn().mockRejectedValue({ kind: 'retryable', message: 'connection lost', unknownOutcome: true }),
      read: vi.fn().mockResolvedValue({ value: { title: 'other editor' }, etag: 'e3' }),
    };
    const queue = new ResourceSaveQueue({ resourceName: 'taskSops/demo', initial: { value: { title: 'base' }, etag: 'e1' }, transport });
    queue.submit({ title: 'local' });
    await settle();
    await queue.retry();

    expect(queue.state).toMatchObject({ kind: 'paused-conflict', serverEtag: 'e3' });
    expect(queue.localValue).toEqual({ title: 'local' });
  });

  it('requires explicit retry after terminal failure and preserves a successful size warning', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce({ kind: 'terminal', code: 'ROW_TOO_LARGE', message: 'reduce payload' })
      .mockResolvedValueOnce({
        etag: 'e2',
        warning: { kind: 'row_size', resourceName: 'materials/cup', measuredBytes: 1_600_000, limitBytes: 1_800_000 },
      });
    const queue = new ResourceSaveQueue({
      resourceName: 'materials/cup', initial: { value: { title: 'base' }, etag: 'e1' },
      transport: { save, read: vi.fn() },
    });
    queue.submit({ title: 'too large' });
    await settle();
    queue.submit({ title: 'reduced' });
    await settle();
    expect(save).toHaveBeenCalledTimes(1);

    await queue.retry();
    expect(save).toHaveBeenCalledTimes(2);
    expect(queue.state).toMatchObject({ kind: 'ready', etag: 'e2', warning: { measuredBytes: 1_600_000 } });
    queue.dismissWarning();
    expect(queue.state.warning).toBeUndefined();
  });

  it('reapplies retained local content only after fetching a fresh etag', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce({ kind: 'conflict', message: 'stale', serverValue: { title: 'server' }, serverEtag: 'e2' })
      .mockResolvedValueOnce({ etag: 'e4' });
    const read = vi.fn().mockResolvedValue({ value: { title: 'new server' }, etag: 'e3' });
    const queue = new ResourceSaveQueue({
      resourceName: 'requirements/demo', initial: { value: { title: 'base' }, etag: 'e1' },
      transport: { save, read },
    });
    queue.submit({ title: 'local' });
    await settle();
    await queue.reapplyLocal();

    expect(save).toHaveBeenLastCalledWith('requirements/demo', { title: 'local' }, 'e3');
    expect(queue.state).toMatchObject({ kind: 'ready', etag: 'e4' });
  });
});
