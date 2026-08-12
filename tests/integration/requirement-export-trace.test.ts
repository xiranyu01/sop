import customers from '../../data/customers.json';
import globalFields from '../../data/global-fields.json';
import materialStateRules from '../../data/material-state-rules.json';
import materials from '../../data/materials.json';
import metadata from '../../data/metadata.json';
import requirements from '../../data/requirements.json';
import robotModels from '../../data/robot-models.json';
import scenes from '../../data/scenes.json';
import YAML from 'yaml';
import { describe, expect, it } from 'vitest';
import { bootstrapRepository } from '../../server/bootstrap/repository';
import { prepareRepositoryData } from '../../server/bootstrap/repositoryData';
import { repositoryBootstrapMarkerValue } from '../../server/bootstrap/status';
import {
  acknowledgeRootDependencies,
  confirmRoot,
  reviewRootDependencies,
} from '../../server/domain/services/confirmation';
import { handleResourceApiRequest } from '../../server/http/resourceApi';
import type { ResourceRepository } from '../../server/domain/repository';
import { createD1ResourceRepository } from '../../server/repositories/d1ResourceRepository';
import type { AppData } from '../../shared/transport/restDto';
import { seedData } from '../e2e/fixtures/seed';
import { SqliteD1 } from '../helpers/sqliteD1';
import { resourceStorageMigrationsSql } from '../helpers/resourceStorageMigrations';

// The whole chain in one test, because no per-unit gate covers it end to end:
// draft with divergent per-item robots and flows -> Confirm (seals the bundle)
// -> the same HTTP route the UI calls -> rendered YAML.
const fixtureData = {
  metadata,
  customers,
  materials,
  robotModels,
  scenes,
  requirements,
  globalFields,
  materialStateRules,
} as AppData;

const REQUIREMENT_NAME = 'requirements/req-we-home';

type RequirementProto = {
  spec: {
    robotModelRevision: string;
    productionItems: Array<{
      id: string;
      displayName: string;
      taskSopRevision: string;
      robotModelRevision?: string;
      productionFlow?: string;
    }>;
  };
} & Record<string, unknown>;

async function harness(appData: AppData = fixtureData) {
  const db = new SqliteD1(resourceStorageMigrationsSql);
  let etag = 0;
  const repository = createD1ResourceRepository(db, {
    clock: () => '2026-07-14T10:00:00.000Z',
    createEtag: () => `trace-etag-${++etag}`,
  });
  const data = prepareRepositoryData(structuredClone(appData));
  await bootstrapRepository(repository, data);
  const expectedBootstrapMarker = repositoryBootstrapMarkerValue('COMPLETE', data);
  const request = (path: string, init?: RequestInit) => handleResourceApiRequest(
    new Request(`https://sop.test${path}`, init),
    repository,
    { expectedBootstrapMarker, requestId: 'trace-request' },
  );
  return { db, repository, data, request };
}

// The imported fixture draft pins TaskSop revisions that are still draft checkpoints;
// drop those before shaping the per-item model under test. The save goes through the
// same HTTP PUT the UI issues, so the transport DTO is part of the traced chain rather
// than being bypassed by a direct repository write.
async function prepareRequirementDraft(
  repository: ResourceRepository,
  request: (path: string, init?: RequestInit) => Promise<Response>,
  mutate: (proto: RequirementProto) => void,
) {
  const path = `/api/resources/requirements/${encodeURIComponent(REQUIREMENT_NAME)}`;
  const detail = await (await request(path)).json() as {
    etag: string;
    resource: RequirementProto;
  };
  const proto = detail.resource;
  const revisions = await Promise.all(proto.spec.productionItems.map((item) =>
    repository.getRevision(item.taskSopRevision)));
  proto.spec.productionItems = proto.spec.productionItems.filter((_item, index) =>
    revisions[index]?.exportEligible);
  expect(proto.spec.productionItems.length).toBeGreaterThan(0);
  mutate(proto);
  const saved = await request(path, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ expectedEtag: detail.etag, resource: proto }),
  });
  expect(saved.status).toBe(200);
  return (await repository.getCurrent(REQUIREMENT_NAME))!;
}

