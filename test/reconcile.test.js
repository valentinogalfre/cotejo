import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reconcile } from '../src/reconcile.js';
import { parseStatementCsv } from '../src/statement.js';

const inv = (over = {}) => ({
  id: 'f1', archivo: 'f1.pdf', emisor: 'Papelera Sarmiento SA', cuit: '30712345678',
  fecha: '2026-08-18', total: 181000, tipoCmp: 6, ptoVta: 3, nroCmp: 1234, ...over,
});
const mov = (over = {}) => ({
  id: 'm1', fecha: '2026-08-19', descripcion: 'TRANSF PAPELERA SARMIENTO', importe: -181000, ...over,
});

test('contrato: factura con débito de igual importe a ±7 días concilia con explicación de una frase', () => {
  const r = reconcile([inv()], [mov()]);
  assert.equal(r.facturas[0].tipo, 'conciliada');
  assert.equal(r.facturas[0].movimiento.id, 'm1');
  assert.ok(r.facturas[0].explicacion.length > 10);
  assert.equal(r.resumen.conciliadas, 1);
});

test('contrato: mismo comprobante cargado dos veces se marca duplicada, no concilia dos veces', () => {
  const r = reconcile([inv({ id: 'f1' }), inv({ id: 'f2', archivo: 'f1-copia.pdf' })], [mov()]);
  const tipos = r.facturas.map((f) => f.tipo).sort();
  assert.deepEqual(tipos, ['conciliada', 'duplicada']);
});

test('contrato: mismo proveedor y fecha pero importe distinto se marca monto_difiere con la diferencia', () => {
  const r = reconcile([inv({ total: 181000 })], [mov({ importe: -118000 })]);
  assert.equal(r.facturas[0].tipo, 'monto_difiere');
  assert.match(r.facturas[0].explicacion, /diferencia/);
});

test('contrato: factura sin movimiento queda sin_match; débito sin factura queda sin_factura', () => {
  const r = reconcile(
    [inv()],
    [mov({ id: 'm9', descripcion: 'DEBITO EDESUR', importe: -50000, fecha: '2026-08-18' })],
  );
  assert.equal(r.facturas[0].tipo, 'sin_match');
  assert.equal(r.sinFactura.length, 1);
  assert.match(r.sinFactura[0].explicacion, /sin factura/);
});

test('contrato: un movimiento no se puede usar para conciliar dos facturas distintas', () => {
  const facturas = [
    inv({ id: 'f1', nroCmp: 1234 }),
    inv({ id: 'f2', nroCmp: 5678, fecha: '2026-08-19' }),
  ];
  const r = reconcile(facturas, [mov()]);
  const conciliadas = r.facturas.filter((f) => f.tipo === 'conciliada');
  assert.equal(conciliadas.length, 1);
});

test('contrato: factura sin total legible no concilia y lo dice honestamente', () => {
  const r = reconcile([inv({ total: null })], [mov()]);
  assert.equal(r.facturas[0].tipo, 'sin_match');
  assert.match(r.facturas[0].explicacion, /No pude leer/);
});

test('contrato: el CSV bancario con debito/credito separados normaliza signos (débito negativo)', () => {
  const csv = [
    'Fecha;Concepto;Débito;Crédito;Saldo',
    '19/08/2026;TRANSF PAPELERA SARMIENTO;181.000,00;;1.000.000,00',
    '20/08/2026;ACREDITACION VENTAS;;250.000,00;1.250.000,00',
  ].join('\n');
  const { movimientos } = parseStatementCsv(csv);
  assert.equal(movimientos.length, 2);
  assert.equal(movimientos[0].importe, -181000);
  assert.equal(movimientos[1].importe, 250000);
  assert.equal(movimientos[0].fecha, '2026-08-19');
});

test('contrato: CSV con columna única de importe firmado también se acepta', () => {
  const csv = [
    'fecha,descripcion,importe',
    '19/08/2026,TRANSF PAPELERA,-181000.00',
  ].join('\n');
  const { movimientos } = parseStatementCsv(csv);
  assert.equal(movimientos.length, 1);
  assert.equal(movimientos[0].importe, -181000);
});

test('contrato: filas de saldo/totales sin fecha válida se saltean sin romper el parseo', () => {
  const csv = [
    'Fecha;Concepto;Débito;Crédito',
    '19/08/2026;PAGO;100,00;',
    'SALDO FINAL;;;"1.000,00"',
  ].join('\n');
  const { movimientos } = parseStatementCsv(csv);
  assert.equal(movimientos.length, 1);
});
