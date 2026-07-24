export type PdfRow = { label: string; value: string };

export type PdfTable = {
  columns: string[];
  rows: string[][];
};

export type PdfAttachment = {
  name: string;
  size: number;
  contentType: string;
  url?: string;
};

export type PdfSection = {
  id: string;
  heading: string;
  description?: string;
  rows?: PdfRow[];
  items?: string[];
  tables?: PdfTable[];
  attachments?: PdfAttachment[];
};

export type PdfDocumentModel = {
  rendererVersion: string;
  page: { size: 'A4'; marginMm: { top: number; right: number; bottom: number; left: number } };
  title: string;
  subtitle: string;
  fileName: string;
  trace: PdfRow[];
  sections: PdfSection[];
};
