import type { AppData, RequirementVersion, SubsceneVersion } from '../../../shared/transport/restDto';

export const confirmedTaskSop: SubsceneVersion = {
  version: '0.0.1',
  status: 'confirmed',
  title: '基线任务 SOP',
  description: '用于确定性浏览器测试',
  materials: [],
  robotState: { initial: '安全初始位', target: '任务完成' },
  randomization: {
    robotInitialState: { enabled: false, changeFrequency: 'fixed', randomizedFields: [] },
    materialInitialState: { rules: [] },
  },
  operation: {
    stepOrder: '1',
    steps: [{ order: 1, description: '执行基线动作', englishDescription: 'Run baseline action' }],
    stepRandomization: { enabled: false, startOrder: 1, endOrder: 1 },
    allowedOperations: [],
    acceptableOperations: [],
    forbiddenOperations: [],
  },
  objectStates: { initial: [], target: [] },
  materialStateRules: [],
  annotation: {
    status: 'not_required',
    note: '',
    actionTags: [],
    steps: [],
    allowedOperations: [],
    forbiddenOperations: [],
    stepRandomization: { enabled: false, startOrder: 1, endOrder: 1 },
  },
  references: { recordUrls: [], attachments: [] },
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export const draftRequirement: RequirementVersion = {
  version: '0.0.1',
  status: 'draft',
  title: '基线客户需求',
  projectName: '基线项目',
  priority: 'P1',
  deadline: '2026-12-31',
  sourceBaseUrl: 'https://example.test/source',
  attachmentNotes: '',
  attachments: [],
  extraTopicRequirementsText: '',
  globalRandomizationRequirements: '',
  additionalNotes: '',
  customerId: 'cus-baseline',
  robotModelId: 'robot-baseline',
  businessGoal: '保护当前页面行为',
  requestedScenes: ['基线场景'],
  requiredDurationHours: 1,
  allowedOperations: [],
  acceptableOperations: [],
  forbiddenOperations: [],
  annotation: { required: false, types: [], allowedOperations: [], forbiddenOperations: [] },
  qualityInspection: { required: false, samplingPolicy: '' },
  delivery: { formats: ['json'], method: 'download', languages: [{ code: 'zh-CN', name: '简体中文' }], dataStructureUrl: '' },
  selectedSubscenes: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
};

export const seedData: AppData = {
  metadata: {
    appDataSchemaVersion: 'app_data_v0.1',
    requirementYamlSchemaVersion: 'requirement_yaml_v0.11',
    taskSopYamlSchemaVersion: 'task_sop_yaml_v0.5',
  },
  customers: [
    { id: 'cus-baseline', name: '基线客户', contact: { name: '测试联系人', phone: '10086', email: 'baseline@example.test' }, notes: '固定 fixture' },
  ],
  materials: [
    { id: 'mat-baseline', skuId: 'SKU001', type: '测试物料', color: '白色', material: '塑料', packageType: '盒装', size: '10cm', weight: '100g', images: [] },
  ],
  robotModels: [
    { id: 'robot-baseline', brand: 'coScene', model: 'Baseline', terminal: '夹爪', topics: { camera: '/camera' }, extraTopicRequirements: {} },
  ],
  scenes: [
    { id: 'scene-baseline', name: '基线场景', description: '固定 fixture 场景', subscenes: [{ code: 'NO.001', name: '基线任务 SOP', versions: [confirmedTaskSop] }] },
  ],
  requirements: [{ id: 'REQ001', versions: [draftRequirement] }],
  globalFields: [
    { id: 'field-baseline', group: 'robot_state', label: '安全初始位', value: '安全初始位', status: 'active', updatedAt: '2026-01-01T00:00:00.000Z' },
  ],
  materialStateRules: [],
};
