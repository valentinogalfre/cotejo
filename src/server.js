/**
 * Server HTTP local: UI + API. Todo corre en esta máquina — el server solo
 * escucha en 127.0.0.1 y no hace ni una request saliente.
 */
import express from 'express';
import multer from 'multer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { processInvoiceFile } from './pipeline.js';
import { parseStatementCsv } from './statement.js';
import { reconcile } from './reconcile.js';
import { initQvac, getQvacInfo, shutdownQvac } from './qvac.js';
import { formatMoneyAR } from './util.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT ?? 4877);
const MOCK = process.env.MOCK_LLM === '1';

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// ---- Estado en memoria (sesión de conciliación) -------------------------
const state = {
  facturas: [],          // resultados de pipeline
  movimientos: [],       // extracto normalizado
  extractoNombre: null,
  conciliacion: null,
  procesando: false,
  modelos: { status: MOCK ? 'mock' : 'sin-cargar', progreso: {} },
};
let nextId = 1;
const sseClients = new Set();

function emit(type, data) {
  const payload = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

// ---- Carga de modelos (al boot, con progreso por SSE) --------------------
async function bootModels() {
  if (MOCK) return;
  state.modelos.status = 'cargando';
  try {
    await initQvac({
      onProgress: (etapa, pct) => {
        state.modelos.progreso[etapa] = pct;
        emit('modelos', state.modelos);
      },
    });
    state.modelos.status = 'listo';
  } catch (err) {
    state.modelos.status = 'error';
    state.modelos.error = String(err?.message ?? err);
    console.error('✖ Error cargando modelos QVAC:', err);
  }
  emit('modelos', { ...state.modelos, info: getQvacInfo() });
}

// ---- API ------------------------------------------------------------------
app.get('/api/estado', (req, res) => {
  res.json({
    facturas: state.facturas,
    movimientos: state.movimientos.length,
    extractoNombre: state.extractoNombre,
    conciliacion: state.conciliacion,
    procesando: state.procesando,
    modelos: { ...state.modelos, info: MOCK ? { ready: true, llm: 'MOCK (regex, solo dev)' } : getQvacInfo() },
    mock: MOCK,
  });
});

app.get('/api/eventos', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

app.post('/api/facturas', upload.array('files', 30), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: 'Sin archivos' });
  if (state.procesando) return res.status(409).json({ error: 'Ya hay un lote procesándose' });

  const queue = req.files.map((f) => ({
    id: `fac-${nextId++}`,
    filename: f.originalname,
    buffer: f.buffer,
  }));
  res.json({ encoladas: queue.length });

  state.procesando = true;
  emit('lote', { estado: 'inicio', total: queue.length });
  for (const file of queue) {
    emit('factura', { id: file.id, archivo: file.filename, estado: 'procesando' });
    try {
      const result = await processInvoiceFile(file, (msg) => emit('log', { id: file.id, msg }));
      state.facturas.push(result);
      emit('factura', { ...result, estado: 'lista' });
    } catch (err) {
      const fallo = {
        id: file.id, archivo: file.filename, status: 'error',
        evidence: [`Error de procesamiento: ${err?.message ?? err}`],
        corrections: [], unreadFields: [], timing: {},
      };
      state.facturas.push(fallo);
      emit('factura', { ...fallo, estado: 'error' });
    }
  }
  state.conciliacion = null; // invalida conciliación previa
  state.procesando = false;
  emit('lote', { estado: 'fin' });
});

app.post('/api/extracto', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Sin archivo' });
  const { movimientos, warnings } = parseStatementCsv(req.file.buffer.toString('utf8'));
  if (movimientos.length === 0) {
    return res.status(422).json({ error: 'No pude leer movimientos del CSV', warnings });
  }
  state.movimientos = movimientos;
  state.extractoNombre = req.file.originalname;
  state.conciliacion = null;
  res.json({ movimientos: movimientos.length, warnings });
  emit('extracto', { nombre: req.file.originalname, movimientos: movimientos.length });
});

app.post('/api/conciliar', (req, res) => {
  if (state.facturas.length === 0) return res.status(422).json({ error: 'No hay facturas procesadas' });
  if (state.movimientos.length === 0) return res.status(422).json({ error: 'Falta el extracto bancario' });
  const facturasOk = state.facturas.filter((f) => f.status !== 'error');
  state.conciliacion = reconcile(facturasOk, state.movimientos);
  res.json(state.conciliacion);
  emit('conciliacion', state.conciliacion.resumen);
});

app.post('/api/reset', (req, res) => {
  state.facturas = [];
  state.movimientos = [];
  state.extractoNombre = null;
  state.conciliacion = null;
  res.json({ ok: true });
  emit('reset', {});
});

app.get('/api/export.csv', (req, res) => {
  if (!state.conciliacion) return res.status(422).send('Primero ejecutá la conciliación');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', 'attachment; filename="conciliacion.csv"');
  res.send(exportCsv(state.conciliacion));
});

function exportCsv(c) {
  // Anti CSV-injection: un valor que empieza con = + - @ (p.ej. un "emisor"
  // leído por OCR de una factura maliciosa) se ejecutaría como fórmula al
  // abrir el reporte en Excel/Sheets. Se neutraliza con apóstrofo.
  const esc = (v) => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return `"${s.replace(/"/g, '""')}"`;
  };
  const rows = [
    ['resultado', 'archivo', 'emisor', 'cuit', 'fecha', 'comprobante', 'total', 'verificacion_qr', 'correcciones', 'explicacion'].join(';'),
  ];
  for (const r of c.facturas) {
    const inv = r.factura;
    rows.push([
      esc(r.tipo), esc(inv.archivo), esc(inv.emisor), esc(inv.cuit), esc(inv.fecha),
      esc(inv.ptoVta != null ? `${inv.tipoCmpNombre ?? ''} ${String(inv.ptoVta).padStart(4, '0')}-${String(inv.nroCmp ?? 0).padStart(8, '0')}` : ''),
      esc(inv.total != null ? formatMoneyAR(inv.total) : ''),
      esc(inv.status),
      esc((inv.corrections ?? []).map((x) => `${x.label}: ${x.extracted}→${x.qr}`).join(' | ')),
      esc(r.explicacion ?? ''),
    ].join(';'));
  }
  for (const m of c.sinFactura) {
    rows.push([esc('sin_factura'), '', '', '', esc(m.movimiento.fecha), '', esc(formatMoneyAR(Math.abs(m.movimiento.importe))), '', '', esc(m.explicacion)].join(';'));
  }
  return '\ufeff' + rows.join('\r\n'); // BOM para que Excel abra UTF-8 bien
}

app.use(express.static(path.join(__dirname, '..', 'public')));

const server = app.listen(PORT, '127.0.0.1', () => {
  console.log(`▸ Cotejo corriendo en http://127.0.0.1:${PORT} ${MOCK ? '(MOCK_LLM: sin modelos reales)' : ''}`);
  bootModels();
});

process.on('SIGINT', async () => {
  console.log('\n▸ Cerrando…');
  server.close();
  if (!MOCK) await shutdownQvac();
  process.exit(0);
});
