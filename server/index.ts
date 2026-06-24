import cors from 'cors';
import express from 'express';
import type {
  Customer,
  GlobalField,
  Material,
  MaterialStateRule,
  Requirement,
  RequirementVersion,
  RobotModel,
  Scene,
  SubsceneVersion,
} from '../src/types';
import {
  readData,
  writeCustomers,
  writeExport,
  writeGlobalFields,
  writeMaterialStateRules,
  writeMaterials,
  writeRequirements,
  writeRobotModels,
  writeScenes,
} from './store';
import { buildRequirementYaml } from './yamlExport';
import { canEditStatus, createId, nextPatchVersion, nowIso } from './versioning';

const app = express();
const port = Number(process.env.PORT ?? 8787);

app.use(cors());
app.use(express.json({ limit: '4mb' }));

function latestVersion<T extends { version: string }>(versions: T[]): T {
  if (versions.length === 0) {
    throw new Error('版本列表为空');
  }
  return versions[versions.length - 1];
}

function findTargetVersion<T extends { version: string }>(versions: T[], targetVersion?: string): T {
  if (!targetVersion) {
    return latestVersion(versions);
  }
  const found = versions.find((version) => version.version === targetVersion);
  if (!found) {
    throw new Error(`找不到版本 ${targetVersion}`);
  }
  return found;
}

function nextAvailablePatchVersion<T extends { version: string }>(versions: T[], baseVersion: string): string {
  const usedVersions = new Set(versions.map((version) => version.version));
  let candidate = nextPatchVersion(baseVersion);
  while (usedVersions.has(candidate)) {
    candidate = nextPatchVersion(candidate);
  }
  return candidate;
}

function normalizeError(error: unknown): { message: string } {
  return { message: error instanceof Error ? error.message : '未知错误' };
}

function replaceById<T extends { id: string }>(collection: T[], item: T): T[] {
  const next = collection.some((current) => current.id === item.id)
    ? collection.map((current) => (current.id === item.id ? item : current))
    : [...collection, item];
  return next;
}

function nextReadableId(values: string[], prefix: string): string {
  const pattern = new RegExp(`^${prefix}(\\d+)$`, 'i');
  const maxNumber = values.reduce((max, value) => {
    const match = value.match(pattern);
    if (!match) return max;
    const parsed = Number.parseInt(match[1], 10);
    return Number.isNaN(parsed) ? max : Math.max(max, parsed);
  }, 0);
  return `${prefix}${maxNumber + 1}`;
}

function emptySubsceneVersion(patch: Partial<SubsceneVersion> = {}): SubsceneVersion {
  return {
    version: '0.0.1',
    status: 'draft',
    title: patch.title || '新的子场景',
    description: patch.description || '',
    materials: patch.materials || [],
    robotState: patch.robotState || { initial: '', target: '' },
    robotOperationRequirements: patch.robotOperationRequirements || '',
    robotInitialRandomizationRequirements: patch.robotInitialRandomizationRequirements || [],
    randomizationFrequency: patch.randomizationFrequency || '1',
    randomization: patch.randomization || {
      robotInitialState: {
        enabled: true,
        changeFrequency: 'every_n_records',
        changeIntervalRecords: 1,
        randomizedFields: [],
      },
      materialInitialState: { rules: [] },
    },
    operation: patch.operation || {
      stepOrder: '',
      steps: [],
      stepRandomization: { enabled: false, startOrder: 1, endOrder: 1 },
      allowedOperations: [],
      forbiddenOperations: [],
    },
    objectStates: patch.objectStates || { initial: [], target: [] },
    materialStateRules: patch.materialStateRules || [],
    annotation: patch.annotation || {
      status: 'pending',
      note: '',
      actionTags: [],
      steps: [],
      allowedOperations: [],
      forbiddenOperations: [],
      stepRandomization: { enabled: false, startOrder: 1, endOrder: 1 },
    },
    references: patch.references || { recordUrls: [], attachments: [] },
    updatedAt: nowIso(),
    ...patch,
  };
}

