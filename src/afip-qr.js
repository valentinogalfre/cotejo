/**
 * Decodificación determinística del QR fiscal de ARCA/AFIP (RG 4892/2020).
 *
 * Toda factura electrónica argentina lleva un QR cuyo contenido es una URL:
 *   https://www.afip.gob.ar/fe/qr/?p=<base64>
 * donde <base64> codifica un JSON con los datos duros del comprobante:
 *   { ver, fecha, cuit, ptoVta, tipoCmp, nroCmp, importe, moneda, ctz,
 *     tipoDocRec, nroDocRec, tipoCodAut, codAut }
 *
 * Este módulo NO usa IA: es la fuente de verdad contra la que se cotejea
 * lo que el modelo extrajo por OCR.
 */

const QR_HOSTS = new Set([
  'www.afip.gob.ar',
  'afip.gob.ar',
  'www.arca.gob.ar',
  'arca.gob.ar',
  'servicioscf.afip.gob.ar',
]);

// Tipos de comprobante más comunes (tabla AFIP "tipoCmp").
export const TIPO_CMP = {
  1: 'Factura A',
  2: 'Nota de Débito A',
  3: 'Nota de Crédito A',
  6: 'Factura B',
  7: 'Nota de Débito B',
  8: 'Nota de Crédito B',
  11: 'Factura C',
  12: 'Nota de Débito C',
  13: 'Nota de Crédito C',
  19: 'Factura E',
  51: 'Factura M',
  201: 'FCE MiPyME A',
  206: 'FCE MiPyME B',
  211: 'FCE MiPyME C',
};

/**
 * ¿La cadena decodificada de un QR parece un QR fiscal de AFIP/ARCA?
 */
export function isAfipQrUrl(text) {
  if (typeof text !== 'string') return false;
  try {
    const url = new URL(text.trim());
    return QR_HOSTS.has(url.hostname.toLowerCase()) && url.searchParams.has('p');
  } catch {
    return false;
  }
}

/**
 * Parsea el contenido de un QR fiscal. Acepta:
 *  - la URL completa (caso real)
 *  - el base64 pelado del parámetro `p`
 *  - el JSON ya decodificado (por conveniencia en tests)
 *
 * Devuelve { ok: true, data } o { ok: false, error }.
 * `data` queda normalizada: cuit como string de 11 dígitos, fecha ISO,
 * importe como número.
 */
export function parseAfipQr(text) {
  if (typeof text !== 'string' || !text.trim()) {
    return { ok: false, error: 'QR vacío' };
  }
  const raw = text.trim();

  let payload = null;
  if (raw.startsWith('{')) {
    payload = raw;
  } else if (isAfipQrUrl(raw)) {
    const p = new URL(raw).searchParams.get('p');
    payload = decodeBase64(p);
    if (payload === null) return { ok: false, error: 'Base64 inválido en parámetro p' };
  } else {
    payload = decodeBase64(raw);
    if (payload === null || !payload.trimStart().startsWith('{')) {
      return { ok: false, error: 'El QR no es un QR fiscal de AFIP/ARCA' };
    }
  }

  let json;
  try {
    json = JSON.parse(payload);
  } catch {
    return { ok: false, error: 'JSON inválido dentro del QR' };
  }

  const cuit = normalizeCuit(json.cuit);
  const fecha = normalizeFecha(json.fecha);
  const importe = normalizeImporte(json.importe);
  if (!cuit || !fecha || importe === null) {
    return { ok: false, error: 'QR fiscal incompleto (falta cuit, fecha o importe)' };
  }

  return {
    ok: true,
    data: {
      ver: json.ver ?? null,
      fecha,
      cuit,
      cuitValido: isValidCuit(cuit),
      ptoVta: toInt(json.ptoVta),
      tipoCmp: toInt(json.tipoCmp),
      tipoCmpNombre: TIPO_CMP[toInt(json.tipoCmp)] ?? `Comprobante ${json.tipoCmp}`,
      nroCmp: toInt(json.nroCmp),
      importe,
      moneda: typeof json.moneda === 'string' ? json.moneda : null,
      ctz: normalizeImporte(json.ctz),
      tipoDocRec: toInt(json.tipoDocRec),
      nroDocRec: json.nroDocRec != null ? String(json.nroDocRec) : null,
      tipoCodAut: json.tipoCodAut ?? null,
      codAut: json.codAut != null ? String(json.codAut) : null,
    },
  };
}

/**
 * Arma el contenido de un QR fiscal (URL AFIP) a partir de sus campos.
 * Usado por el generador de datos de prueba; inverso exacto de parseAfipQr.
 */
export function buildAfipQrUrl(fields) {
  const json = JSON.stringify({
    ver: 1,
    fecha: fields.fecha,
    cuit: Number(fields.cuit),
    ptoVta: fields.ptoVta,
    tipoCmp: fields.tipoCmp,
    nroCmp: fields.nroCmp,
    importe: fields.importe,
    moneda: fields.moneda ?? 'PES',
    ctz: fields.ctz ?? 1,
    tipoDocRec: fields.tipoDocRec ?? 80,
    nroDocRec: fields.nroDocRec != null ? Number(fields.nroDocRec) : 0,
    tipoCodAut: fields.tipoCodAut ?? 'E',
    codAut: fields.codAut != null ? Number(fields.codAut) : 0,
  });
  const b64 = Buffer.from(json, 'utf8').toString('base64');
  return `https://www.afip.gob.ar/fe/qr/?p=${b64}`;
}

/** Identificador humano del comprobante: "Factura A 0010-00000094". */
export function formatComprobante(d) {
  const pv = String(d.ptoVta ?? 0).padStart(4, '0');
  const nro = String(d.nroCmp ?? 0).padStart(8, '0');
  return `${d.tipoCmpNombre ?? TIPO_CMP[d.tipoCmp] ?? 'Comprobante'} ${pv}-${nro}`;
}

/** Valida CUIT con el dígito verificador módulo 11. */
export function isValidCuit(cuit) {
  const s = String(cuit ?? '').replace(/\D/g, '');
  if (s.length !== 11) return false;
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(s[i]) * weights[i];
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) check = 9; // convención AFIP
  return check === Number(s[10]);
}

export function normalizeCuit(value) {
  if (value == null) return null;
  const s = String(value).replace(/\D/g, '');
  return s.length === 11 ? s : null;
}

function normalizeFecha(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  // La RG especifica formato completo yyyy-mm-dd; algunos emisores usan yyyymmdd.
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (!m) return null;
  const [, y, mo, d] = m;
  const date = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  return `${y}-${mo}-${d}`;
}

function normalizeImporte(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return round2(value);
  if (typeof value === 'string') {
    const n = Number(value.replace(',', '.'));
    if (Number.isFinite(n)) return round2(n);
  }
  return null;
}

function toInt(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function decodeBase64(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  // Tolerar base64url y padding faltante (hay emisores que lo omiten).
  let s = value.trim().replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4 !== 0) s += '=';
  try {
    const buf = Buffer.from(s, 'base64');
    if (buf.length === 0) return null;
    return buf.toString('utf8');
  } catch {
    return null;
  }
}
