/**
 * Utilidades de normalización para datos financieros argentinos.
 * Sin dependencias, sin IA: todo determinístico y testeable.
 */

/**
 * Parsea importes en los formatos que aparecen en facturas y extractos:
 *   "1.234.567,89" (es-AR) · "1,234,567.89" (en-US) · "1234567.89" · "$ 118.000,00"
 * Devuelve número (2 decimales) o null.
 */
export function parseMoneyAR(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return round2(value);
  if (typeof value !== 'string') return null;
  let s = value.trim().replace(/[^\d.,\-−()]/g, '');
  if (!s || /^[-−().,]*$/.test(s)) return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
  if (/^[-−]/.test(s)) { negative = true; s = s.replace(/^[-−]+/, ''); }

  const lastComma = s.lastIndexOf(',');
  const lastDot = s.lastIndexOf('.');
  let normalized;
  if (lastComma === -1 && lastDot === -1) {
    normalized = s;
  } else if (lastComma > lastDot) {
    // Coma decimal (es-AR): puntos son separadores de miles.
    normalized = s.replace(/\./g, '').replace(',', '.');
  } else {
    // Punto decimal (en-US) o punto de miles sin decimales.
    const decimals = s.length - lastDot - 1;
    if (lastComma === -1 && decimals === 3 && s.length > 4 && !s.includes(',')) {
      // "118.000" → ambiguo; en contexto AR es separador de miles.
      normalized = s.replace(/\./g, '');
    } else {
      normalized = s.replace(/,/g, '');
    }
  }

  const n = Number(normalized);
  if (!Number.isFinite(n)) return null;
  return round2(negative ? -n : n);
}

/**
 * Parsea fechas en formatos comunes de AR: "22/08/2026", "22-08-26",
 * "2026-08-22", "22.08.2026". Devuelve ISO "yyyy-mm-dd" o null.
 */
export function parseDateAR(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value !== 'string') return null;
  const s = value.trim();

  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return validIso(m[1], m[2], m[3]);

  m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})/);
  if (m) {
    let [, d, mo, y] = m;
    if (y.length === 2) y = Number(y) > 50 ? `19${y}` : `20${y}`;
    return validIso(y, mo.padStart(2, '0'), d.padStart(2, '0'));
  }
  return null;
}

function validIso(y, mo, d) {
  const date = new Date(`${y}-${mo}-${d}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return null;
  // Rechazar overflow (ej. 31/02 → 03/03).
  if (date.toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return null;
  return `${y}-${mo}-${d}`;
}

/** Diferencia en días entre dos fechas ISO (b - a). */
export function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/** Igualdad monetaria con tolerancia de centavos. */
export function sameAmount(a, b, tolerance = 0.01) {
  return a != null && b != null && Math.abs(a - b) <= tolerance + 1e-9;
}

export function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/** Normaliza texto para comparaciones difusas: minúsculas, sin tildes ni símbolos. */
export function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9ñ\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'sa', 'srl', 'sas', 'sacif', 'saic', 'sc', 'de', 'del', 'la', 'el', 'los',
  'las', 'y', 'e', 'sociedad', 'anonima', 'responsabilidad', 'limitada',
  'transferencia', 'pago', 'debito', 'credito', 'compra', 'tarjeta', 'deb',
  'aut', 'inmediata', 'recibida', 'enviada', 'varios', 'proveedor', 'factura',
]);

/**
 * Score de coincidencia [0..1] entre el nombre de un emisor y la descripción
 * de un movimiento bancario, por solapamiento de tokens significativos.
 */
export function nameMatchScore(name, description) {
  const a = tokensOf(name);
  const b = new Set(tokensOf(description));
  if (a.length === 0 || b.size === 0) return 0;
  let hits = 0;
  for (const t of a) if (b.has(t)) hits++;
  return hits / a.length;
}

function tokensOf(s) {
  return normalizeText(s)
    .split(' ')
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

export function formatMoneyAR(n) {
  if (n == null) return '—';
  return new Intl.NumberFormat('es-AR', {
    style: 'currency',
    currency: 'ARS',
    minimumFractionDigits: 2,
  }).format(n);
}
