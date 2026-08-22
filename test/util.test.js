import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMoneyAR, parseDateAR, sameAmount, daysBetween, nameMatchScore } from '../src/util.js';

test('contrato: importes es-AR con punto de miles y coma decimal se leen bien', () => {
  assert.equal(parseMoneyAR('1.234.567,89'), 1234567.89);
  assert.equal(parseMoneyAR('$ 118.000,00'), 118000);
  assert.equal(parseMoneyAR('181.000'), 181000); // punto de miles sin decimales
  assert.equal(parseMoneyAR('0,50'), 0.5);
});

test('contrato: importes en-US y sin separadores también se leen', () => {
  assert.equal(parseMoneyAR('1,234,567.89'), 1234567.89);
  assert.equal(parseMoneyAR('118000.5'), 118000.5);
  assert.equal(parseMoneyAR(42), 42);
});

test('contrato: negativos con signo o paréntesis contables', () => {
  assert.equal(parseMoneyAR('-118.000,00'), -118000);
  assert.equal(parseMoneyAR('(118.000,00)'), -118000);
});

test('contrato: basura no numérica devuelve null, nunca NaN ni excepción', () => {
  assert.equal(parseMoneyAR('N/A'), null);
  assert.equal(parseMoneyAR(''), null);
  assert.equal(parseMoneyAR(null), null);
});

test('contrato: fechas dd/mm/yyyy, dd-mm-yy y ISO normalizan a ISO', () => {
  assert.equal(parseDateAR('22/08/2026'), '2026-08-22');
  assert.equal(parseDateAR('05-01-26'), '2026-01-05');
  assert.equal(parseDateAR('2026-08-22'), '2026-08-22');
  assert.equal(parseDateAR('22.08.2026'), '2026-08-22');
});

test('contrato: fechas imposibles (31/02) se rechazan en vez de desbordar', () => {
  assert.equal(parseDateAR('31/02/2026'), null);
  assert.equal(parseDateAR('99/99/9999'), null);
});

test('contrato: tolerancia monetaria es de centavos, no de pesos', () => {
  assert.equal(sameAmount(100, 100.01), true);
  assert.equal(sameAmount(100, 100.02), false);
});

test('contrato: daysBetween cuenta días calendario con signo', () => {
  assert.equal(daysBetween('2026-08-22', '2026-08-25'), 3);
  assert.equal(daysBetween('2026-08-25', '2026-08-22'), -3);
});

test('contrato: nameMatchScore encuentra al proveedor en la descripción bancaria', () => {
  const score = nameMatchScore('Papelera Sarmiento S.A.', 'TRANSFERENCIA PAGO PAPELERA SARMIENTO 30712345678');
  assert.ok(score >= 0.5, `score fue ${score}`);
  const noise = nameMatchScore('Papelera Sarmiento S.A.', 'DEBITO AUTOMATICO EDESUR');
  assert.ok(noise < 0.5, `score fue ${noise}`);
});
