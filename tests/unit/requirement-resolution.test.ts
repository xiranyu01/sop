import { create, toJson } from '@bufbuild/protobuf';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { Lifecycle, ProductionFlow, RevisionOrigin } from '../../gen/coscene/sop/v1alpha1/common_pb';
import {
  ProductionItemSchema,
  RequirementSpecSchema,
} from '../../gen/coscene/sop/v1alpha1/requirement_pb';
import { convertLegacyToV1alpha1 } from '../../server/bootstrap/legacyToV1alpha1';
import { buildExportBundle } from '../../server/export/bundle';
import { resolveExportClosure } from '../../server/export/closure';
import { measureFrozenExportContent } from '../../server/export/codec';
import { serializeExportBundleYaml } from '../../server/export/yaml';
import { renderFrozenPdfModel } from '../../src/export/pdf';
import { fromDomainJsonString } from '../../shared/domain/codec';
import { seedData } from '../e2e/fixtures/seed';
import {
  productionFlowCode,
  resolveItemProductionFlow,
  resolveItemRobotRevision,
} from '../../shared/domain/requirementResolution';

// A stored snapshot written before U1 added the per-item fields. It is parsed
// through the generated schema rather than built in TS, because the fallback and
// absence branches are claims about real stored ProtoJSON: after U11's broadcast
// no bootstrap fixture exercises them, and an object literal would prove nothing.
const PRE_CHANGE_SPEC_JSON = JSON.stringify({
  customer: 'customers/acme',
  robotModelRevision: 'robotModels/g1/revisions/3',
  businessGoal: '抓取杯子',
  productionItems: [
    {
      id: 'item-legacy',
      displayName: '抓取杯子',
      taskSopRevision: 'taskSops/pick/revisions/1',
    },
  ],
  priority: 'PRIORITY_P1',
});

function parsePreChangeSpec() {
  return fromDomainJsonString(RequirementSpecSchema, PRE_CHANGE_SPEC_JSON);
}

describe('resolveItemRobotRevision', () => {
  it('prefers the item value over the requirement-level default', () => {
    const item = create(ProductionItemSchema, { robotModelRevision: 'robotModels/g1/revisions/7' });
    const spec = create(RequirementSpecSchema, { robotModelRevision: 'robotModels/g1/revisions/3' });

    expect(resolveItemRobotRevision(item, spec)).toEqual({
      source: 'item',
      value: 'robotModels/g1/revisions/7',
    });
  });

  it('falls back to the spec default for an item stored before the field existed', () => {
    const spec = parsePreChangeSpec();
    const [item] = spec.productionItems;

    // The parsed item carries the implicit-presence empty string, not undefined.
    expect(item.robotModelRevision).toBe('');
    expect(toJson(RequirementSpecSchema, spec)).toEqual(
      expect.objectContaining({
        productionItems: [expect.not.objectContaining({ robotModelRevision: expect.anything() })],
      }),
    );

    expect(resolveItemRobotRevision(item, spec)).toEqual({
      source: 'spec',
      value: 'robotModels/g1/revisions/3',
    });
  });

  it('reports "none" when neither level is set, without throwing', () => {
    const item = create(ProductionItemSchema, {});
    const spec = create(RequirementSpecSchema, {});

    expect(resolveItemRobotRevision(item, spec)).toEqual({ source: 'none', value: undefined });
  });
});

describe('resolveItemProductionFlow', () => {
  it('reports absent for an item stored before the field existed', () => {
    const [item] = parsePreChangeSpec().productionItems;

    expect(resolveItemProductionFlow(item)).toEqual({
      value: ProductionFlow.UNSPECIFIED,
      present: false,
    });
  });

  it('reports present for an explicitly stored UNSPECIFIED', () => {
    // Same numeric value as the legacy case; only real field presence separates them.
    const stored = fromDomainJsonString(
      ProductionItemSchema,
      JSON.stringify({ id: 'item-1', productionFlow: 'PRODUCTION_FLOW_UNSPECIFIED' }),
    );

    expect(resolveItemProductionFlow(stored)).toEqual({
      value: ProductionFlow.UNSPECIFIED,
      present: true,
    });
    expect(resolveItemProductionFlow(stored).present).not.toBe(
      resolveItemProductionFlow(create(ProductionItemSchema, {})).present,
    );
  });

  it('reports present with the chosen value for a real flow', () => {
    const item = create(ProductionItemSchema, { productionFlow: ProductionFlow.COLLECT_ANNOTATE_QA1 });

    expect(resolveItemProductionFlow(item)).toEqual({
      value: ProductionFlow.COLLECT_ANNOTATE_QA1,
      present: true,
    });
  });
});

