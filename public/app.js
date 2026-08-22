/* Cotejo — front vanilla, sin build, sin dependencias.
   Regla de sincronización: /api/estado es la verdad y se puede reconstruir
   TODO desde ahí (resync). El SSE solo agrega en vivo; si se corta y vuelve,
   resync() repone lo perdido. */
const $ = (id) => document.getElementById(id);
const state = { facturas: new Map(), extracto: false, conciliacion: null };

const SELLO_VERIF = {
  verified: ['verificada', '✓ QR verificado'],
  corrected: ['corregida', '✍ corregida por QR'],
  no_qr: ['sinqr', 'sin QR — no verificada'],
  qr_only: ['qr-solo', 'solo QR (modelo no leyó)'],
  unreadable: ['ilegible', 'ilegible'],
  error: ['error', 'error'],
};
const SELLO_CONC = {
  conciliada: ['conc-ok', '✓ conciliada'],
  monto_difiere: ['conc-warn', '≠ monto difiere'],
  duplicada: ['conc-dup', '⧉ duplicada'],
  sin_match: ['conc-bad', '∅ sin match'],
};

const fmtAR = (n) => n == null ? '—' :
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS' }).format(n);
const fmtFecha = (iso) => iso ? iso.split('-').reverse().join('/') : '—';

