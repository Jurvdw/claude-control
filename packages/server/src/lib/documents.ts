// Generate real office documents (Word, PowerPoint, Excel) and PDFs from
// agent-provided content, so agents can produce downloadable deliverables.
// Heavy generator libs are dynamically imported so they don't cost at startup.

export type DocFormat = 'docx' | 'pptx' | 'xlsx' | 'pdf';

export interface Slide {
  title?: string;
  bullets?: string[];
}

export interface DocInput {
  format: DocFormat;
  title: string;
  content?: string; // markdown-ish text (docx, pdf)
  slides?: Slide[]; // pptx
  rows?: string[][]; // xlsx (first row = headers)
}

export interface GeneratedDoc {
  buffer: Buffer;
  mimeType: string;
  ext: DocFormat;
  text: string; // plain-text version (stored for later agent reading)
}

const MIME: Record<DocFormat, string> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
};

export async function generateDocument(input: DocInput): Promise<GeneratedDoc> {
  switch (input.format) {
    case 'docx': return { ...(await genDocx(input.title, input.content ?? '')), ext: 'docx', mimeType: MIME.docx };
    case 'pdf': return { ...(await genPdf(input.title, input.content ?? '')), ext: 'pdf', mimeType: MIME.pdf };
    case 'pptx': return { ...(await genPptx(input.title, input.slides ?? [])), ext: 'pptx', mimeType: MIME.pptx };
    case 'xlsx': return { ...(await genXlsx(input.title, input.rows ?? [])), ext: 'xlsx', mimeType: MIME.xlsx };
    default: throw new Error(`Unsupported format "${input.format}"`);
  }
}

async function genDocx(title: string, content: string): Promise<{ buffer: Buffer; text: string }> {
  const { Document, Packer, Paragraph, HeadingLevel } = await import('docx');
  const children: InstanceType<typeof Paragraph>[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^###\s+/.test(line)) children.push(new Paragraph({ text: line.replace(/^###\s+/, ''), heading: HeadingLevel.HEADING_3 }));
    else if (/^##\s+/.test(line)) children.push(new Paragraph({ text: line.replace(/^##\s+/, ''), heading: HeadingLevel.HEADING_2 }));
    else if (/^#\s+/.test(line)) children.push(new Paragraph({ text: line.replace(/^#\s+/, ''), heading: HeadingLevel.HEADING_1 }));
    else if (/^[-*]\s+/.test(line)) children.push(new Paragraph({ text: line.replace(/^[-*]\s+/, ''), bullet: { level: 0 } }));
    else children.push(new Paragraph({ text: line }));
  }
  const doc = new Document({ sections: [{ children }] });
  const buffer = await Packer.toBuffer(doc);
  return { buffer, text: `${title}\n\n${content}` };
}

async function genPdf(title: string, content: string): Promise<{ buffer: Buffer; text: string }> {
  const PDFDocument = (await import('pdfkit')).default;
  const doc = new PDFDocument({ margin: 54 });
  const chunks: Buffer[] = [];
  doc.on('data', (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve) => doc.on('end', () => resolve(Buffer.concat(chunks))));

  doc.fontSize(22).text(title).moveDown(0.6);
  for (const raw of content.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^#{1,3}\s+/.test(line)) doc.moveDown(0.3).fontSize(15).text(line.replace(/^#{1,3}\s+/, ''), { underline: false }).fontSize(11);
    else if (/^[-*]\s+/.test(line)) doc.fontSize(11).text(`• ${line.replace(/^[-*]\s+/, '')}`, { indent: 14 });
    else if (line.trim() === '') doc.moveDown(0.4);
    else doc.fontSize(11).text(line);
  }
  doc.end();
  return { buffer: await done, text: `${title}\n\n${content}` };
}

async function genPptx(title: string, slides: Slide[]): Promise<{ buffer: Buffer; text: string }> {
  const Pptx = (await import('pptxgenjs')).default;
  const pptx = new Pptx();
  // Title slide.
  const cover = pptx.addSlide();
  cover.addText(title, { x: 0.5, y: 2.3, w: '90%', fontSize: 32, bold: true, align: 'center', color: '363636' });

  const deck = slides.length ? slides : [{ title: 'Slide', bullets: [] }];
  for (const s of deck) {
    const slide = pptx.addSlide();
    if (s.title) slide.addText(s.title, { x: 0.5, y: 0.3, w: '90%', fontSize: 26, bold: true, color: 'd97757' });
    if (s.bullets?.length) {
      slide.addText(
        s.bullets.map((b) => ({ text: b, options: { bullet: true, fontSize: 16, color: '363636', breakLine: true } })),
        { x: 0.6, y: 1.3, w: '88%', h: '75%', valign: 'top' },
      );
    }
  }
  const buffer = (await pptx.write({ outputType: 'nodebuffer' })) as Buffer;
  const text = `${title}\n\n${deck.map((s, i) => `Slide ${i + 1}: ${s.title ?? ''}\n${(s.bullets ?? []).map((b) => `- ${b}`).join('\n')}`).join('\n\n')}`;
  return { buffer, text };
}

// In-place edit of an existing .xlsx — loads the workbook, applies cell updates
// and/or appended rows, and re-saves. This preserves the original formatting
// (the one format where true round-trip editing is clean).
export async function patchXlsx(
  buffer: Buffer,
  edits: { cellUpdates?: { cell: string; value: string }[]; appendRows?: string[][] },
): Promise<{ buffer: Buffer; text: string }> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  const ws = wb.worksheets[0] ?? wb.addWorksheet('Sheet1');
  for (const u of edits.cellUpdates ?? []) ws.getCell(u.cell).value = u.value;
  for (const r of edits.appendRows ?? []) ws.addRow(r);
  const out = Buffer.from(await wb.xlsx.writeBuffer());

  const lines: string[] = [];
  ws.eachRow((row) => lines.push((row.values as unknown[]).slice(1).map((v) => String(v ?? '')).join('\t')));
  return { buffer: out, text: lines.join('\n') };
}

async function genXlsx(title: string, rows: string[][]): Promise<{ buffer: Buffer; text: string }> {
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet((title || 'Sheet1').slice(0, 31).replace(/[\\/?*[\]]/g, ' '));
  for (const row of rows) ws.addRow(row);
  if (rows.length) {
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((col) => {
      let max = 10;
      col.eachCell?.({ includeEmpty: false }, (cell) => { max = Math.max(max, String(cell.value ?? '').length + 2); });
      col.width = Math.min(max, 60);
    });
  }
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  const text = `${title}\n\n${rows.map((r) => r.join('\t')).join('\n')}`;
  return { buffer, text };
}
