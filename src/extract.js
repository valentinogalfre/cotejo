/**
 * Extracción estructurada: texto OCR → JSON de factura, con un LLM 1-4B local.
 *
 * Defensa en profundidad contra alucinaciones del modelo chico:
 *  1. Salida forzada por JSON Schema (gramática llama.cpp) — no puede emitir
 *     otra forma.
 *  2. Validación semántica local (CUIT módulo 11, fechas reales, montos) —
 *     lo inválido se anula a null, nunca se "arregla" inventando.
 *  3. Un reintento con los errores concretos en el prompt.
 *  4. El cross-check contra el QR fiscal (src/crosscheck.js) como juez final.
 *
 * El modelo tiene UNA instrucción de honestidad: si no lo ve, null.
 */
import { completeJson } from './qvac.js';
import { parseMoneyAR, parseDateAR } from './util.js';
import { normalizeCuit, isValidCuit } from './afip-qr.js';

export const INVOICE_SCHEMA = {
  type: 'object',
  properties: {
    emisor: { type: ['string', 'null'], description: 'Razón social del emisor' },
    cuit: { type: ['string', 'null'], description: 'CUIT del emisor, solo 11 dígitos' },
    fecha: { type: ['string', 'null'], description: 'Fecha de emisión, formato yyyy-mm-dd' },
    tipoCmp: { type: ['integer', 'null'], description: 'Código AFIP: 1=A, 6=B, 11=C' },
    ptoVta: { type: ['integer', 'null'], description: 'Punto de venta (los 4-5 dígitos antes del guión)' },
    nroCmp: { type: ['integer', 'null'], description: 'Número de comprobante (después del guión)' },
    total: { type: ['number', 'null'], description: 'Importe total final en pesos' },
    moneda: { type: ['string', 'null'] },
  },
  required: ['emisor', 'cuit', 'fecha', 'tipoCmp', 'ptoVta', 'nroCmp', 'total', 'moneda'],
  additionalProperties: false,
};
// Nota: no se piden los renglones (items) a propósito — la conciliación usa
// solo la cabecera, y generar el detalle multiplicaba la latencia por factura
// en un modelo de 4B sin aportar nada al matching.

const SYSTEM_PROMPT = `Sos un extractor de datos de facturas argentinas. Recibís el texto OCR crudo de UNA factura (puede tener errores de lectura; los tramos marcados ⟨dudoso⟩ son poco confiables).

Reglas estrictas:
- Extraé SOLO lo que está en el texto. Si un dato no aparece o no es legible, devolvé null. NUNCA inventes ni completes de memoria.
- cuit: los 11 dígitos del CUIT del EMISOR (no el del cliente), sin guiones.
- fecha: fecha de emisión en formato yyyy-mm-dd (en Argentina las fechas vienen dd/mm/yyyy).
- Los importes usan punto para miles y coma para decimales: "181.000,50" es 181000.50.
- total: el importe total final (con IVA), no el subtotal.
- tipoCmp: 1 si es Factura A, 6 si es B, 11 si es C, 3=NC A, 8=NC B, 13=NC C.
- ptoVta y nroCmp: del número tipo "0003-00001234" → ptoVta 3, nroCmp 1234.
Respondé únicamente el JSON pedido.`;

/**
 * @param {string} ocrText texto crudo (OCR o texto embebido del PDF)
 * @returns {Promise<{ extraction, attempts, issues, stats }>}
 */
export async function extractInvoice(ocrText) {
  if (process.env.MOCK_LLM === '1') {
    return { extraction: mockExtract(ocrText), attempts: 0, issues: ['MOCK_LLM activo: extracción por regex, solo para desarrollo de UI'], stats: null };
  }

  let issues = [];
  let lastStats = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const user = attempt === 1
      ? `Texto OCR de la factura:\n"""\n${clip(ocrText)}\n"""`
      : `Texto OCR de la factura:\n"""\n${clip(ocrText)}\n"""\n\nTu intento anterior tuvo estos problemas, corregilos (si el dato no está legible, usá null):\n- ${issues.join('\n- ')}`;

    const { json, stats } = await completeJson({
      system: SYSTEM_PROMPT,
      user,
      schema: INVOICE_SCHEMA,
      schemaName: 'factura',
      maxTokens: 400,
    });
    lastStats = stats;
    if (!json) {
      issues = ['La respuesta no fue JSON válido'];
      continue;
    }
    const { cleaned, problems } = sanitize(json);
    if (problems.length === 0 || attempt === 2) {
      return { extraction: cleaned, attempts: attempt, issues: problems, stats: lastStats };
    }
    issues = problems;
  }
  return { extraction: null, attempts: 2, issues, stats: lastStats };
}

