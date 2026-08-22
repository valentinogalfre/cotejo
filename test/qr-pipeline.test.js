import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { scanQr } from '../src/qr-scan.js';
import { parseAfipQr } from '../src/afip-qr.js';
import { renderPdf } from '../src/pdf.js';

// Integración real (sin IA): jsQR + sharp + pdfjs sobre los samples generados.
// Requiere `npm run make-test-data` previo; si no están, se salta.
const SAMPLES = path.resolve('samples');
const hasSamples = existsSync(path.join(SAMPLES, 'ground-truth.json'));

test('contrato: el QR fiscal se decodifica en todas las variantes (limpia, foto torcida, ticket borroso)', { skip: !hasSamples }, async () => {
  const gt = JSON.parse(await readFile(path.join(SAMPLES, 'ground-truth.json'), 'utf8'));
  for (const [file, expected] of Object.entries(gt)) {
    if (!file.endsWith('.png')) continue;
    const buf = await readFile(path.join(SAMPLES, file));
    const found = await scanQr(buf);
    if (!expected.tieneQr) {
      assert.equal(Boolean(found && parseAfipQr(found.text).ok), false, `${file} no debería tener QR fiscal`);
      continue;
    }
    assert.ok(found, `${file}: el QR debería decodificarse`);
    const parsed = parseAfipQr(found.text);
    assert.equal(parsed.ok, true, `${file}: QR ilegible`);
    assert.equal(parsed.data.importe, expected.total, `${file}: importe del QR`);
    assert.equal(parsed.data.cuit, expected.cuit, `${file}: CUIT del QR`);
  }
});

test('contrato: un PDF escaneado (sin capa de texto) rinde su QR vía render a PNG', { skip: !hasSamples }, async () => {
  const buf = await readFile(path.join(SAMPLES, '08-papelera.pdf'));
  const { pages } = await renderPdf(buf);
  assert.ok(pages.length >= 1);
  const found = await scanQr(pages[0].png);
  assert.ok(found, 'QR no encontrado en el render del PDF');
  const parsed = parseAfipQr(found.text);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.data.importe, 181000);
});