describe('confirmed requirement export trace', () => {
  it('carries two robots and two flows from the draft through Confirm to rendered YAML', async () => {
    const { db, repository, data, request } = await harness();
    const robotRevisionNames = data.revisions
      .filter((item) => item.protoSchema.endsWith('.RobotModelRevision'))
      .map((item) => item.name);
    expect(robotRevisionNames.length).toBeGreaterThan(1);

    const draft = await prepareRequirementDraft(repository, request, (proto) => {
      proto.spec.robotModelRevision = robotRevisionNames[0]!;
      const [first] = proto.spec.productionItems;
      proto.spec.productionItems = [
        {
          ...first!,
          id: 'trace-collect-only',
          displayName: '采集：仅采集流程',
          robotModelRevision: robotRevisionNames[0]!,
          productionFlow: 'PRODUCTION_FLOW_COLLECT',
        },
        {
          ...first!,
          id: 'trace-full-pipeline',
          displayName: '采集：全链路流程',
          robotModelRevision: robotRevisionNames[1]!,
          productionFlow: 'PRODUCTION_FLOW_COLLECT_TRANSFORM_QA1_AUTO_ANNOTATE_ANNOTATE_QA2',
        },
      ];
    });

    const review = await reviewRootDependencies(repository, draft.name);
    const acknowledged = await acknowledgeRootDependencies(repository, {
      rootName: draft.name,
      expectedEtag: draft.etag,
      proposalDigest: review.digest,
    });
    const confirmed = await confirmRoot(repository, {
      rootName: draft.name,
      expectedEtag: acknowledged.etag,
      commandId: 'trace-confirm',
      now: new Date('2026-07-14T11:00:00.000Z'),
    });

    // The same route src/App.tsx reaches through resourceClient.exportRevision.
    const response = await request(
      `/api/revisions/${encodeURIComponent(confirmed.revision.name)}/export.yaml`,
    );
    expect(response.status).toBe(200);
    const yaml = await response.text();
    // TRACE_YAML=1 prints the rendered document so the trace can be re-read by hand;
    // the assertions below are what actually gates.
    if (process.env.TRACE_YAML) console.log(yaml);

    const items = YAML.parse(yaml).requirement.production_requirement_items as Array<{
      id: string;
      robot: { id: string; brand: string; model: string; terminal: string };
      production_flow?: string;
    }>;
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.production_flow)).toEqual([
      'collect',
      'collect/transform/qa1/auto-annotate/annotate/qa2',
    ]);
    // Two distinct robots survive the seal: the pinned revisions differ, so the
    // rendered blocks must differ too, not collapse onto the spec default.
    expect(items[0]!.robot.id).not.toBe(items[1]!.robot.id);
    expect(items[0]!.robot.model).not.toBe(items[1]!.robot.model);
    // 决策 #7: the requirement-level block keeps rendering the spec default, which here
    // is the first item's robot — divergence never rewrites it.
    const requirement = YAML.parse(yaml).requirement as { robot: { id: string } };
    expect(requirement.robot.id).toBe(items[0]!.robot.id);
    db.close();
  });

  it('re-exports a converted legacy requirement with broadcast robots and no production_flow', async () => {
    // `prepareRepositoryData` IS the legacy converter, so a confirmed legacy version
    // imports as a sealed revision that never carried per-item robots or a flow field.
    const legacy = structuredClone(seedData);
    const version = legacy.requirements[0]!.versions[0]!;
    version.status = 'confirmed';
    // The baseline seed carries no production items; give it one so the per-item
    // rendering this test is about actually exists. Same shape as the export golden.
    version.selectedSubscenes = [{
      id: 'production-item-1',
      title: '基线任务 SOP',
      description: '遗留数据再导出',
      sceneName: '基线场景',
      subsceneCode: 'NO.001',
      subsceneName: '基线任务 SOP',
      version: '0.0.1',
      targetDurationHours: 1,
      targetCollectionCount: 2,
    }];
    const { db, data, request } = await harness(legacy);
    const legacyRevision = data.revisions.find((item) =>
      item.protoSchema.endsWith('.RequirementRevision') && item.exportEligible)!;
    expect(legacyRevision).toBeDefined();

    const response = await request(
      `/api/revisions/${encodeURIComponent(legacyRevision.name)}/export.yaml`,
    );
    expect(response.status).toBe(200);
    const yaml = await response.text();
    // TRACE_YAML=1 prints the rendered document so the trace can be re-read by hand;
    // the assertions below are what actually gates.
    if (process.env.TRACE_YAML) console.log(yaml);

    const requirement = YAML.parse(yaml).requirement as {
      robot: Record<string, unknown>;
      production_requirement_items: Array<{
        robot: Record<string, unknown>;
        production_flow?: string;
      }>;
    };
    expect(requirement.production_requirement_items.length).toBeGreaterThan(0);
    for (const item of requirement.production_requirement_items) {
      // 决策 #8: the key is absent, not empty — a legacy record never claims a flow.
      expect(item).not.toHaveProperty('production_flow');
      // 决策 #7 fallback: each item still renders a robot, broadcast from the
      // requirement-level default the legacy record carried.
      expect(item.robot).toEqual(requirement.robot);
    }
    expect(yaml).not.toContain('production_flow');
    db.close();
  });
});
