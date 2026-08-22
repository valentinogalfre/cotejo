/**
 * ÚNICO punto de integración con @qvac/sdk — toda la inferencia del proyecto
 * pasa por acá. 100% local: sin cloud, sin API keys.
 *
 * Dos modelos:
 *  - OCR (OCR_LATIN, ONNX det+rec): lee el texto crudo de la factura.
 *  - LLM (Qwen3 4B/1.7B Q4, llama.cpp): estructura ese texto en JSON con
 *    salida forzada por json_schema (gramática, no vibes).
 *
 * La verificación contra el QR fiscal ocurre FUERA de este módulo
 * (src/crosscheck.js) porque es determinística: acá solo vive la IA.
 */
import {
  loadModel,
  unloadModel,
  completion,
  ocr,
  downloadAsset,
  close,
  QWEN3_4B_INST_Q4_K_M,
  QWEN3_1_7B_INST_Q4,
  OCR_LATIN,
} from '@qvac/sdk';

const LLM_CHOICES = {
  '4b': QWEN3_4B_INST_Q4_K_M,
  '1.7b': QWEN3_1_7B_INST_Q4,
};

const state = {
  llmId: null,
  ocrId: null,
  llmName: null,
  loading: null,
  lastStats: null,
};

export function llmChoice() {
  const key = (process.env.QVAC_LLM ?? '4b').toLowerCase();
  return { key, modelSrc: LLM_CHOICES[key] ?? QWEN3_4B_INST_Q4_K_M };
}

/**
 * Carga OCR + LLM (idempotente). `onProgress(etapa, pct)` reporta descarga
 * del modelo la primera vez; después es carga a memoria directa.
 */
export async function initQvac({ onProgress = () => {} } = {}) {
  if (state.llmId && state.ocrId) return getQvacInfo();
  state.loading ??= (async () => {
    const { key, modelSrc } = llmChoice();

    onProgress('ocr', 0);
    state.ocrId = await loadModel({
      modelSrc: OCR_LATIN,
      modelConfig: {
        langList: ['es', 'en'],
        // La imagen ya llega pre-escalada a 1200 px (src/pipeline.js), no
        // hace falta que el OCR la vuelva a agrandar.
        magRatio: 1.0,
        // Sin escalera de rotaciones ni reintento de contraste: las facturas
        // llegan derechas (sharp ya respeta el EXIF) y cada rotación extra
        // multiplicaba el costo del OCR. El dato duro viene del QR igual.
        defaultRotationAngles: [],
        contrastRetry: false,
        lowConfidenceThreshold: 0.4,
        recognizerBatchSize: 8,
      },
      onProgress: (p) => onProgress('ocr', p.percentage),
    });
    onProgress('ocr', 100);

    onProgress('llm', 0);
    state.llmId = await loadModel({
      modelSrc,
      modelType: 'llm',
      modelConfig: { ctx_size: 8192 },
      onProgress: (p) => onProgress('llm', p.percentage),
    });
    state.llmName = `Qwen3 ${key.toUpperCase()} (Q4, llama.cpp local)`;
    onProgress('llm', 100);
    return getQvacInfo();
  })();
  try {
    return await state.loading;
  } catch (err) {
    state.loading = null; // permitir reintento
    throw err;
  }
}

/**
 * OCR de una imagen de factura. Acepta path o Buffer.
 * Devuelve { text, blocks, lowConfidence } — los bloques con confianza baja
 * quedan marcados: alimentan la categoría "no pude leer" (honestidad > vibes).
 */
export async function runOcr(image) {
  if (!state.ocrId) throw new Error('QVAC no inicializado: llamá a initQvac() primero');
  const t0 = performance.now();
  const { blocks } = ocr({ modelId: state.ocrId, image, options: { paragraph: false } });
  const result = await blocks;
  const lowConfidence = [];
  const lines = [];
  for (const block of result) {
    const conf = block.confidence;
    if (conf !== undefined && conf < 0.4) {
      lowConfidence.push({ text: block.text, confidence: conf });
      lines.push(`${block.text} ⟨dudoso:${conf.toFixed(2)}⟩`);
    } else {
      lines.push(block.text);
    }
  }
  return {
    text: lines.join('\n'),
    blocks: result,
    lowConfidence,
    ms: Math.round(performance.now() - t0),
  };
}

/**
 * Completion con salida estructurada forzada por JSON Schema (gramática de
 * llama.cpp vía responseFormat json_schema). temp 0 + seed fija =
 * reproducible. Devuelve { json, raw, stats }.
 */
export async function completeJson({ system, user, schema, schemaName = 'salida', maxTokens = 1200 }) {
  if (!state.llmId) throw new Error('QVAC no inicializado: llamá a initQvac() primero');
  const t0 = performance.now();
  const run = completion({
    modelId: state.llmId,
    history: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    stream: true,
    responseFormat: {
      type: 'json_schema',
      json_schema: { name: schemaName, schema, strict: true },
    },
    generationParams: { temp: 0, seed: 7, predict: maxTokens },
  });
  const final = await run.final;
  const raw = final.contentText ?? '';
  const stats = {
    ms: Math.round(performance.now() - t0),
    tokensPerSecond: final.stats?.tokensPerSecond ?? null,
    stopReason: final.stopReason ?? null,
  };
  state.lastStats = stats;
  let json = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // El caller decide reintentar; nunca inventamos datos acá.
  }
  return { json, raw, stats };
}

export function getQvacInfo() {
  return {
    ready: Boolean(state.llmId && state.ocrId),
    llm: state.llmName,
    ocr: state.ocrId ? 'OCR_LATIN (ONNX det+rec, es/en)' : null,
    lastStats: state.lastStats,
  };
}

/** Pre-descarga los modelos sin cargarlos (para dejar todo offline-ready). */
export async function prefetchModels(onProgress = () => {}) {
  const { modelSrc } = llmChoice();
  for (const [name, src] of [['OCR_LATIN', OCR_LATIN], ['LLM', modelSrc]]) {
    await downloadAsset({
      assetSrc: src,
      onProgress: (p) => onProgress(name, p.percentage, p.downloaded, p.total),
    });
  }
}

export async function shutdownQvac() {
  if (state.llmId) await unloadModel({ modelId: state.llmId, clearStorage: false }).catch(() => {});
  if (state.ocrId) await unloadModel({ modelId: state.ocrId, clearStorage: false }).catch(() => {});
  state.llmId = state.ocrId = state.loading = null;
  await close().catch(() => {});
}
