/**
 * Cross-check: extracción del modelo (OCR + LLM) vs QR fiscal de ARCA/AFIP.
 *
 * El QR es dato duro decodificado determinísticamente; el modelo 1-4B puede
 * alucinar. Cuando difieren, gana el QR, la corrección queda registrada como
 * evidencia y el campo corregido se marca en la UI. Esto convierte la
 * debilidad conocida de los modelos chicos en el feature central:
 * extracción auto-verificada.
 *
 * Estados:
 *   verified      — todo lo que el QR sabe coincide con lo extraído
 *   corrected     — el QR contradijo al modelo en ≥1 campo (se corrigió solo)
 *   no_qr         — la factura no tiene QR legible (queda solo la extracción,
 *                   marcada como no verificada)
 *   qr_only       — el modelo no pudo extraer, pero el QR sí se leyó
 */
import { sameAmount } from './util.js';

// Campos que el QR fiscal conoce con autoridad (RG 4892/2020).
const QR_FIELDS = [
  { key: 'cuit', label: 'CUIT emisor', equal: (a, b) => String(a) === String(b) },
  { key: 'fecha', label: 'Fecha', equal: (a, b) => a === b },
  { key: 'total', qrKey: 'importe', label: 'Importe total', equal: sameAmount },
  { key: 'tipoCmp', label: 'Tipo de comprobante', equal: (a, b) => Number(a) === Number(b) },
  { key: 'ptoVta', label: 'Punto de venta', equal: (a, b) => Number(a) === Number(b) },
  { key: 'nroCmp', label: 'Número', equal: (a, b) => Number(a) === Number(b) },
];

/**
 * @param {object|null} extraction  campos que devolvió el modelo (puede tener nulls)
 * @param {object|null} qrData      resultado de parseAfipQr().data, o null si no hubo QR
 * @returns {{ status, invoice, corrections, unverified, unreadFields }}
 *   invoice: la mejor versión de los datos (QR pisa al modelo donde aplique)
 */
export function crossCheck(extraction, qrData) {
  const ext = extraction ?? {};

  if (!qrData) {
    const invoice = { ...ext };
    return {
      status: extractionIsEmpty(ext) ? 'unreadable' : 'no_qr',
      invoice,
      corrections: [],
      unverified: QR_FIELDS.map((f) => f.key),
      unreadFields: collectUnreadFields(invoice),
    };
  }

  const corrections = [];
  const invoice = { ...ext };

  for (const field of QR_FIELDS) {
    const qrValue = qrData[field.qrKey ?? field.key];
    if (qrValue == null) continue;
    const extValue = ext[field.key];

    if (extValue == null) {
      // El modelo no lo leyó; el QR lo completa. No es corrección: es relleno.
      invoice[field.key] = qrValue;
      continue;
    }
    if (!field.equal(extValue, qrValue)) {
      corrections.push({
        field: field.key,
        label: field.label,
        extracted: extValue,
        qr: qrValue,
        explicacion: `El modelo leyó «${fmt(extValue)}» pero el QR fiscal dice «${fmt(qrValue)}» → corregido con el dato del QR.`,
      });
      invoice[field.key] = qrValue;
    }
  }

  // Metadatos que solo el QR aporta.
  invoice.cae = qrData.codAut ?? invoice.cae ?? null;
  invoice.tipoCmpNombre = qrData.tipoCmpNombre ?? invoice.tipoCmpNombre ?? null;
  invoice.moneda = invoice.moneda ?? qrData.moneda ?? null;
  invoice.cuitValido = qrData.cuitValido;

  const status = extractionIsEmpty(ext)
    ? 'qr_only'
    : corrections.length > 0
      ? 'corrected'
      : 'verified';

  // Lo que sigue en null DESPUÉS de que el QR completó lo suyo es lo que de
  // verdad quedó sin leer — honestidad primero.
  return { status, invoice, corrections, unverified: [], unreadFields: collectUnreadFields(invoice) };
}

/** Campos relevantes que quedaron sin dato (ni modelo ni QR los aportaron). */
function collectUnreadFields(invoice) {
  const relevant = ['emisor', 'cuit', 'fecha', 'total', 'tipoCmp', 'ptoVta', 'nroCmp'];
  return relevant.filter((k) => invoice[k] == null);
}

function extractionIsEmpty(ext) {
  return ['cuit', 'fecha', 'total'].every((k) => ext[k] == null);
}

function fmt(v) {
  if (typeof v === 'number') {
    return Number.isInteger(v) ? String(v) : v.toFixed(2).replace('.', ',');
  }
  return String(v);
}