// ---------- toasts (nada de alert(): no bloquean y se ven bien en cámara) --
let toastTimer = null;
function toast(msg, kind = 'error') {
  const el = $('toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
}

async function api(path, opts, okMsg) {
  let r;
  try {
    r = await fetch(path, opts);
  } catch {
    toast('No pude hablar con el server local — ¿está corriendo npm start?');
    return null;
  }
  let data = null;
  try { data = await r.json(); } catch { /* respuestas no-JSON */ }
  if (!r.ok) {
    toast(data?.error ?? `Error ${r.status}`);
    return null;
  }
  if (okMsg) toast(okMsg, 'ok');
  return data ?? {};
}

// ---------- sincronización ----------
async function resync() {
  const r = await api('/api/estado');
  if (!r) return;
  if (r.mock) $('mockbanner').hidden = false;
  pintarModelos(r.modelos);
  state.facturas = new Map(r.facturas.map((f) => [f.id, f]));
  state.extracto = Boolean(r.extractoNombre);
  $('extracto-info').textContent = r.extractoNombre
    ? `${r.extractoNombre} · ${r.movimientos} movimientos`
    : 'todavía sin cargar';
  state.conciliacion = r.conciliacion;
  $('live-dot').hidden = !r.procesando;
  rebuildTape();
  render();
}

function rebuildTape() {
  const tape = $('tape');
  tape.innerHTML = '<p class="tape-empty">Cada decisión del agente queda asentada acá, línea por línea.</p>';
  for (const f of state.facturas.values()) {
    for (const msg of f.evidence ?? []) appendTape(f.id, msg);
  }
}

// ---------- arranque + SSE ----------
init();
function init() {
  const es = new EventSource('/api/eventos');
  // Corre en el open inicial y en cada reconexión: repone lo que el SSE
  // haya perdido en el medio.
  es.onopen = () => { resync(); };
  es.addEventListener('modelos', (e) => pintarModelos(JSON.parse(e.data)));
  es.addEventListener('factura', (e) => {
    const f = JSON.parse(e.data);
    state.facturas.set(f.id, { ...(state.facturas.get(f.id) ?? {}), ...f });
    render();
  });
  es.addEventListener('log', (e) => {
    const { id, msg } = JSON.parse(e.data);
    appendTape(id, msg);
  });
  es.addEventListener('lote', (e) => {
    const { estado } = JSON.parse(e.data);
    $('live-dot').hidden = estado !== 'inicio';
    if (estado === 'fin') { state.conciliacion = null; render(); }
  });
  es.addEventListener('extracto', (e) => {
    const d = JSON.parse(e.data);
    state.extracto = true;
    $('extracto-info').textContent = `${d.nombre} · ${d.movimientos} movimientos`;
    render();
  });
  es.addEventListener('conciliacion', () => resync());
  es.addEventListener('reset', () => {
    state.facturas = new Map();
    state.extracto = false;
    state.conciliacion = null;
    $('extracto-info').textContent = 'todavía sin cargar';
    $('metrics').textContent = '';
    rebuildTape();
    render();
  });
}

function pintarModelos(m) {
  const el = $('stamp-modelo');
  const st = $('modelo-status');
  const det = $('modelo-detalle');
  el.classList.remove('listo', 'error');
  if (m.status === 'listo' || m.status === 'mock') {
    el.classList.add('listo');
    st.textContent = m.status === 'mock' ? 'modo mock' : 'modelos listos';
    det.textContent = m.info?.llm ?? 'QVAC SDK';
  } else if (m.status === 'error') {
    el.classList.add('error');
    st.textContent = 'error de modelos';
    det.textContent = m.error?.slice(0, 60) ?? '';
  } else {
    const p = m.progreso ?? {};
    const partes = Object.entries(p).map(([k, v]) => `${k} ${Math.round(v)}%`);
    st.textContent = 'cargando modelos…';
    det.textContent = partes.join(' · ') || 'QVAC SDK';
  }
}

// ---------- acciones ----------
wireDropzone('dz-facturas', 'input-facturas', (files) => subirFacturas(files));
wireDropzone('dz-extracto', 'input-extracto', (files) => subirExtracto(files[0]));

function wireDropzone(zoneId, inputId, handler) {
  const zone = $(zoneId);
  const input = $(inputId);
  input.addEventListener('change', () => { if (input.files.length) handler([...input.files]); input.value = ''; });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('arrastrando'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('arrastrando'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('arrastrando');
    if (e.dataTransfer.files.length) handler([...e.dataTransfer.files]);
  });
}

async function subirFacturas(files) {
  const fd = new FormData();
  for (const f of files) fd.append('files', f);
  await api('/api/facturas', { method: 'POST', body: fd });
}

async function subirExtracto(file) {
  const fd = new FormData();
  fd.append('file', file);
  await api('/api/extracto', { method: 'POST', body: fd });
}

$('btn-conciliar').addEventListener('click', async () => {
  const d = await api('/api/conciliar', { method: 'POST' });
  if (!d) return;
  state.conciliacion = d;
  render();
});

$('btn-reset').addEventListener('click', async () => {
  await api('/api/reset', { method: 'POST' }, 'Sesión reiniciada');
});

// ---------- render ----------
function render() {
  const facturas = [...state.facturas.values()];

  const ul = $('lista-facturas');
  ul.innerHTML = '';
  for (const f of facturas) {
    const li = document.createElement('li');
    const estado = f.estado === 'procesando' ? ['proc', '⏳ procesando'] :
      f.status === 'error' ? ['err', '✖ error'] : ['ok', tiempoDe(f)];
    li.innerHTML = `<span>${esc(f.archivo)}</span><span class="st ${estado[0]}">${estado[1]}</span>`;
    ul.appendChild(li);
  }

  const listas = facturas.filter((f) => f.estado !== 'procesando');
  $('panel-facturas').hidden = listas.length === 0;
  $('count-facturas').textContent = listas.length ? `(${listas.length})` : '';
  const tb = document.querySelector('#tabla-facturas tbody');
  tb.innerHTML = '';
  const concPorId = mapaConciliacion();
  for (const f of listas) {
    const tr = document.createElement('tr');
    const [vc, vt] = SELLO_VERIF[f.status] ?? ['sinqr', f.status];
    const conc = concPorId.get(f.id);
    const corrTotal = (f.corrections ?? []).find((c) => c.field === 'total');
    const totalHtml = corrTotal
      ? `<span class="tachado">${fmtAR(corrTotal.extracted)}</span><span class="corregido">${fmtAR(f.total)}</span>`
      : esc(fmtAR(f.total));
    const comp = f.ptoVta != null
      ? `${esc(f.tipoCmpNombre ?? '')} ${String(f.ptoVta).padStart(4, '0')}-${String(f.nroCmp ?? 0).padStart(8, '0')}`
      : '—';
    tr.innerHTML = `
      <td><span class="file">${esc(f.archivo)}</span>${f.unreadFields?.length ? `<span class="sub">ilegible: ${esc(f.unreadFields.join(', '))}</span>` : ''}</td>
      <td>${esc(f.emisor ?? '—')}${f.cuit ? `<span class="sub">CUIT ${esc(f.cuit)}</span>` : ''}</td>
      <td>${comp}${f.cae ? `<span class="sub">CAE ${esc(f.cae)}</span>` : ''}</td>
      <td>${fmtFecha(f.fecha)}</td>
      <td class="num">${totalHtml}</td>
      <td><span class="sello ${vc}">${vt}</span>${otrasCorrecciones(f)}</td>
      <td>${conc ? `<span class="sello ${SELLO_CONC[conc.tipo]?.[0] ?? ''}">${SELLO_CONC[conc.tipo]?.[1] ?? conc.tipo}</span>` : '<span class="sub">pendiente</span>'}</td>`;
    tb.appendChild(tr);
  }

  const c = state.conciliacion;
  $('resumen').hidden = !c;
  $('btn-export').hidden = !c;
  if (c) {
    $('r-conciliadas').textContent = c.resumen.conciliadas;
    $('r-difieren').textContent = c.resumen.montoDifiere;
    $('r-duplicadas').textContent = c.resumen.duplicadas;
    $('r-sinmatch').textContent = c.resumen.sinMatch;
    $('r-sinfactura').textContent = c.resumen.movimientosSinFactura;
    pintarAlertas(c);
  } else {
    $('alertas').innerHTML = '<li class="tape-empty">Sin pendientes por ahora.</li>';
  }

  $('btn-conciliar').disabled = !(listas.length > 0 && state.extracto);

  const conTiempo = listas.filter((f) => f.timing?.totalMs);
  if (conTiempo.length) {
    const prom = Math.round(conTiempo.reduce((a, f) => a + f.timing.totalMs, 0) / conTiempo.length);
    const tps = conTiempo.map((f) => f.timing.tokensPerSecond).filter(Boolean);
    $('metrics').textContent =
      `${conTiempo.length} facturas · ${prom} ms promedio por factura` +
      (tps.length ? ` · ${Math.round(tps.reduce((a, b) => a + b, 0) / tps.length)} tok/s del LLM local` : '');
  }
}

function otrasCorrecciones(f) {
  const otras = (f.corrections ?? []).filter((c) => c.field !== 'total');
  if (!otras.length) return '';
  return `<span class="sub">${otras.map((c) => `${esc(c.label)}: <s>${esc(String(c.extracted))}</s>→${esc(String(c.qr))}`).join(' · ')}</span>`;
}

function mapaConciliacion() {
  const m = new Map();
  if (state.conciliacion) {
    for (const r of state.conciliacion.facturas) m.set(r.factura.id, r);
  }
  return m;
}

function pintarAlertas(c) {
  const ul = $('alertas');
  ul.innerHTML = '';
  const items = [
    ...c.facturas.filter((r) => r.tipo !== 'conciliada').map((r) => ({
      titulo: `${r.tipo.replace('_', ' ').toUpperCase()} — ${r.factura.archivo}`,
      detalle: r.explicacion,
    })),
    ...c.sinFactura.map((m) => ({ titulo: 'DÉBITO SIN FACTURA', detalle: m.explicacion })),
  ];
  if (!items.length) {
    ul.innerHTML = '<li class="tape-empty">Todo conciliado. Nada para revisar.</li>';
    return;
  }
  for (const it of items) {
    const li = document.createElement('li');
    li.innerHTML = `<b>${esc(it.titulo)}</b><br>${esc(it.detalle ?? '')}`;
    ul.appendChild(li);
  }
}

function appendTape(id, msg) {
  const tape = $('tape');
  tape.querySelector('.tape-empty')?.remove();
  const p = document.createElement('p');
  const cls = msg.startsWith('⚠') ? 't-corr' : msg.startsWith('✓') ? 't-ok' : '';
  p.innerHTML = `<span class="t-id">[${esc(id)}]</span> <span class="${cls}">${esc(msg)}</span>`;
  tape.appendChild(p);
  tape.scrollTop = tape.scrollHeight;
}

function tiempoDe(f) {
  return f.timing?.totalMs ? `✓ ${(f.timing.totalMs / 1000).toFixed(1)}s` : '✓ lista';
}

function esc(s) {
  const d = document.createElement('span');
  d.textContent = String(s ?? '');
  return d.innerHTML;
}