app.get('/api/data', async (_req, res) => {
  try {
    res.json(await readData());
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.post('/api/customers', async (req, res) => {
  try {
    const data = await readData();
    const item = { ...req.body, id: req.body.id || createId('cus') } as Customer;
    const next = replaceById(data.customers, item);
    await writeCustomers(next);
    res.json(next);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.post('/api/materials', async (req, res) => {
  try {
    const data = await readData();
    const item = {
      ...req.body,
      id: req.body.id || createId('mat'),
      skuId: req.body.skuId || nextReadableId(data.materials.map((material) => material.skuId), 'SKU'),
    } as Material;
    const duplicated = data.materials.some((material) => material.id !== item.id && material.skuId === item.skuId);
    if (duplicated) {
      res.status(400).json({ message: `SKU 编号 ${item.skuId} 已存在` });
      return;
    }
    const next = replaceById(data.materials, item);
    await writeMaterials(next);
    res.json(next);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.post('/api/robot-models', async (req, res) => {
  try {
    const data = await readData();
    const item = { ...req.body, id: req.body.id || createId('robot') } as RobotModel;
    const next = replaceById(data.robotModels, item);
    await writeRobotModels(next);
    res.json(next);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.post('/api/global-fields', async (req, res) => {
  try {
    const data = await readData();
    const item = {
      ...req.body,
      id: req.body.id || createId('field'),
      status: req.body.status || 'active',
      updatedAt: nowIso(),
    } as GlobalField;
    const next = replaceById(data.globalFields, item);
    await writeGlobalFields(next);
    res.json(next);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.post('/api/material-state-rules', async (req, res) => {
  try {
    const data = await readData();
    const item = {
      ...req.body,
      id: req.body.id || createId('state_rule'),
      updatedAt: nowIso(),
    } as MaterialStateRule;
    const next = replaceById(data.materialStateRules, item);
    await writeMaterialStateRules(next);
    res.json(next);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.post('/api/scenes', async (req, res) => {
  try {
    const data = await readData();
    const item = { ...req.body, id: req.body.id || createId('scene') } as Scene;
    const next = replaceById(data.scenes, item);
    await writeScenes(next);
    res.json(next);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.post('/api/requirements', async (req, res) => {
  try {
    const data = await readData();
    const body = req.body as Partial<RequirementVersion>;
    const requirement: Requirement = {
      id: nextReadableId(data.requirements.map((item) => item.id), 'R'),
      versions: [
        {
          version: '0.0.1',
          status: 'draft',
          title: body.title || '未命名客户需求',
          projectName: body.projectName || '',
          priority: body.priority || 'P2',
          deadline: body.deadline || '',
          sourceBaseUrl: body.sourceBaseUrl || '',
          attachmentNotes: body.attachmentNotes || '',
          extraTopicRequirementsText: body.extraTopicRequirementsText || '',
          globalRandomizationRequirements: body.globalRandomizationRequirements || '',
          additionalNotes: body.additionalNotes || '',
          customerId: body.customerId || data.customers[0]?.id || '',
          robotModelId: body.robotModelId || data.robotModels[0]?.id || '',
          businessGoal: body.businessGoal || '',
          requestedScenes: body.requestedScenes || [],
          requiredDurationHours: body.requiredDurationHours || 0,
          allowedOperations: body.allowedOperations || [],
          forbiddenOperations: body.forbiddenOperations || [],
          annotation: body.annotation || { required: true, types: [], allowedOperations: [], forbiddenOperations: [] },
          qualityInspection: body.qualityInspection || { required: true, samplingPolicy: '全量抽检' },
          delivery: body.delivery || {
            formats: ['mcap', 'json'],
            method: '',
            languages: [{ code: 'zh-CN', name: '简体中文' }],
            dataStructureUrl: '',
          },
          selectedSubscenes: body.selectedSubscenes || [],
          updatedAt: nowIso(),
        },
      ],
    };
    const next = [...data.requirements, requirement];
    await writeRequirements(next);
    res.json(next);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.put('/api/requirements/:id', async (req, res) => {
  try {
    const data = await readData();
    const requirement = data.requirements.find((item) => item.id === req.params.id);
    if (!requirement) {
      res.status(404).json({ message: '找不到客户需求' });
      return;
    }

    const { baseVersion, ...patch } = req.body as Partial<RequirementVersion> & { baseVersion?: string };
    const current = findTargetVersion(requirement.versions, baseVersion);
    const editable = canEditStatus(current.status);
    const nextVersion: RequirementVersion = {
      ...current,
      ...patch,
      version: editable ? current.version : nextAvailablePatchVersion(requirement.versions, current.version),
      status: editable ? current.status : 'draft',
      updatedAt: nowIso(),
    };

    const nextRequirement = {
      ...requirement,
      versions: editable
        ? requirement.versions.map((version) => (version.version === current.version ? nextVersion : version))
        : [...requirement.versions, nextVersion],
    };

    const next = data.requirements.map((item) => (item.id === requirement.id ? nextRequirement : item));
    await writeRequirements(next);
    res.json(next);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.delete('/api/requirements/:id/versions/:version', async (req, res) => {
  try {
    const data = await readData();
    const requirement = data.requirements.find((item) => item.id === req.params.id);
    if (!requirement) {
      res.status(404).json({ message: '找不到客户需求' });
      return;
    }
    const target = requirement.versions.find((version) => version.version === req.params.version);
    if (!target) {
      res.status(404).json({ message: '找不到客户需求版本' });
      return;
    }
    if (target.status !== 'draft') {
      res.status(400).json({ message: '只能删除草稿版本' });
      return;
    }
    if (requirement.versions.length <= 1) {
      res.status(400).json({ message: '至少需要保留一个版本' });
      return;
    }
    const nextRequirement = {
      ...requirement,
      versions: requirement.versions.filter((version) => version.version !== target.version),
    };
    const next = data.requirements.map((item) => (item.id === requirement.id ? nextRequirement : item));
    await writeRequirements(next);
    res.json(next);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.post('/api/requirements/:id/confirm', async (req, res) => {
  try {
    const data = await readData();
    const targetVersion = req.body.version as string | undefined;
    const next = data.requirements.map((requirement) => {
      if (requirement.id !== req.params.id) {
        return requirement;
      }
      const versionToConfirm = targetVersion || latestVersion(requirement.versions).version;
      return {
        ...requirement,
        versions: requirement.versions.map((version) =>
          version.version === versionToConfirm ? { ...version, status: 'confirmed' as const, updatedAt: nowIso() } : version,
        ),
      };
    });
    await writeRequirements(next);
    res.json(next);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.post('/api/scenes/:sceneId/subscenes/:subsceneCode/versions', async (req, res) => {
  try {
    const data = await readData();
    const nextScenes = data.scenes.map((scene) => {
      if (scene.id !== req.params.sceneId) {
        return scene;
      }
      const { baseVersion, ...patch } = req.body as Partial<SubsceneVersion> & { baseVersion?: string };
      const existing = scene.subscenes.find((subscene) => subscene.code === req.params.subsceneCode);
      if (!existing) {
        const created = emptySubsceneVersion(patch);
        return {
          ...scene,
          subscenes: [
            ...scene.subscenes,
            {
              code: req.params.subsceneCode,
              name: created.title || req.params.subsceneCode,
              versions: [created],
            },
          ],
        };
      }
      return {
        ...scene,
        subscenes: scene.subscenes.map((subscene) => {
          if (subscene.code !== req.params.subsceneCode) {
            return subscene;
          }
          const current = findTargetVersion(subscene.versions, baseVersion);
          const editable = canEditStatus(current.status);
          const canEditTitle = current.version === '0.0.1' && current.status === 'draft';
          const effectivePatch = canEditTitle ? patch : { ...patch, title: current.title };
          const nextVersion: SubsceneVersion = {
            ...current,
            ...effectivePatch,
            version: editable ? current.version : nextAvailablePatchVersion(subscene.versions, current.version),
            status: editable ? current.status : 'draft',
            updatedAt: nowIso(),
          };
          return {
            ...subscene,
            name: canEditTitle && patch.title ? patch.title : subscene.name,
            versions: editable
              ? subscene.versions.map((version) => (version.version === current.version ? nextVersion : version))
              : [...subscene.versions, nextVersion],
          };
        }),
      };
    });
    await writeScenes(nextScenes);
    res.json(nextScenes);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.delete('/api/scenes/:sceneId/subscenes/:subsceneCode/versions/:version', async (req, res) => {
  try {
    const data = await readData();
    let foundSubscene = false;
    let foundVersion = false;
    let blockedMessage = '';
    const nextScenes = data.scenes.map((scene) => {
      if (scene.id !== req.params.sceneId) {
        return scene;
      }
      return {
        ...scene,
        subscenes: scene.subscenes.map((subscene) => {
          if (subscene.code !== req.params.subsceneCode) {
            return subscene;
          }
          foundSubscene = true;
          const target = subscene.versions.find((version) => version.version === req.params.version);
          if (!target) {
            return subscene;
          }
          foundVersion = true;
          if (target.status !== 'draft') {
            blockedMessage = '只能删除草稿版本';
            return subscene;
          }
          if (subscene.versions.length <= 1) {
            blockedMessage = '至少需要保留一个版本';
            return subscene;
          }
          return {
            ...subscene,
            versions: subscene.versions.filter((version) => version.version !== target.version),
          };
        }),
      };
    });

    if (!foundSubscene) {
      res.status(404).json({ message: '找不到子场景' });
      return;
    }
    if (!foundVersion) {
      res.status(404).json({ message: '找不到子场景版本' });
      return;
    }
    if (blockedMessage) {
      res.status(400).json({ message: blockedMessage });
      return;
    }

    await writeScenes(nextScenes);
    res.json(nextScenes);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.post('/api/scenes/:sceneId/subscenes/:subsceneCode/confirm', async (req, res) => {
  try {
    const data = await readData();
    const versionToConfirm = req.body.version as string | undefined;
    const nextScenes = data.scenes.map((scene) => {
      if (scene.id !== req.params.sceneId) {
        return scene;
      }
      return {
        ...scene,
        subscenes: scene.subscenes.map((subscene) => {
          if (subscene.code !== req.params.subsceneCode) {
            return subscene;
          }
          const target = versionToConfirm || latestVersion(subscene.versions).version;
          return {
            ...subscene,
            versions: subscene.versions.map((version) =>
              version.version === target ? { ...version, status: 'confirmed' as const, updatedAt: nowIso() } : version,
            ),
          };
        }),
      };
    });
    await writeScenes(nextScenes);
    res.json(nextScenes);
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.post('/api/requirements/:id/export-yaml', async (req, res) => {
  try {
    const data = await readData();
    const requirement = data.requirements.find((item) => item.id === req.params.id);
    if (!requirement) {
      res.status(404).json({ message: '找不到客户需求' });
      return;
    }
    const selectedVersion = req.body.version
      ? requirement.versions.find((version) => version.version === req.body.version)
      : latestVersion(requirement.versions);
    if (!selectedVersion) {
      res.status(404).json({ message: '找不到客户需求版本' });
      return;
    }

    const yaml = buildRequirementYaml(data, requirement, selectedVersion);
    const file = await writeExport(requirement.id, selectedVersion.version, yaml);
    res.json({ yaml, path: file });
  } catch (error) {
    res.status(500).json(normalizeError(error));
  }
});

app.listen(port, '127.0.0.1', () => {
  console.log(`SOP requirement manager API listening on http://127.0.0.1:${port}`);
});