describe('productionFlowCode', () => {
  it('maps every defined flow to its exported code', () => {
    expect(productionFlowCode(ProductionFlow.COLLECT_TRANSFORM_QA1_AUTO_ANNOTATE_ANNOTATE_QA2))
      .toBe('collect/transform/qa1/auto-annotate/annotate/qa2');
    expect(productionFlowCode(ProductionFlow.COLLECT_TRANSFORM_QA1_ANNOTATE_QA2))
      .toBe('collect/transform/qa1/annotate/qa2');
    expect(productionFlowCode(ProductionFlow.COLLECT_QA1_ANNOTATE_QA2)).toBe('collect/qa1/annotate/qa2');
    expect(productionFlowCode(ProductionFlow.COLLECT_ANNOTATE_QA1)).toBe('collect/annotate/qa1');
    expect(productionFlowCode(ProductionFlow.COLLECT_TRANSFORM_QA1)).toBe('collect/transform/qa1');
    expect(productionFlowCode(ProductionFlow.COLLECT)).toBe('collect');
  });

  it('covers every enum member except UNSPECIFIED, so a later value cannot be forgotten', () => {
    const members = Object.values(ProductionFlow).filter(
      (value): value is ProductionFlow => typeof value === 'number',
    );

    expect(members).toHaveLength(7);
    for (const member of members) {
      if (member === ProductionFlow.UNSPECIFIED) continue;
      expect(productionFlowCode(member)).toBeTypeOf('string');
    }
  });

  it('returns undefined for UNSPECIFIED — it is never exported', () => {
    expect(productionFlowCode(ProductionFlow.UNSPECIFIED)).toBeUndefined();
  });

  it('returns undefined for an unknown integer instead of crashing', () => {
    // proto3 enums are open: a newer writer's value reaches this build as a bare int.
    expect(productionFlowCode(99 as ProductionFlow)).toBeUndefined();
    expect(productionFlowCode(-1 as ProductionFlow)).toBeUndefined();
  });
});

// A bundle whose FIRST item predates per-item refs (empty ref → falls back to the
// requirement default) and whose SECOND item pins a different robot. Two robots in
// the closure is what makes the assertion discriminating: a renderer that picked the
// wrong one would produce a different, existing robot rather than nothing.
function mixedRobotRequirementBundle() {
  const data = structuredClone(seedData);
  data.robotModels.push({
    id: 'robot-alt', brand: 'coScene', model: 'Alt', terminal: '吸盘',
    topics: { camera: '/camera-alt' }, extraTopicRequirements: {},
  } as (typeof data.robotModels)[number]);
  const version = data.requirements[0].versions[0];
  version.status = 'confirmed';
  version.selectedSubscenes = [
    { sceneName: '基线场景', subsceneCode: 'NO.001', subsceneName: '基线任务 SOP', targetDurationHours: 1, targetCollectionCount: 2 },
    { sceneName: '基线场景', subsceneCode: 'NO.001', subsceneName: '基线任务 SOP', targetDurationHours: 1, targetCollectionCount: 3 },
  ] as (typeof version.selectedSubscenes);

  const snapshot = convertLegacyToV1alpha1(data).resources;
  const revision = snapshot.requirementRevisions[0];
  revision.snapshot!.lifecycle = Lifecycle.CONFIRMED;
  revision.origin = RevisionOrigin.IMPORTED_CONFIRMED;
  revision.exportEligible = true;
  const [legacyItem, pinnedItem] = revision.snapshot!.spec!.productionItems;
  // The converter fills both items with the default; clearing the first reproduces a
  // revision sealed before the field existed.
  legacyItem.robotModelRevision = '';
  pinnedItem.robotModelRevision = 'robotModels/robot-alt/revisions/current';

  const bundle = buildExportBundle(resolveExportClosure(snapshot, {
    kind: 'requirement', sourceId: 'REQ001', versionLabel: '0.0.1',
  }));
  // Today's builder resolves the fallback while sealing, so no freshly built bundle
  // can exercise the renderers' own fallback. The bundles that DO are the ones sealed
  // before the field existed — reproduced by emptying the ref and re-sealing, because
  // the renderers verify the content hash before reading anything.
  bundle.content!.requirements[0].spec!.productionItems[0].robotModelRevisionRef = '';
  const measured = measureFrozenExportContent(bundle.content!);
  bundle.contentSha256 = measured.contentSha256;
  bundle.contentSizeBytes = measured.contentSizeBytes;
  return bundle;
}

describe('bundle-space item robot fallback', () => {
  it('resolves the same robot in the YAML and PDF renderers for an empty ref', () => {
    const bundle = mixedRobotRequirementBundle();
    const content = bundle.content!;
    const robots = content.robotModelRevisions;
    expect(robots).toHaveLength(2);
    const defaultRef = content.requirements[0].spec!.robotModelRevisionRef;
    const altRef = robots.find((robot) => robot.ref !== defaultRef)!.ref;
    // Distinct on both identity axes, or "they agree" would be vacuous.
    expect(new Set(robots.map((robot) => robot.source?.uid)).size).toBe(2);
    expect(new Set(robots.map((robot) => robot.displayName)).size).toBe(2);
    const items = content.requirements[0].spec!.productionItems;
    expect(items.map((item) => item.robotModelRevisionRef)).toEqual(['', altRef]);

    const byUid = new Map(robots.map((robot) => [robot.source?.uid || '', robot.ref]));
    const byDisplayName = new Map(robots.map((robot) => [robot.displayName, robot.ref]));
    const yamlDocument = YAML.parse(serializeExportBundleYaml(bundle)) as {
      requirement: { production_requirement_items: Array<{ robot: { id: string } }> };
    };
    const yamlRefs = yamlDocument.requirement.production_requirement_items
      .map((item) => byUid.get(item.robot.id));
    const pdfRows = renderFrozenPdfModel(content).sections
      .find((section) => section.id === 'production-items')!.tables![0].rows;
    const pdfRefs = pdfRows.map((row) => byDisplayName.get(row[5]));

    expect(yamlRefs).toEqual([defaultRef, altRef]);
    expect(pdfRefs).toEqual(yamlRefs);
  });
});
