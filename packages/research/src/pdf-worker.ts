import { PDFParse } from 'pdf-parse';
process.once('message', async (data: unknown) => {
  const parser = new PDFParse({
    data: data as Uint8Array,
    isEvalSupported: false,
  });
  try {
    const info = await parser.getInfo();
    if (info.total > 200) throw new Error('PDFs are limited to 200 pages.');
    const parsed = await parser.getText();
    const pages = parsed.pages.map((p) => ({ page: p.num, text: p.text }));
    if (pages.reduce((n, p) => n + p.text.length, 0) > 3600000)
      throw new Error('Extracted text is too large.');
    process.send?.({ pages });
  } catch {
    process.send?.({ error: true });
  } finally {
    await parser.destroy();
    process.disconnect();
  }
});
