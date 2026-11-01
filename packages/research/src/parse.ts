import { fork } from 'node:child_process';
import { z } from 'zod';
import { convert } from 'html-to-text';
import { feedText } from './sources.js';
import { ResearchError, type Chunk, type Source } from './contracts.js';
export async function chunks(source: Source): Promise<Chunk[]> {
  if (source.raw.byteLength > 12 * 1024 * 1024)
    throw new ResearchError(
      'DOCUMENT_TOO_LARGE',
      'Documents are limited to 12 MiB.',
    );
  let pages: Array<{ page: number | null; text: string }>;
  if (source.mime === 'application/pdf') {
    if (Buffer.from(source.raw.slice(0, 5)).toString() !== '%PDF-')
      throw new ResearchError('INVALID_PDF', 'This file is not a PDF.');
    const worker = fork(new URL('./pdf-worker.js', import.meta.url), {
      serialization: 'advanced',
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      execArgv: ['--max-old-space-size=128'],
    });
    try {
      pages = await new Promise<Array<{ page: number; text: string }>>(
        (resolve, reject) => {
          const fail = () =>
            reject(
              new ResearchError(
                'PDF_UNREADABLE',
                'PDF text could not be extracted within the 30 second / 200 page limit. Use an unlocked text-based PDF; scanned pages need OCR.',
              ),
            );
          const timer = setTimeout(fail, 30000);
          worker.once('message', (value: unknown) => {
            clearTimeout(timer);
            const result = z
              .object({
                pages: z
                  .array(
                    z.object({
                      page: z.number().int().positive(),
                      text: z.string().max(3600000),
                    }),
                  )
                  .max(200),
              })
              .safeParse(value);
            if (result.success) resolve(result.data.pages);
            else fail();
          });
          worker.once('error', () => {
            clearTimeout(timer);
            fail();
          });
          worker.once('exit', () => {
            clearTimeout(timer);
            fail();
          });
          worker.send(source.raw);
        },
      );
    } finally {
      worker.kill();
    }
  } else {
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(source.raw);
    const text =
      source.mime === 'text/html'
        ? convert(raw, {
            wordwrap: false,
            limits: { maxInputLength: 12 * 1024 * 1024 },
            selectors: [
              { selector: 'script', format: 'skip' },
              { selector: 'style', format: 'skip' },
              { selector: 'a', options: { ignoreHref: true } },
              { selector: 'img', format: 'skip' },
            ],
          })
        : source.mime === 'application/xml'
          ? feedText(raw)
          : source.mime === 'application/json'
            ? (source.facts ?? [])
                .map(
                  (f) =>
                    `${f.metric}: ${f.value} ${f.unit}; period ${f.start ?? 'instant'} to ${f.end}; accession ${f.accession}; filed ${f.filed}`,
                )
                .join('\n')
            : raw;
    pages = [{ page: null, text }];
  }
  const result: Chunk[] = [];
  for (const page of pages) {
    const text = page.text
      .replaceAll(String.fromCharCode(0), '')
      .replace(/\r/g, '')
      .trim();
    for (let start = 0; start < text.length; start += 1800)
      result.push({
        index: result.length,
        page: page.page,
        text: text.slice(start, start + 1800),
      });
  }
  if (!result.length)
    throw new ResearchError(
      'NO_TEXT',
      'No searchable text was found. Scanned PDFs require OCR; upload text or a text-based PDF.',
    );
  if (result.length > 2000)
    throw new ResearchError(
      'DOCUMENT_TOO_LARGE',
      'Extracted text exceeds 3.6 million characters.',
    );
  return result;
}