/**
 * Validación semántica: lo que no pasa se anula a null y queda reportado.
 * Nunca inventamos un valor "corregido" acá — eso es del QR, no nuestro.
 */
export function sanitize(raw) {
  const problems = [];
  const cleaned = {
    emisor: strOrNull(raw.emisor),
    cuit: null,
    fecha: null,
    tipoCmp: intOrNull(raw.tipoCmp),
    ptoVta: intOrNull(raw.ptoVta),
    nroCmp: intOrNull(raw.nroCmp),
    total: null,
    moneda: strOrNull(raw.moneda),
  };

  const cuit = normalizeCuit(raw.cuit);
  if (raw.cuit != null && !cuit) {
    problems.push(`El CUIT «${raw.cuit}» no tiene 11 dígitos`);
  } else if (cuit && !isValidCuit(cuit)) {
    problems.push(`El CUIT «${cuit}» no pasa el dígito verificador (módulo 11): releé el texto`);
  } else {
    cleaned.cuit = cuit;
  }

  const fecha = raw.fecha != null ? parseDateAR(String(raw.fecha)) : null;
  if (raw.fecha != null && !fecha) {
    problems.push(`La fecha «${raw.fecha}» no es una fecha real en formato yyyy-mm-dd`);
  } else {
    cleaned.fecha = fecha;
  }

  const total = parseMoneyAR(raw.total);
  if (raw.total != null && total == null) {
    problems.push(`El total «${raw.total}» no es un número`);
  } else if (total != null && total < 0) {
    problems.push(`El total no puede ser negativo (${total})`);
  } else {
    cleaned.total = total;
  }

  return { cleaned, problems };
}

function clip(text, max = 6000) {
  const s = String(text ?? '');
  return s.length > max ? `${s.slice(0, max)}\n[...texto truncado...]` : s;
}

function strOrNull(v) {
  return typeof v === 'string' && v.trim() ? v.trim().slice(0, 200) : null;
}

function intOrNull(v) {
  return Number.isInteger(v) ? v : null;
}

/**
 * Extractor regex determinístico — SOLO para desarrollo de UI sin modelo
 * cargado (MOCK_LLM=1). No se usa en el demo ni en la submission: la
 * extracción real es del LLM local vía QVAC.
 */
export function mockExtract(text) {
  const s = String(text ?? '');
  const cuitMatch = s.match(/\b(2[0347]|3[034])[-.\s]?(\d{8})[-.\s]?(\d)\b/);
  const dateMatch = s.match(/\b(\d{2})[/](\d{2})[/](\d{4})\b/);
  const cmpMatch = s.match(/\b(\d{4,5})\s*-\s*(\d{8})\b/);
  const amounts = [...s.matchAll(/\d{1,3}(?:\.\d{3})+,\d{2}|\d+,\d{2}/g)]
    .map((m) => parseMoneyAR(m[0]))
    .filter((n) => n != null);
  const tipo = /factura\s*a\b/i.test(s) ? 1 : /factura\s*c\b/i.test(s) ? 11 : /factura\s*b\b/i.test(s) ? 6 : null;
  return {
    emisor: null,
    cuit: cuitMatch ? normalizeCuit(cuitMatch.slice(1).join('')) : null,
    fecha: dateMatch ? parseDateAR(dateMatch[0]) : null,
    tipoCmp: tipo,
    ptoVta: cmpMatch ? Number(cmpMatch[1]) : null,
    nroCmp: cmpMatch ? Number(cmpMatch[2]) : null,
    total: amounts.length ? Math.max(...amounts) : null,
    moneda: null,
    items: [],
  };
}
