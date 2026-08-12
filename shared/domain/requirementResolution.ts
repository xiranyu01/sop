import { isFieldSet } from '@bufbuild/protobuf';
import type { FrozenExportContent } from '../../gen/coscene/sop/export/v1alpha1/bundle_pb';
import { ProductionFlow } from '../../gen/coscene/sop/v1alpha1/common_pb';
import {
  ProductionItemSchema,
  type ProductionItem,
  type RequirementSpec,
} from '../../gen/coscene/sop/v1alpha1/requirement_pb';

// Which robot revision applies to a production item, and where it came from.
// "Neither is set" is representable on purpose: Confirm rejects it with a message
// naming the item, so resolution itself must not throw or invent a value.
export type ItemRobotRevisionResolution =
  | { source: 'item' | 'spec'; value: string }
  | { source: 'none'; value: undefined };

// Real protobuf presence on the `optional production_flow` field. `present: false`
// means the stored record predates the field; `present: true` with an UNSPECIFIED
// value means a writer explicitly stored the unset choice. The two are not the
// same thing to the exporter — a legacy record omits the key entirely.
export type ItemProductionFlowResolution = {
  value: ProductionFlow;
  present: boolean;
};

export function resolveItemRobotRevision(
  item: Pick<ProductionItem, 'robotModelRevision'>,
  spec: Pick<RequirementSpec, 'robotModelRevision'>,
): ItemRobotRevisionResolution {
  if (item.robotModelRevision) return { source: 'item', value: item.robotModelRevision };
  if (spec.robotModelRevision) return { source: 'spec', value: spec.robotModelRevision };
  return { source: 'none', value: undefined };
}

export function resolveItemProductionFlow(item: ProductionItem): ItemProductionFlowResolution {
  // Presence comes from the field descriptor, never from `value !== UNSPECIFIED`:
  // an explicitly stored UNSPECIFIED is present, and a zero-valued property on a
  // hand-built object is not.
  const present = isFieldSet(item, ProductionItemSchema.field.productionFlow);
  return { value: item.productionFlow ?? ProductionFlow.UNSPECIFIED, present };
}

// Single source of truth for the exported production-flow codes. Keyed off the
// numeric enum value, because the same flow has three spellings: the TS member
// (ProductionFlow.COLLECT), the ProtoJSON name ("PRODUCTION_FLOW_COLLECT") and
// this code (`collect`). No other module may hardcode these strings.
//
// Keyed by every member except UNSPECIFIED, so a 7th enum value that nobody adds
// here is a BUILD failure rather than a key silently omitted from an external file.
const PRODUCTION_FLOW_CODES: Readonly<
  Record<Exclude<ProductionFlow, ProductionFlow.UNSPECIFIED>, string>
> = {
  [ProductionFlow.COLLECT_TRANSFORM_QA1_AUTO_ANNOTATE_ANNOTATE_QA2]:
    'collect/transform/qa1/auto-annotate/annotate/qa2',
  [ProductionFlow.COLLECT_TRANSFORM_QA1_ANNOTATE_QA2]: 'collect/transform/qa1/annotate/qa2',
  [ProductionFlow.COLLECT_QA1_ANNOTATE_QA2]: 'collect/qa1/annotate/qa2',
  [ProductionFlow.COLLECT_ANNOTATE_QA1]: 'collect/annotate/qa1',
  [ProductionFlow.COLLECT_TRANSFORM_QA1]: 'collect/transform/qa1',
  [ProductionFlow.COLLECT]: 'collect',
};

// Returns undefined for UNSPECIFIED (never exported) and for any integer this
// build does not know — proto3 enums are open, so a newer writer's value must
// reach an older reader as "no code", not as a crash. Callers omit the key.
export function productionFlowCode(value: ProductionFlow): string | undefined {
  // The widening cast is the lookup side only: the table's own type stays exhaustive
  // so the compiler still rejects a missing entry.
  return (PRODUCTION_FLOW_CODES as Readonly<Record<number, string | undefined>>)[value];
}

// ---------------------------------------------------------------------------
// Bundle space. The frozen export bundle carries refs, not resource names, so the
// domain resolvers above cannot serve it — but YAML and PDF are two external
// deliverables that must agree byte-for-byte on which robot a legacy item shows.
// Both renderers call these; neither may re-derive the rule locally.

type BundleRobotEntry = FrozenExportContent['robotModelRevisions'][number];
type BundleProductionItem =
  NonNullable<FrozenExportContent['requirements'][number]['spec']>['productionItems'][number];

// A bundle sealed before per-item refs existed carries an empty ref; the
// requirement-level default is the robot that genuinely applies to it. Returns
// undefined when the ref names a revision the bundle does not carry — callers
// decide whether that is fatal.
export function resolveBundleItemRobot(
  item: Pick<BundleProductionItem, 'robotModelRevisionRef'>,
  robots: readonly BundleRobotEntry[],
  specRobot: BundleRobotEntry | undefined,
): BundleRobotEntry | undefined {
  if (!item.robotModelRevisionRef) return specRobot;
  return robots.find((candidate) => candidate.ref === item.robotModelRevisionRef);
}

// Absent field, explicit UNSPECIFIED, and an unknown newer value all resolve to
// no code at all — never an empty string (决策 #8). Renderers omit the key / show
// a placeholder.
export function resolveBundleItemFlowCode(
  item: Pick<BundleProductionItem, 'productionFlow'>,
): string | undefined {
  return item.productionFlow === undefined ? undefined : productionFlowCode(item.productionFlow);
}
