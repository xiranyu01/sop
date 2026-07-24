import type { FrozenExportContent } from '../../../gen/coscene/sop/export/v1alpha1/bundle_pb';
import { exportBundleToView } from '../../domain/exportBundleView';
import type { PdfDocumentModel } from './model';
import { PDF_RENDERER_V1, renderPdfModelV1 } from './v1';

export type { PdfAttachment, PdfDocumentModel, PdfRow, PdfSection, PdfTable } from './model';

export function renderFrozenPdfModel(content: FrozenExportContent): PdfDocumentModel {
  const view = exportBundleToView(content);
  if (view.rendererVersion === PDF_RENDERER_V1) return renderPdfModelV1(view);
  throw new TypeError(`Unsupported PDF renderer version: ${view.rendererVersion || '<missing>'}`);
}
