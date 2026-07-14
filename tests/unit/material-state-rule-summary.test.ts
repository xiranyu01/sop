import { describe, expect, it } from 'vitest';
import {
  appendMaterialStateRuleSummaries,
  appendTaskSopSummariesToScenes,
  appendUniqueResourceSummaries,
} from '../../src/App';
import type { ResourceSummary } from '../../shared/transport/resourceDto';
import type { Scene } from '../../src/domain/viewModels';

function summary(name: string, displayName: string): ResourceSummary {
  return {
    kind: 'materialStateRules',
    name,
    uid: `${name}-uid`,
    displayName,
    etag: `${name}-etag`,
    archived: false,
  };
}

describe('material state rule summary projection', () => {
  it('creates a summary-only placeholder without loading Proto detail fields', () => {
    const item = appendMaterialStateRuleSummaries([], [summary('materialStateRules/wet', '湿润')])[0];

    expect(item).toMatchObject({
      id: 'wet',
      materialType: '湿润',
      primaryReferences: [],
      primaryRelativePositions: [],
      supportSurfaces: [],
      regions: [],
      secondaryReferences: [],
      secondaryRelativePositions: [],
      poses: [],
      forms: [],
      parameters: [],
      updatedAt: new Date(0).toISOString(),
      __resourceName: 'materialStateRules/wet',
      __resourceEtag: 'materialStateRules/wet-etag',
      __resourceLoaded: false,
    });
  });

  it('appends later pages in order without duplicate summaries or placeholders', () => {
    const wet = summary('materialStateRules/wet', '湿润');
    const dry = summary('materialStateRules/dry', '干燥');
    const summaries = appendUniqueResourceSummaries([wet], [wet, dry, dry]);
    const initial = appendMaterialStateRuleSummaries([], [wet]);
    const rules = appendMaterialStateRuleSummaries(initial, [wet, dry, dry]);

    expect(summaries.map((item) => item.name)).toEqual([
      'materialStateRules/wet',
      'materialStateRules/dry',
    ]);
    expect(rules.map((item) => item.id)).toEqual(['wet', 'dry']);
  });

  it('attaches later task summary pages to an already-complete scene summary catalog once', () => {
    const scenes = [
      Object.assign({ id: 'first', name: 'First', description: '', subscenes: [] }, {
        __resourceName: 'scenes/first', __resourceEtag: 'e1', __resourceLoaded: false,
      }),
      Object.assign({ id: 'later', name: 'Later', description: '', subscenes: [] }, {
        __resourceName: 'scenes/later', __resourceEtag: 'e2', __resourceLoaded: false,
      }),
    ] as Scene[];
    const task = {
      kind: 'taskSops', name: 'taskSops/later-task', uid: 'task-uid', sourceId: 'NO.001',
      displayName: 'Later task', etag: 'task-etag', sceneName: 'scenes/later', archived: false,
    } satisfies ResourceSummary;

    const once = appendTaskSopSummariesToScenes(scenes, [task]);
    const twice = appendTaskSopSummariesToScenes(once, [task]);

    expect(twice[0].subscenes).toHaveLength(0);
    expect(twice[1].subscenes).toHaveLength(1);
    expect(twice[1].subscenes[0]).toMatchObject({ code: 'NO.001', name: 'Later task' });
  });
});
