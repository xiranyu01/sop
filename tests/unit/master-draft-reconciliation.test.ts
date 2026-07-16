import { describe, expect, it } from 'vitest';
import { reconcileMasterDraftFromItems, replaceResourceInPlace } from '../../src/App';

type Draft = {
  id: string;
  value: string;
  __resourceName?: string;
  __resourceEtag?: string;
  __resourceLoaded?: boolean;
  __resourceCreatedAt?: string;
  __resourceDraftSyncToken?: number;
};

function bound(name: string, value: string, loaded: boolean, token?: number): Draft {
  return {
    id: name.split('/').at(-1)!,
    value,
    __resourceName: name,
    __resourceEtag: loaded ? 'etag-loaded' : 'etag-summary',
    __resourceLoaded: loaded,
    ...(token === undefined ? {} : { __resourceDraftSyncToken: token }),
  };
}

describe('master editor draft reconciliation', () => {
  it('adopts loaded detail for the same selected resource instead of switching to the first row', () => {
    const selected = bound('materials/selected', 'summary', false);
    const first = bound('materials/first', 'first detail', true);
    const loaded = bound('materials/selected', 'selected detail', true);

    expect(reconcileMasterDraftFromItems(selected, [first, loaded], false, { id: '', value: '' })).toBe(loaded);
  });

  it('preserves a new draft and a loaded local draft across parent list updates', () => {
    const newDraft = { id: '', value: 'new local draft' };
    const local = bound('customers/selected', 'local edit', true);
    const server = bound('customers/selected', 'server conflict value', true);

    expect(reconcileMasterDraftFromItems(newDraft, [server], true, { id: '', value: '' })).toBe(newDraft);
    expect(reconcileMasterDraftFromItems(local, [server], false, { id: '', value: '' })).toBe(local);
  });

  it('adopts a server value carrying a newer explicit reload token', () => {
    const local = bound('robotModels/selected', 'local edit', true, 1);
    const reloaded = bound('robotModels/selected', 'server reload', true, 2);

    expect(reconcileMasterDraftFromItems(local, [reloaded], false, { id: '', value: '' })).toBe(reloaded);
  });

  it('replaces an existing resource in place and only appends a new resource', () => {
    const first = bound('materials/first', 'first', true);
    const selected = bound('materials/selected', 'selected', true);
    const last = bound('materials/last', 'last', true);
    const updated = bound('materials/selected', 'updated', true);

    const replaced = replaceResourceInPlace([first, selected, last], updated);

    expect(replaced).toEqual([first, updated, last]);
    expect(replaceResourceInPlace(replaced, bound('materials/new', 'new', true)))
      .toEqual([first, updated, last, bound('materials/new', 'new', true)]);
  });

  it('places a newly created resource by creation time without waiting for a refresh', () => {
    const older = Object.assign(bound('materials/older', 'older', true), {
      __resourceCreatedAt: '2026-07-14T10:00:00.000Z',
    });
    const newer = Object.assign(bound('materials/newer', 'newer', true), {
      __resourceCreatedAt: '2026-07-15T10:00:00.000Z',
    });

    expect(replaceResourceInPlace([older], newer)).toEqual([newer, older]);
  });
});
