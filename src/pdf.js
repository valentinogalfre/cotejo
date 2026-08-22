/**
 * Manejo de PDFs de facturas.
 *
 * Dos vías complementarias:
 *  - texto embebido (facturas digitales): getTextContent() — gratis y exacto
 *  - render a PNG: para escanear el QR y para OCR cuando el PDF es una imagen
 */
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

let pdfjsPromise = null;
function getPdfjs() {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

/**
 * @param {Buffer} buffer PDF
 * @returns {Promise<{ pages: Array<{ png: Buffer, text: string }>, text: string }>}
 */
export async function renderPdf(buffer, { maxPages = 3, scale = 2.0 } = {}) {
  const pdfjs = await getPdfjs();
  const { createCanvas } = require('@napi-rs/canvas');

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    isEvalSupported: false,
  }).promise;

  const pages = [];
  const count = Math.min(doc.numPages, maxPages);
  for (let i = 1; i <= count; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;

    const textContent = await page.getTextContent();
    const text = textContent.items.map((it) => it.str).join(' ').replace(/\s+/g, ' ').trim();

    pages.push({ png: canvas.toBuffer('image/png'), text });
  }
  await doc.destroy();

  return { pages, text: pages.map((p) => p.text).join('\n') };
}

export function isPdf(buffer) {
  return buffer.length > 4 && buffer.subarray(0, 5).toString('latin1') === '%PDF-';
}
