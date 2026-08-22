/* Cotejo — front vanilla, sin build, sin dependencias. */
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

// ---------- carga inicial + SSE ----------
init();
async function init() {
  const r = await fetch('/api/estado').then((x) => x.json());
  if (r.mock) $('mockbanner').hidden = false;
  pintarModelos(r.modelos);
  for (const f of r.facturas) {
    state.facturas.set(f.id, f);
    for (const msg of f.evidence ?? []) appendTape(f.id, msg); // replay al recargar
  }
  if (r.extractoNombre) {
    state.extracto = true;
    $('extracto-info').textContent = `${r.extractoNombre} · ${r.movimientos} movimientos`;
  }
  state.conciliacion = r.conciliacion;
  render();

  const es = new EventSource('/api/eventos');
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
  es.addEventListener('conciliacion', () => refrescarConciliacion());
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

// ---------- uploads ----------
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
  const r = await fetch('/api/facturas', { method: 'POST', body: fd });
  if (!r.ok) alert((await r.json()).error ?? 'Error subiendo facturas');
}

async function subirExtracto(file) {
  const fd = new FormData();
  fd.append('file', file);
  const r = await fetch('/api/extracto', { method: 'POST', body: fd });
  const d = await r.json();
  if (!r.ok) { alert(d.error ?? 'Error con el CSV'); return; }
}

$('btn-conciliar').addEventListener('click', async () => {
  const r = await fetch('/api/conciliar', { method: 'POST' });
  const d = await r.json();
  if (!r.ok) { alert(d.error); return; }
  state.conciliacion = d;
  render();
});

async function refrescarConciliacion() {
  const r = await fetch('/api/estado').then((x) => x.json());
  state.conciliacion = r.conciliacion;
  render();
}

// ---------- render ----------
function render() {
  const facturas = [...state.facturas.values()];

  // lista breve del paso 1
  const ul = $('lista-facturas');
  ul.innerHTML = '';
  for (const f of facturas) {
    const li = document.createElement('li');
    const estado = f.estado === 'procesando' ? ['proc', '⏳ procesando'] :
      f.status === 'error' ? ['err', '✖ error'] : ['ok', tiempoDe(f)];
    li.innerHTML = `<span>${esc(f.archivo)}</span><span class="st ${estado[0]}">${estado[1]}</span>`;
    ul.appendChild(li);
  }

  // tabla principal
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

  // resumen + alertas
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
  }

  // botón conciliar
  $('btn-conciliar').disabled = !(listas.length > 0 && state.extracto);

  // métricas del pie
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
