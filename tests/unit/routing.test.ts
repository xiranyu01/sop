import { describe, expect, it } from 'vitest';
import {
  archivedRequirementRoutePath,
  archivedTaskSopRoutePath,
  pageRoutePath,
  parseAppRoute,
  requirementRoutePath,
  taskSopRoutePath,
} from '../../src/routing';

describe('shareable application routes', () => {
  it('maps every sidebar page to a stable path', () => {
    expect(pageRoutePath('requirements')).toBe('/requirements');
    expect(pageRoutePath('scenes')).toBe('/scenes');
    expect(pageRoutePath('customers')).toBe('/customers');
    expect(pageRoutePath('materials')).toBe('/materials');
    expect(pageRoutePath('robots')).toBe('/robot-models');
    expect(pageRoutePath('globalFields')).toBe('/global-fields');
    expect(pageRoutePath('archive')).toBe('/archive');
  });

  it('round-trips requirement and TaskSop version ids as the final path segment', () => {
    const requirementId = '43843384-2fd5-5343-8564-684915fb7a7b';
    const taskId = '67af0f30-5057-5128-a859-a92a71bab8a2';
    expect(parseAppRoute(requirementRoutePath(requirementId))).toEqual({
      page: 'requirements', detail: { kind: 'requirement', versionId: requirementId },
    });
    expect(parseAppRoute(taskSopRoutePath(taskId))).toEqual({
      page: 'scenes', detail: { kind: 'taskSop', versionId: taskId },
    });
    expect(parseAppRoute(archivedRequirementRoutePath(requirementId))).toEqual({
      page: 'archive', detail: { kind: 'requirement', versionId: requirementId },
    });
    expect(parseAppRoute(archivedTaskSopRoutePath(taskId))).toEqual({
      page: 'archive', detail: { kind: 'taskSop', versionId: taskId },
    });
  });
});
