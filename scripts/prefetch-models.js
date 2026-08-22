/**
 * Pre-descarga los modelos QVAC (OCR + LLM) sin cargarlos a memoria.
 * Correr una vez con internet; después todo funciona 100% offline.
 *   node scripts/prefetch-models.js          → Qwen3 4B (default)
 *   QVAC_LLM=1.7b node scripts/prefetch-models.js
 */
import { prefetchModels, llmChoice } from '../src/qvac.js';
import { close } from '@qvac/sdk';

console.log(`▸ Pre-descargando modelos (LLM elegido: ${llmChoice().key})…`);
const started = {};
try {
  await prefetchModels((name, pct, downloaded, total) => {
    if (!started[name]) { started[name] = true; console.log(`\n▸ ${name}`); }
    const mb = (n) => (n / 1e6).toFixed(0);
    const line = `  ${pct.toFixed(0)}% (${mb(downloaded)}/${mb(total)} MB)`;
    process.stdout.write(process.stdout.isTTY ? `\r${line}` : `${line}\n`);
  });
  console.log('\n▸ Modelos listos en cache local. Ya se puede correr offline.');
  await close();
  process.exit(0);
} catch (err) {
  console.error('\n✖', err);
  await close().catch(() => {});
  process.exit(1);
}
