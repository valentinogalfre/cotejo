/**
 * Parser del extracto bancario en CSV.
 *
 * Los bancos argentinos exportan con columnas variadas; detectamos por
 * nombre de header (fecha / concepto|descripcion|detalle / debito / credito
 * / importe|monto) y normalizamos a:
 *   { id, fecha: 'yyyy-mm-dd', descripcion, importe }  (importe < 0 = egreso)
 */
import { parse } from 'csv-parse/sync';
import { parseMoneyAR, parseDateAR, normalizeText } from './util.js';

const FECHA_KEYS = ['fecha', 'fecha operacion', 'fecha mov', 'date'];
const DESC_KEYS = ['descripcion', 'concepto', 'detalle', 'referencia', 'movimiento', 'description'];
const DEBITO_KEYS = ['debito', 'debitos', 'debe', 'egreso', 'egresos', 'debit'];
const CREDITO_KEYS = ['credito', 'creditos', 'haber', 'ingreso', 'ingresos', 'credit'];
const IMPORTE_KEYS = ['importe', 'monto', 'amount', 'importe pesos', 'importe ars'];

export function parseStatementCsv(csvText) {
  const text = String(csvText).replace(/^\ufeff/, '');
  const delimiter = detectDelimiter(text);
  const rows = parse(text, {
    delimiter,
    columns: false,
    skip_empty_lines: true,
    relax_column_count: true,
    trim: true,
  });
  if (rows.length === 0) return { movimientos: [], warnings: ['CSV vacío'] };

  const headerIdx = rows.findIndex((r) => findKey(r, FECHA_KEYS) !== -1);
  if (headerIdx === -1) {
    return { movimientos: [], warnings: ['No encontré una fila de encabezados con columna de fecha'] };
  }
  const header = rows[headerIdx].map((h) => normalizeText(h));
  const col = {
    fecha: findKey(header, FECHA_KEYS),
    desc: findKey(header, DESC_KEYS),
    debito: findKey(header, DEBITO_KEYS),
    credito: findKey(header, CREDITO_KEYS),
    importe: findKey(header, IMPORTE_KEYS),
  };

  const warnings = [];
  const movimientos = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const fecha = parseDateAR(row[col.fecha]);
    if (!fecha) continue; // filas de saldo/totales

    let importe = null;
    if (col.debito !== -1 || col.credito !== -1) {
      const deb = col.debito !== -1 ? parseMoneyAR(row[col.debito]) : null;
      const cred = col.credito !== -1 ? parseMoneyAR(row[col.credito]) : null;
      if (deb != null && deb !== 0) importe = -Math.abs(deb);
      else if (cred != null && cred !== 0) importe = Math.abs(cred);
    }
    if (importe == null && col.importe !== -1) {
      importe = parseMoneyAR(row[col.importe]);
    }
    if (importe == null) {
      warnings.push(`Fila ${i + 1}: sin importe legible, la salteo`);
      continue;
    }

    movimientos.push({
      id: `mov-${movimientos.length + 1}`,
      fila: i + 1,
      fecha,
      descripcion: col.desc !== -1 ? String(row[col.desc] ?? '').trim() : '',
      importe,
    });
  }

  return { movimientos, warnings };
}

function findKey(headerRow, keys) {
  const normalized = headerRow.map((h) => normalizeText(h));
  for (const key of keys) {
    const idx = normalized.findIndex((h) => h === key || h.startsWith(key));
    if (idx !== -1) return idx;
  }
  return -1;
}

function detectDelimiter(text) {
  const firstLines = text.split(/\r?\n/).slice(0, 5).join('\n');
  const counts = [
    [';', (firstLines.match(/;/g) || []).length],
    [',', (firstLines.match(/,/g) || []).length],
    ['\t', (firstLines.match(/\t/g) || []).length],
  ];
  counts.sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}
