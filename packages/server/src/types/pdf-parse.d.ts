declare module 'pdf-parse' {
  interface PdfParseResult {
    text: string;
    numpages: number;
    info: unknown;
    metadata: unknown;
    version: string;
  }
  function pdfParse(dataBuffer: Buffer | Uint8Array, options?: Record<string, unknown>): Promise<PdfParseResult>;
  export = pdfParse;
}
