// Extract readable text from an uploaded file so agents can "read" attachments
// (PDFs, Office docs, plain text). Returns undefined when a type isn't textual
// (e.g. images — those go to the model as vision blocks instead).

const TEXT_EXTS = new Set(['txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'log', 'xml', 'yml', 'yaml', 'html', 'css', 'ts', 'tsx', 'js', 'jsx', 'py', 'java', 'go', 'rb', 'rs', 'c', 'cpp', 'h', 'sh', 'sql']);
const OFFICE_EXTS = new Set(['docx', 'pptx', 'xlsx', 'odt', 'odp', 'ods', 'doc', 'ppt', 'xls']);

export function isImageMime(mime: string): boolean {
  return /^image\/(png|jpe?g|gif|webp)$/.test(mime);
}

export async function extractFileText(buffer: Buffer, mime: string, name: string): Promise<string | undefined> {
  const ext = (name.split('.').pop() ?? '').toLowerCase();
  try {
    if (mime === 'application/pdf' || ext === 'pdf') {
      const pdfParse = (await import('pdf-parse')).default;
      return (await pdfParse(buffer)).text?.trim() || undefined;
    }
    if (mime.startsWith('text/') || TEXT_EXTS.has(ext)) {
      return buffer.toString('utf-8');
    }
    if (
      OFFICE_EXTS.has(ext) ||
      mime.includes('officedocument') ||
      mime.includes('opendocument') ||
      mime.includes('msword') ||
      mime.includes('ms-powerpoint') ||
      mime.includes('ms-excel')
    ) {
      const { parseOffice } = await import('officeparser');
      const ast = await parseOffice(buffer);
      return ast.toText()?.trim() || undefined;
    }
  } catch {
    // Extraction failed (corrupt/unsupported) — the file is still stored + linked.
  }
  return undefined;
}
