import { describe, expect, it, vi } from 'vitest';
import type { ResourceDetail } from '../../shared/transport/resourceDto';
import type { ConfirmationResult, DependencyReviewProposal } from '../../src/api/client';
import { DependencyReviewFlow } from '../../src/persistence/dependencyReviewFlow';

function proposal(digest: string, etag: string): DependencyReviewProposal {
  return {
    proposalDigest: digest,
    rootEtag: etag,
    added: [{ kind: 'MATERIAL', resourceName: 'materials/cup', afterToken: 'material-e2' }],
    changed: [],
    removed: [],
  };
}

function resource(etag: string): ResourceDetail {
  return {
    kind: 'requirements', name: 'requirements/demo', uid: 'uid-1', displayName: 'Demo', etag,
    lifecycle: 'DRAFT', archived: false, resource: { name: 'requirements/demo', etag },
  };
}

describe('dependency review UI flow', () => {
  it('cancels without acknowledging or confirming', async () => {
    const api = { confirm: vi.fn().mockResolvedValue(proposal('digest-1', 'e1')), acknowledgeReview: vi.fn() };
    const flow = new DependencyReviewFlow({ api, kind: 'requirements', resourceName: 'requirements/demo', initialEtag: 'e1' });
    await flow.requestConfirmation();
    expect(flow.state.kind).toBe('review-required');
    flow.cancel();
    expect(flow.state).toEqual({ kind: 'idle', etag: 'e1' });
    expect(api.acknowledgeReview).not.toHaveBeenCalled();
    expect(api.confirm).toHaveBeenCalledTimes(1);
  });

  it('replaces a proposal that changed again and never auto-confirms after acknowledgement', async () => {
    const first = proposal('digest-1', 'e1');
    const second = proposal('digest-2', 'e2');
    const api = {
      confirm: vi.fn().mockResolvedValue(first),
      acknowledgeReview: vi.fn()
        .mockResolvedValueOnce(second)
        .mockResolvedValueOnce({ resource: resource('e3') }),
    };
    const flow = new DependencyReviewFlow({ api, kind: 'requirements', resourceName: 'requirements/demo', initialEtag: 'e1' });

    await flow.requestConfirmation();
    await flow.accept();
    expect(flow.state).toEqual({ kind: 'review-required', etag: 'e2', proposal: second });
    await flow.accept();
    expect(flow.state).toEqual({ kind: 'acknowledged', etag: 'e3' });
    expect(api.confirm).toHaveBeenCalledTimes(1);
  });

  it('confirms only after a separate second request', async () => {
    const confirmed: ConfirmationResult = {
      resource: { ...resource('e4'), lifecycle: 'CONFIRMED' },
      revision: {
        name: 'requirements/demo/revisions/1-0-0', uid: 'revision-uid', versionLabel: '1.0.0',
        origin: 'RUNTIME_CONFIRMED', lifecycle: 'CONFIRMED', exportEligible: true,
        ownerName: 'requirements/demo', kind: 'REQUIREMENT_REVISION', resource: { name: 'requirements/demo' },
      },
      idempotent: false,
      exportPath: '/api/revisions/requirements%2Fdemo%2Frevisions%2F1-0-0/export.yaml',
    };
    const api = {
      confirm: vi.fn().mockResolvedValueOnce(proposal('digest-1', 'e1')).mockResolvedValueOnce(confirmed),
      acknowledgeReview: vi.fn().mockResolvedValue({ resource: resource('e3') }),
    };
    const flow = new DependencyReviewFlow({ api, kind: 'requirements', resourceName: 'requirements/demo', initialEtag: 'e1' });

    await flow.requestConfirmation();
    await flow.accept();
    expect(flow.state.kind).toBe('acknowledged');
    await flow.requestConfirmation();
    expect(flow.state).toEqual({ kind: 'confirmed', etag: 'e4', result: confirmed });
    expect(api.confirm).toHaveBeenCalledTimes(2);
  });
});
