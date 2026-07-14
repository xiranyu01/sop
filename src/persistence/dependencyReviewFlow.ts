import type { ResourceDetail } from '../../shared/transport/resourceDto';
import type {
  ConfirmationResult,
  DependencyReviewProposal,
} from '../api/client';

export type DependencyReviewApi = {
  confirm(
    kind: 'taskSops' | 'requirements',
    name: string,
    expectedEtag: string,
  ): Promise<ConfirmationResult | DependencyReviewProposal>;
  acknowledgeReview(
    kind: 'taskSops' | 'requirements',
    name: string,
    expectedEtag: string,
    proposalDigest: string,
  ): Promise<{ resource: ResourceDetail } | DependencyReviewProposal>;
};

export type DependencyReviewState =
  | { kind: 'idle'; etag: string }
  | { kind: 'confirming'; etag: string }
  | { kind: 'review-required'; etag: string; proposal: DependencyReviewProposal }
  | { kind: 'acknowledging'; etag: string; proposal: DependencyReviewProposal }
  | { kind: 'acknowledged'; etag: string }
  | { kind: 'confirmed'; etag: string; result: ConfirmationResult }
  | { kind: 'failed'; etag: string; message: string };

export type DependencyReviewFlowOptions = {
  api: DependencyReviewApi;
  kind: 'taskSops' | 'requirements';
  resourceName: string;
  initialEtag: string;
  onStateChange?: (state: DependencyReviewState) => void;
};

function isProposal(
  value: ConfirmationResult | { resource: ResourceDetail } | DependencyReviewProposal,
): value is DependencyReviewProposal {
  return 'proposalDigest' in value;
}

/**
 * Explicit two-step dependency review. A successful acknowledgement never
 * invokes confirm; the editor must make a separate second confirm gesture.
 */
export class DependencyReviewFlow {
  private readonly api: DependencyReviewApi;
  private readonly resourceKind: 'taskSops' | 'requirements';
  private readonly resourceName: string;
  private readonly onStateChange?: (state: DependencyReviewState) => void;
  private current: DependencyReviewState;

  constructor(options: DependencyReviewFlowOptions) {
    this.api = options.api;
    this.resourceKind = options.kind;
    this.resourceName = options.resourceName;
    this.onStateChange = options.onStateChange;
    this.current = { kind: 'idle', etag: options.initialEtag };
  }

  get state(): DependencyReviewState {
    return this.current;
  }

  cancel(): void {
    if (this.current.kind !== 'review-required') return;
    this.setState({ kind: 'idle', etag: this.current.etag });
  }

  async requestConfirmation(): Promise<void> {
    if (!['idle', 'acknowledged', 'failed'].includes(this.current.kind)) return;
    const etag = this.current.etag;
    this.setState({ kind: 'confirming', etag });
    try {
      const result = await this.api.confirm(this.resourceKind, this.resourceName, etag);
      if (isProposal(result)) {
        this.setState({ kind: 'review-required', etag: result.rootEtag, proposal: result });
      } else {
        this.setState({ kind: 'confirmed', etag: result.resource.etag, result });
      }
    } catch (error) {
      this.setState({ kind: 'failed', etag, message: error instanceof Error ? error.message : String(error) });
    }
  }

  async accept(): Promise<void> {
    if (this.current.kind !== 'review-required') return;
    const { etag, proposal } = this.current;
    this.setState({ kind: 'acknowledging', etag, proposal });
    try {
      const result = await this.api.acknowledgeReview(
        this.resourceKind,
        this.resourceName,
        etag,
        proposal.proposalDigest,
      );
      if (isProposal(result)) {
        // Dependencies changed again while the dialog was open. Replace the
        // visible proposal and require another explicit acceptance.
        this.setState({ kind: 'review-required', etag: result.rootEtag, proposal: result });
      } else {
        this.setState({ kind: 'acknowledged', etag: result.resource.etag });
      }
    } catch (error) {
      this.setState({ kind: 'failed', etag, message: error instanceof Error ? error.message : String(error) });
    }
  }

  private setState(state: DependencyReviewState): void {
    this.current = state;
    this.onStateChange?.(state);
  }
}
