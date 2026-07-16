import { describe, expect, it, vi } from 'vitest';
import { ResourceSaveQueueRegistry } from '../../src/persistence/resourceSaveQueueRegistry';

describe('resource save queue registry', () => {
  it('keeps unrelated resource queues and etags independent', async () => {
    const registry = new ResourceSaveQueueRegistry();
    const saveMaterial = vi.fn().mockResolvedValue({ etag: 'material-e2' });
    const saveCustomer = vi.fn().mockResolvedValue({ etag: 'customer-e2' });
    const material = registry.register('materials', {
      resourceName: 'materials/cup', initial: { value: { title: 'Cup' }, etag: 'material-e1' },
      transport: { save: saveMaterial, read: vi.fn() },
    });
    const customer = registry.register('customers', {
      resourceName: 'customers/acme', initial: { value: { title: 'Acme' }, etag: 'customer-e1' },
      transport: { save: saveCustomer, read: vi.fn() },
    });

    material.submit({ title: 'New cup' });
    customer.submit({ title: 'New Acme' });
    await vi.waitFor(() => expect(material.state).toMatchObject({ kind: 'ready', etag: 'material-e2' }));
    await vi.waitFor(() => expect(customer.state).toMatchObject({ kind: 'ready', etag: 'customer-e2' }));

    expect(saveMaterial).toHaveBeenCalledWith('materials/cup', { title: 'New cup' }, 'material-e1');
    expect(saveCustomer).toHaveBeenCalledWith('customers/acme', { title: 'New Acme' }, 'customer-e1');
    expect(registry.hasUnsavedChanges).toBe(false);
  });

  it('warns before navigation while a paused queue retains local changes', async () => {
    const registry = new ResourceSaveQueueRegistry();
    const queue = registry.register('materials', {
      resourceName: 'materials/cup', initial: { value: { title: 'Cup' }, etag: 'e1' },
      transport: { save: vi.fn().mockRejectedValue(new TypeError('network down')), read: vi.fn() },
    });
    queue.submit({ title: 'Local value' });
    await vi.waitFor(() => expect(queue.state.kind).toBe('paused-retryable'));

    const listeners = new Map<string, EventListener>();
    const target = {
      addEventListener: vi.fn((name: string, listener: EventListener) => listeners.set(name, listener)),
      removeEventListener: vi.fn((name: string) => listeners.delete(name)),
    };
    const uninstall = registry.installNavigationWarning(target as unknown as Window);
    const event = {
      preventDefault: vi.fn(),
      returnValue: true,
    } as unknown as BeforeUnloadEvent;
    listeners.get('beforeunload')?.(event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(event.returnValue).toBe('');
    expect(registry.remove('materials/cup')).toBe(false);
    uninstall();
    expect(target.removeEventListener).toHaveBeenCalled();
  });

  it('never shares one canonical name across different resource kinds', () => {
    const registry = new ResourceSaveQueueRegistry();
    registry.register('materials', {
      resourceName: 'shared/name', initial: { value: {}, etag: 'e1' },
      transport: { save: vi.fn(), read: vi.fn() },
    });
    expect(() => registry.register('customers', {
      resourceName: 'shared/name', initial: { value: {}, etag: 'e1' },
      transport: { save: vi.fn(), read: vi.fn() },
    })).toThrow('already registered as materials');
  });

  it('requires explicit discard consent before clearing queues with local edits', async () => {
    const registry = new ResourceSaveQueueRegistry();
    const queue = registry.register('materials', {
      resourceName: 'materials/cup', initial: { value: { title: 'Cup' }, etag: 'e1' },
      transport: { save: vi.fn().mockRejectedValue(new TypeError('offline')), read: vi.fn() },
    });
    await queue.submit({ title: 'Local cup' });

    expect(registry.clear()).toBe(false);
    expect(registry.states).toHaveLength(1);
    expect(registry.clear(true)).toBe(true);
    expect(registry.states).toEqual([]);
  });
});
