/**
 * Pipeline por factura: archivo → QR fiscal + OCR/LLM → cross-check.
 *
 *   1. PDF: render a PNG + texto embebido. Imagen: se usa directa.
 *   2. QR fiscal: jsQR sobre la(s) imagen(es) → parseAfipQr (determinístico).
 *   3. Texto: texto embebido del PDF si existe; si no, OCR local (QVAC).
 *   4. LLM local estructura el texto (extract.js).
 *   5. crossCheck(): el QR corrige/verifica al modelo y deja evidencia.
 */
import { renderPdf, isPdf } from './pdf.js';
import { scanQr } from './qr-scan.js';
import { parseAfipQr, formatComprobante } from './afip-qr.js';
import { runOcr } from './qvac.js';
import { extractInvoice } from './extract.js';
import { crossCheck } from './crosscheck.js';

const MIN_EMBEDDED_TEXT = 80;

/**
 * @param {{ id: string, filename: string, buffer: Buffer }} file
 * @param {(msg: string) => void} log  callback de evidencia (se muestra en vivo)
 */
export async function processInvoiceFile(file, log = () => {}) {
  const t0 = performance.now();
  const evidence = [];
  const note = (msg) => { evidence.push(msg); log(msg); };

  // 1) Normalizar a imágenes + texto embebido si es PDF.
  let images = [];
  let embeddedText = '';
  if (isPdf(file.buffer)) {
    const { pages, text } = await renderPdf(file.buffer);
    images = pages.map((p) => p.png);
    embeddedText = text;
    note(`PDF de ${pages.length} página(s)${text.length >= MIN_EMBEDDED_TEXT ? ' con texto embebido' : ' sin texto útil (escaneado)'}`);
  } else {
    images = [file.buffer];
  }

  // 2) QR fiscal (determinístico, sin IA).
  let qrData = null;
  let qrAttempt = null;
  for (const img of images) {
    const found = await scanQr(img);
    if (found) {
      const parsed = parseAfipQr(found.text);
      if (parsed.ok) {
        qrData = parsed.data;
        qrAttempt = found.attempt;
        note(`QR fiscal ARCA/AFIP decodificado (variante: ${found.attempt}) → ${formatComprobante(qrData)}, $${qrData.importe}`);
        break;
      }
      note(`QR encontrado pero no es fiscal: ${parsed.error}`);
    }
  }
  if (!qrData) note('Sin QR fiscal legible: la extracción queda sin verificación dura');

  // 3) Texto para el LLM: embebido (gratis y exacto) u OCR local.
  let ocrText = '';
  let ocrSource = null;
  let ocrMs = null;
  let lowConfidence = [];
  if (embeddedText.length >= MIN_EMBEDDED_TEXT) {
    ocrText = embeddedText;
    ocrSource = 'texto embebido del PDF';
  } else if (process.env.MOCK_LLM === '1') {
    ocrText = embeddedText;
    ocrSource = 'sin OCR (MOCK_LLM)';
  } else {
    const o = await runOcr(images[0]);
    ocrText = o.text;
    ocrMs = o.ms;
    lowConfidence = o.lowConfidence;
    ocrSource = `OCR local QVAC (${o.blocks.length} bloques, ${o.ms} ms)`;
    if (lowConfidence.length > 0) {
      note(`OCR marcó ${lowConfidence.length} bloque(s) de baja confianza — se le avisa al LLM`);
    }
  }
  note(`Fuente de texto: ${ocrSource}`);

  // 4) LLM local → JSON validado.
  const { extraction, attempts, issues, stats } = await extractInvoice(ocrText);
  if (attempts > 1) note(`El LLM necesitó ${attempts} intentos (validación local rechazó el primero)`);
  for (const issue of issues) note(`Validación: ${issue}`);

  // 5) Cross-check contra el QR.
  const check = crossCheck(extraction, qrData);
  for (const c of check.corrections) note(`⚠ CORRECCIÓN — ${c.label}: ${c.explicacion}`);
  if (check.status === 'verified' && qrData) note('✓ Extracción del modelo coincide con el QR fiscal en todos los campos verificables');
  if (check.status === 'no_qr') note('Extracción sin verificar (no hay QR): revisar a mano si el monto es grande');
  if (check.unreadFields.length > 0) note(`Quedaron sin dato (ni el modelo ni el QR los aportaron): ${check.unreadFields.join(', ')}`);

  return {
    id: file.id,
    archivo: file.filename,
    status: check.status,
    ...check.invoice,
    corrections: check.corrections,
    unreadFields: check.unreadFields,
    evidence,
    qr: qrData ? { ...qrData, attempt: qrAttempt } : null,
    timing: {
      totalMs: Math.round(performance.now() - t0),
      ocrMs,
      llmMs: stats?.ms ?? null,
      tokensPerSecond: stats?.tokensPerSecond ?? null,
    },
  };
}
