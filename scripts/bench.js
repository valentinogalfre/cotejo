/**
 * Evidencia, no vibes: corre el pipeline completo N veces sobre samples/
 * (inputs fijos, no elegidos a dedo) y compara contra ground-truth.json.
 * Reporta tasa de acierto por campo, correcciones del QR y latencias.
 *
 *   node scripts/bench.js            → 3 corridas con el LLM real
 *   RUNS=5 node scripts/bench.js
 */
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { processInvoiceFile } from '../src/pipeline.js';
import { initQvac, shutdownQvac, getQvacInfo } from '../src/qvac.js';
import { sameAmount } from '../src/util.js';

const RUNS = Number(process.env.RUNS ?? 3);
const SAMPLES = path.resolve('samples');
const MOCK = process.env.MOCK_LLM === '1';

const gt = JSON.parse(await readFile(path.join(SAMPLES, 'ground-truth.json'), 'utf8'));
const files = (await readdir(SAMPLES)).filter((f) => /\.(png|jpe?g|pdf)$/i.test(f));

if (!MOCK) {
  console.log('▸ Cargando modelos QVAC…');
  await initQvac({ onProgress: () => {} });
  console.log('▸', JSON.stringify(getQvacInfo().llm));
}

const FIELDS = ['cuit', 'fecha', 'total', 'ptoVta', 'nroCmp', 'tipoCmp'];
const tally = Object.fromEntries(FIELDS.map((f) => [f, { ok: 0, total: 0 }]));
let corrections = 0;
let qrFound = 0;
let qrExpected = 0;
const latencies = [];

for (let run = 1; run <= RUNS; run++) {
  console.log(`\n▸ Corrida ${run}/${RUNS}`);
  for (const file of files) {
    const expected = gt[file];
    if (!expected) continue;
    const buffer = await readFile(path.join(SAMPLES, file));
    const t0 = performance.now();
    const r = await processInvoiceFile({ id: file, filename: file, buffer });
    const ms = Math.round(performance.now() - t0);
    latencies.push(ms);

    if (expected.tieneQr) { qrExpected++; if (r.qr) qrFound++; }
    corrections += r.corrections.length;

    const errs = [];
    for (const f of FIELDS) {
      if (expected[f] == null) continue;
      tally[f].total++;
      const got = r[f];
      const ok = f === 'total' ? sameAmount(got, expected[f]) : String(got) === String(expected[f]);
      if (ok) tally[f].ok++;
      else errs.push(`${f}: esperado ${expected[f]}, obtuvo ${got}`);
    }
    const desglose = `ocr ${r.timing.ocrMs ?? '—'}ms · llm ${r.timing.llmMs ?? '—'}ms` +
      (r.timing.tokensPerSecond ? ` · ${r.timing.tokensPerSecond.toFixed(1)} tok/s` : '');
    console.log(`  ${errs.length === 0 ? '✓' : '✖'} ${file} [${r.status}] ${ms}ms (${desglose})${errs.length ? ' — ' + errs.join('; ') : ''}${r.corrections.length ? ` — ${r.corrections.length} corrección(es) del QR` : ''}`);
  }
}

console.log('\n▸ ================= RESULTADOS =================');
console.log(`Modo: ${MOCK ? 'MOCK (regex, sin LLM — solo mide QR y pipeline)' : getQvacInfo().llm}`);
console.log(`Corridas: ${RUNS} × ${files.length} archivos`);
for (const f of FIELDS) {
  const t = tally[f];
  if (t.total) console.log(`  ${f.padEnd(8)} ${t.ok}/${t.total} (${((t.ok / t.total) * 100).toFixed(1)}%)`);
}
console.log(`  QR fiscal decodificado: ${qrFound}/${qrExpected}`);
console.log(`  Correcciones aplicadas por el QR: ${corrections}`);
latencies.sort((a, b) => a - b);
const p = (q) => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * q))];
console.log(`  Latencia por factura: p50 ${p(0.5)}ms · p90 ${p(0.9)}ms · max ${latencies.at(-1)}ms`);

if (!MOCK) await shutdownQvac();
process.exit(0);
