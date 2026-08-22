import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crossCheck } from '../src/crosscheck.js';

const QR = {
  fecha: '2026-08-20', cuit: '30712345678', cuitValido: true,
  ptoVta: 3, tipoCmp: 6, tipoCmpNombre: 'Factura B', nroCmp: 1234,
  importe: 181000, moneda: 'PES', codAut: '75123456789012',
};

test('contrato: si el modelo alucina el importe, el QR lo corrige y queda registrado como evidencia', () => {
  const ext = { emisor: 'Papelera Sarmiento SA', cuit: '30712345678', fecha: '2026-08-20', total: 118000, tipoCmp: 6, ptoVta: 3, nroCmp: 1234 };
  const r = crossCheck(ext, QR);
  assert.equal(r.status, 'corrected');
  assert.equal(r.invoice.total, 181000); // gana el QR
  assert.equal(r.corrections.length, 1);
  assert.equal(r.corrections[0].field, 'total');
  assert.equal(r.corrections[0].extracted, 118000);
  assert.equal(r.corrections[0].qr, 181000);
  assert.match(r.corrections[0].explicacion, /QR fiscal/);
});

test('contrato: extracción idéntica al QR queda verified sin correcciones', () => {
  const ext = { emisor: 'Papelera Sarmiento SA', cuit: '30712345678', fecha: '2026-08-20', total: 181000, tipoCmp: 6, ptoVta: 3, nroCmp: 1234 };
  const r = crossCheck(ext, QR);
  assert.equal(r.status, 'verified');
  assert.equal(r.corrections.length, 0);
  assert.equal(r.invoice.cae, '75123456789012'); // el QR aporta el CAE
});

test('contrato: campo que el modelo no leyó (null) se completa desde el QR sin contarlo como corrección ni como ilegible', () => {
  const ext = { emisor: 'Papelera Sarmiento SA', cuit: null, fecha: '2026-08-20', total: 181000, tipoCmp: null, ptoVta: null, nroCmp: null };
  const r = crossCheck(ext, QR);
  assert.equal(r.status, 'verified');
  assert.equal(r.invoice.cuit, '30712345678');
  // El QR lo completó → ya no cuenta como ilegible en el resultado final.
  assert.deepEqual(r.unreadFields, []);
});

test('contrato: la tolerancia de centavos no dispara correcciones espurias', () => {
  const ext = { cuit: '30712345678', fecha: '2026-08-20', total: 181000.01, tipoCmp: 6, ptoVta: 3, nroCmp: 1234 };
  const r = crossCheck(ext, QR);
  assert.equal(r.status, 'verified');
});

test('contrato: sin QR la extracción queda marcada como no verificada, nunca como verificada', () => {
  const ext = { emisor: 'Kiosco 25', cuit: null, fecha: '2026-08-21', total: 4500 };
  const r = crossCheck(ext, null);
  assert.equal(r.status, 'no_qr');
  assert.ok(r.unverified.length > 0);
});

test('contrato: modelo mudo + QR legible = qr_only (el QR solo alcanza para conciliar)', () => {
  const r = crossCheck({ emisor: null, cuit: null, fecha: null, total: null }, QR);
  assert.equal(r.status, 'qr_only');
  assert.equal(r.invoice.total, 181000);
  assert.equal(r.invoice.fecha, '2026-08-20');
});

test('contrato: sin QR y sin extracción útil = unreadable (incertidumbre honesta)', () => {
  const r = crossCheck({ emisor: null, cuit: null, fecha: null, total: null }, null);
  assert.equal(r.status, 'unreadable');
});
