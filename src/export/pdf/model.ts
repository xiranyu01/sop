export type PdfRow = { label: string; value: string };

export type PdfSection = {
  id: string;
  heading: string;
  rows?: PdfRow[];
  items?: string[];
};

export type PdfDocumentModel = {
  rendererVersion: string;
  page: { size: 'A4'; marginMm: { top: number; right: number; bottom: number; left: number } };
  title: string;
  subtitle: string;
  trace: PdfRow[];
  sections: PdfSection[];
};

