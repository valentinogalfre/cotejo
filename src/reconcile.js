/**
 * Motor de conciliación: facturas extraídas vs movimientos del extracto.
 *
 * Determinístico y explicable: cada resultado lleva una explicación de una
 * frase que un humano verifica en cinco segundos. Categorías:
 *   - conciliada:      match por importe + fecha (y nombre/CUIT si aparece)
 *   - duplicada:       mismo comprobante (cuit+tipo+ptoVta+nro) cargado 2 veces
 *   - monto_difiere:   mismo proveedor y fecha cercana, importe distinto
 *   - sin_match:       factura sin movimiento correspondiente
 * Además reporta movimientos del extracto sin factura (sin_factura).
 */
import { sameAmount, daysBetween, nameMatchScore, formatMoneyAR } from './util.js';
import { formatComprobante } from './afip-qr.js';

const MAX_DAYS = 7; // ventana de días entre factura y débito bancario

export function reconcile(invoices, movimientos) {
  const results = [];
  const usedMovs = new Set();

  // 1) Duplicados exactos por clave de comprobante.
  const byKey = new Map();
  for (const inv of invoices) {
    const key = comprobanteKey(inv);
    if (key && byKey.has(key)) {
      results.push({
        tipo: 'duplicada',
        factura: inv,
        duplicadaDe: byKey.get(key).id,
        explicacion: `Mismo comprobante que ${label(byKey.get(key))}: igual CUIT, tipo, punto de venta y número. Cargada dos veces.`,
      });
      continue;
    }
    if (key) byKey.set(key, inv);
    results.push({ tipo: 'pendiente', factura: inv });
  }

  const pendientes = results.filter((r) => r.tipo === 'pendiente');

  // 2) Match exacto por importe + ventana de fecha. Egresos: factura de
  //    compra ↔ débito (importe negativo en el extracto).
  for (const r of pendientes) {
    const inv = r.factura;
    if (inv.total == null || !inv.fecha) continue;
    const candidates = movimientos
      .filter((m) => !usedMovs.has(m.id) && sameAmount(Math.abs(m.importe), inv.total))
      .map((m) => ({ m, dist: Math.abs(daysBetween(inv.fecha, m.fecha)) }))
      .filter((c) => c.dist <= MAX_DAYS)
      .sort((a, b) =>
        a.dist - b.dist ||
        movNameScore(inv, b.m) - movNameScore(inv, a.m));
    if (candidates.length > 0) {
      const { m, dist } = candidates[0];
      usedMovs.add(m.id);
      r.tipo = 'conciliada';
      r.movimiento = m;
      const porQue = movNameScore(inv, m) < 0.5 ? '.'
        : inv.emisor ? ` y la descripción menciona a «${inv.emisor}».`
        : ' y la descripción incluye el CUIT del emisor.';
      r.explicacion =
        `${formatMoneyAR(inv.total)} coincide con el movimiento del ${fmtFecha(m.fecha)}` +
        (dist === 0 ? ' (mismo día)' : ` (${dist} día${dist === 1 ? '' : 's'} de diferencia)`) + porQue;
    }
  }

  // 3) Mismo proveedor + fecha cercana pero importe distinto.
  for (const r of pendientes) {
    if (r.tipo !== 'pendiente') continue;
    const inv = r.factura;
    if (!inv.fecha) continue;
    const candidates = movimientos
      .filter((m) => !usedMovs.has(m.id) && Math.abs(daysBetween(inv.fecha, m.fecha)) <= MAX_DAYS)
      .map((m) => ({ m, score: movNameScore(inv, m) }))
      .filter((c) => c.score >= 0.5)
      .sort((a, b) => b.score - a.score);
    if (candidates.length > 0 && inv.total != null) {
      const { m } = candidates[0];
      usedMovs.add(m.id);
      const diff = Math.abs(Math.abs(m.importe) - inv.total);
      r.tipo = 'monto_difiere';
      r.movimiento = m;
      r.explicacion =
        `La factura dice ${formatMoneyAR(inv.total)} pero el banco registró ${formatMoneyAR(Math.abs(m.importe))} ` +
        `(diferencia de ${formatMoneyAR(diff)}) para el mismo proveedor con ${Math.abs(daysBetween(inv.fecha, m.fecha))} día(s) de diferencia.`;
    }
  }

  // 4) Lo que quedó sin match.
  for (const r of pendientes) {
    if (r.tipo !== 'pendiente') continue;
    const inv = r.factura;
    r.tipo = 'sin_match';
    r.explicacion = inv.total == null
      ? 'No pude leer el importe total de esta factura, así que no la puedo conciliar — revisar a mano.'
      : `Ningún movimiento del extracto coincide con ${formatMoneyAR(inv.total)} dentro de ±${MAX_DAYS} días del ${fmtFecha(inv.fecha)}.`;
  }

  const sinFactura = movimientos
    .filter((m) => !usedMovs.has(m.id) && m.importe < 0)
    .map((m) => ({
      tipo: 'sin_factura',
      movimiento: m,
      explicacion: `Débito de ${formatMoneyAR(Math.abs(m.importe))} el ${fmtFecha(m.fecha)} («${m.descripcion}») sin factura que lo respalde.`,
    }));

  return {
    facturas: results,
    sinFactura,
    resumen: summarize(results, sinFactura),
  };
}

function summarize(results, sinFactura) {
  const count = (t) => results.filter((r) => r.tipo === t).length;
  return {
    total: results.length,
    conciliadas: count('conciliada'),
    duplicadas: count('duplicada'),
    montoDifiere: count('monto_difiere'),
    sinMatch: count('sin_match'),
    movimientosSinFactura: sinFactura.length,
  };
}

function comprobanteKey(inv) {
  if (!inv.cuit || inv.tipoCmp == null || inv.ptoVta == null || inv.nroCmp == null) return null;
  return `${inv.cuit}|${inv.tipoCmp}|${inv.ptoVta}|${inv.nroCmp}`;
}

function movNameScore(inv, m) {
  let score = nameMatchScore(inv.emisor, m.descripcion);
  if (inv.cuit && String(m.descripcion).replace(/\D/g, '').includes(inv.cuit)) {
    score = Math.max(score, 1);
  }
  return score;
}

function label(inv) {
  if (inv.tipoCmp != null && inv.ptoVta != null) {
    return formatComprobante({ tipoCmp: inv.tipoCmp, ptoVta: inv.ptoVta, nroCmp: inv.nroCmp });
  }
  return inv.archivo ?? inv.id;
}

function fmtFecha(iso) {
  if (!iso) return '—';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}
