import { describe, expect, it, vi } from 'vitest';
import {
  ROW_SIZE_REJECTION_BYTES,
  ROW_SIZE_WARNING_BYTES,
  RowSizeLimitError,
  guardProspectiveRow,
  measureVariableLengthColumns,
  prospectiveVariableLengthColumns,
  variableLengthBytes,
} from '../../server/domain/rowSize';

describe('D1 prospective row-size guard', () => {
  it('measures UTF-8 strings and byte arrays rather than JavaScript character counts', () => {
    expect(variableLengthBytes('plain')).toBe(5);
    expect(variableLengthBytes('洗🧼')).toBe(7);
    expect(variableLengthBytes(new Uint8Array([0, 1, 2]))).toBe(3);
    expect(variableLengthBytes(null)).toBe(0);
    expect(variableLengthBytes(undefined)).toBe(0);

    expect(measureVariableLengthColumns({
      protoJson: '{"label":"洗"}',
      frozenDependencies: new Uint8Array([1, 2, 3, 4]),
      absent: undefined,
    })).toBe(new TextEncoder().encode('{"label":"洗"}').byteLength + 4);
  });

  it('measures the complete prospective row by retaining unchanged stored columns', () => {
    const stored = {
      name: 'materials/cup',
      protoJson: 'x'.repeat(ROW_SIZE_WARNING_BYTES - 30),
      metadata: 'unchanged-large-column',
    };
    const prospective = prospectiveVariableLengthColumns(stored, { name: 'materials/new-cup' });

    expect(prospective).toEqual({
      ...stored,
      name: 'materials/new-cup',
    });
    expect(measureVariableLengthColumns(prospective)).toBeGreaterThanOrEqual(ROW_SIZE_WARNING_BYTES);
  });

  it('warns from 1.5 MB inclusive and stays normal immediately below it', () => {
    const onWarning = vi.fn();

    expect(guardProspectiveRow('MATERIAL', 'materials/small', {
      protoJson: 'x'.repeat(ROW_SIZE_WARNING_BYTES - 1),
    }, onWarning)).toEqual({
      resourceKind: 'MATERIAL',
      resourceName: 'materials/small',
      bytes: ROW_SIZE_WARNING_BYTES - 1,
      warning: false,
    });
    expect(onWarning).not.toHaveBeenCalled();

    expect(guardProspectiveRow('MATERIAL', 'materials/large', {
      protoJson: 'x'.repeat(ROW_SIZE_WARNING_BYTES),
    }, onWarning)).toEqual({
      resourceKind: 'MATERIAL',
      resourceName: 'materials/large',
      bytes: ROW_SIZE_WARNING_BYTES,
      warning: true,
    });
    expect(onWarning).toHaveBeenCalledOnce();
    expect(onWarning).toHaveBeenCalledWith({
      resourceKind: 'MATERIAL',
      resourceName: 'materials/large',
      bytes: ROW_SIZE_WARNING_BYTES,
      warning: true,
      warningLimitBytes: ROW_SIZE_WARNING_BYTES,
      rejectionLimitBytes: ROW_SIZE_REJECTION_BYTES,
    });
  });

  it('allows the last byte below 1.8 MB and rejects 1.8 MB before persistence', () => {
    const onRejected = vi.fn();
    expect(guardProspectiveRow('TASK_SOP', 'taskSops/almost-full', {
      protoJson: 'x'.repeat(ROW_SIZE_REJECTION_BYTES - 1),
    })).toMatchObject({
      bytes: ROW_SIZE_REJECTION_BYTES - 1,
      warning: true,
    });

    expect(() => guardProspectiveRow('TASK_SOP', 'taskSops/full', {
      protoJson: 'x'.repeat(ROW_SIZE_REJECTION_BYTES),
    }, onRejected)).toThrow(RowSizeLimitError);
    expect(onRejected).toHaveBeenCalledWith(expect.objectContaining({
      resourceKind: 'TASK_SOP',
      resourceName: 'taskSops/full',
      bytes: ROW_SIZE_REJECTION_BYTES,
      rejectionLimitBytes: ROW_SIZE_REJECTION_BYTES,
    }));

    try {
      guardProspectiveRow('TASK_SOP', 'taskSops/full', {
        protoJson: 'x'.repeat(ROW_SIZE_REJECTION_BYTES),
      });
      throw new Error('expected the row guard to reject');
    } catch (error) {
      expect(error).toMatchObject({
        code: 'ROW_SIZE_LIMIT',
        resourceKind: 'TASK_SOP',
        resourceName: 'taskSops/full',
        bytes: ROW_SIZE_REJECTION_BYTES,
        limitBytes: ROW_SIZE_REJECTION_BYTES,
      });
    }
  });
});
