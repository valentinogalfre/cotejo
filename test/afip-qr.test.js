import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseAfipQr, buildAfipQrUrl, isValidCuit, isAfipQrUrl, formatComprobante } from '../src/afip-qr.js';

// Payload de ejemplo de la propia RG 4892/2020 (documentación oficial AFIP).
const OFFICIAL_EXAMPLE = {
  ver: 1, fecha: '2020-10-13', cuit: 30000000007, ptoVta: 10, tipoCmp: 1,
  nroCmp: 94, importe: 12100, moneda: 'PES', ctz: 65, tipoDocRec: 80,
  nroDocRec: 20000000001, tipoCodAut: 'E', codAut: 70417054367476,
};
const officialUrl = 'https://www.afip.gob.ar/fe/qr/?p=' +
  Buffer.from(JSON.stringify(OFFICIAL_EXAMPLE)).toString('base64');

test('contrato: la URL del ejemplo oficial de la RG 4892/2020 se decodifica campo por campo', () => {
  const r = parseAfipQr(officialUrl);
  assert.equal(r.ok, true);
  assert.equal(r.data.cuit, '30000000007');
  assert.equal(r.data.fecha, '2020-10-13');
  assert.equal(r.data.importe, 12100);
  assert.equal(r.data.ptoVta, 10);
  assert.equal(r.data.tipoCmp, 1);
  assert.equal(r.data.tipoCmpNombre, 'Factura A');
  assert.equal(r.data.nroCmp, 94);
  assert.equal(r.data.codAut, '70417054367476');
});

test('contrato: buildAfipQrUrl y parseAfipQr son inversos (round-trip sin pérdida)', () => {
  const url = buildAfipQrUrl({
    fecha: '2026-08-22', cuit: '30712345678', ptoVta: 3, tipoCmp: 6,
    nroCmp: 1234, importe: 181000.5, codAut: '75123456789012',
  });
  const r = parseAfipQr(url);
  assert.equal(r.ok, true);
  assert.equal(r.data.cuit, '30712345678');
  assert.equal(r.data.importe, 181000.5);
  assert.equal(r.data.tipoCmpNombre, 'Factura B');
  assert.equal(r.data.codAut, '75123456789012');
});

test('contrato: acepta dominio arca.gob.ar (rebranding AFIP→ARCA) y base64url sin padding', () => {
  const json = JSON.stringify(OFFICIAL_EXAMPLE);
  const b64url = Buffer.from(json).toString('base64url');
  const r = parseAfipQr(`https://www.arca.gob.ar/fe/qr/?p=${b64url}`);
  assert.equal(r.ok, true);
  assert.equal(r.data.importe, 12100);
});

test('contrato: un QR que no es fiscal (URL cualquiera) se rechaza sin tirar excepción', () => {
  assert.equal(parseAfipQr('https://example.com/promo?x=1').ok, false);
  assert.equal(parseAfipQr('hola mundo').ok, false);
  assert.equal(parseAfipQr('').ok, false);
  assert.equal(isAfipQrUrl('https://phishing.afip.gob.ar.evil.com/fe/qr/?p=x'), false);
});

test('contrato: QR fiscal con campos obligatorios ausentes se marca inválido', () => {
  const incomplete = Buffer.from(JSON.stringify({ ver: 1, cuit: 30000000007 })).toString('base64');
  const r = parseAfipQr(`https://www.afip.gob.ar/fe/qr/?p=${incomplete}`);
  assert.equal(r.ok, false);
});

test('contrato: validación de CUIT módulo 11 distingue CUITs reales de tipeados', () => {
  assert.equal(isValidCuit('30000000007'), true);  // ejemplo oficial AFIP
  assert.equal(isValidCuit('20329642330'), true);  // dígito verificador correcto
  assert.equal(isValidCuit('20329642331'), false); // último dígito alterado
  assert.equal(isValidCuit('123'), false);
});

test('contrato: formatComprobante produce el formato legal PPPP-NNNNNNNN', () => {
  const s = formatComprobante({ tipoCmpNombre: 'Factura A', ptoVta: 10, nroCmp: 94 });
  assert.equal(s, 'Factura A 0010-00000094');
});
