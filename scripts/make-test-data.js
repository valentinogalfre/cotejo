/**
 * Genera el lote de prueba en samples/: facturas argentinas sintéticas con
 * QR fiscal REAL (formato RG 4892/2020, decodificable), en variantes limpias
 * y sucias (foto torcida, ticket borroso), + extracto bancario CSV + ground
 * truth para medir tasa de éxito con scripts/bench.js.
 *
 * Los CUITs son sintéticos pero pasan el dígito verificador módulo 11.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import QRCode from 'qrcode';
import { PDFDocument } from 'pdf-lib';
import { buildAfipQrUrl } from '../src/afip-qr.js';

const OUT = path.resolve('samples');

/** Completa el dígito verificador módulo 11 de un CUIT de 10 dígitos. */
function cuitFrom(tenDigits) {
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
  let sum = 0;
  for (let i = 0; i < 10; i++) sum += Number(tenDigits[i]) * weights[i];
  let check = 11 - (sum % 11);
  if (check === 11) check = 0;
  if (check === 10) check = 9;
  return tenDigits + String(check);
}

const FACTURAS = [
  {
    file: '01-papelera-limpia.png', estilo: 'limpia',
    emisor: 'Papelera Sarmiento S.A.', cuit: cuitFrom('3071234567'),
    fecha: '2026-08-18', tipoCmp: 6, letra: 'B', ptoVta: 3, nroCmp: 8114,
    items: [['Resmas A4 75g x10', 96800.0], ['Cuadernos tapa dura x24', 60200.0], ['Envío CABA', 24000.0]],
    total: 181000.0, cae: '76321498765432',
  },
  {
    file: '02-ferreteria-limpia.png', estilo: 'limpia',
    emisor: 'Ferretería El Tornillo S.R.L.', cuit: cuitFrom('3055887766'),
    fecha: '2026-08-19', tipoCmp: 6, letra: 'B', ptoVta: 12, nroCmp: 45023,
    items: [['Taladro percutor 850W', 189990.0], ['Mechas SDS x5', 32010.0]],
    total: 222000.0, cae: '76321512340987',
  },
  {
    file: '03-estudio-limpia.png', estilo: 'limpia',
    emisor: 'Estudio Contable Rivas y Asoc.', cuit: cuitFrom('2733445566'),
    fecha: '2026-08-20', tipoCmp: 11, letra: 'C', ptoVta: 1, nroCmp: 992,
    items: [['Honorarios liquidación agosto', 350000.0]],
    total: 350000.0, cae: '76321599871234',
  },
  {
    file: '04-mayorista-foto.png', estilo: 'foto',
    emisor: 'Distribuidora Mayorista Belgrano S.A.', cuit: cuitFrom('3060778899'),
    fecha: '2026-08-19', tipoCmp: 1, letra: 'A', ptoVta: 7, nroCmp: 120455,
    items: [['Café tostado x 12kg', 415702.48], ['IVA 21%', 87297.52]],
    total: 503000.0, cae: '76321577001122',
  },
  {
    file: '05-ticket-borroso.png', estilo: 'ticket',
    emisor: 'Kiosco24 de Marzo', cuit: cuitFrom('2029364233'),
    fecha: '2026-08-21', tipoCmp: 11, letra: 'C', ptoVta: 2, nroCmp: 33871,
    items: [['Artículos varios', 47500.0]],
    total: 47500.0, cae: '76321601239876',
  },
  {
    file: '06-recibo-sin-qr.png', estilo: 'limpia', sinQr: true,
    emisor: 'Flete Don Ramón', cuit: null,
    fecha: '2026-08-20', tipoCmp: null, letra: 'X', ptoVta: null, nroCmp: null,
    items: [['Flete depósito → local', 65000.0]],
    total: 65000.0, cae: null,
  },
];

function invoiceSvg(f, qrDataUri) {
  const W = 1000;
  const rows = f.items
    .map(([desc, imp], i) =>
      `<text x="70" y="${560 + i * 44}" class="cell">${esc(desc)}</text>
       <text x="930" y="${560 + i * 44}" class="cell num">${money(imp)}</text>`)
    .join('\n');
  const nro = f.ptoVta != null
    ? `${String(f.ptoVta).padStart(4, '0')}-${String(f.nroCmp).padStart(8, '0')}`
    : 'S/N';
  const qrBlock = qrDataUri
    ? `<image x="70" y="${640 + f.items.length * 44}" width="170" height="170" xlink:href="${qrDataUri}" href="${qrDataUri}"/>
       <text x="70" y="${835 + f.items.length * 44}" class="fine">CAE N°: ${f.cae}  ·  Vto. CAE: 2026-08-30</text>
       <text x="70" y="${857 + f.items.length * 44}" class="fine">Comprobante Autorizado — ARCA</text>`
    : `<text x="70" y="${700 + f.items.length * 44}" class="fine">Documento no fiscal — recibo interno</text>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${W}" height="1050" viewBox="0 0 ${W} 1050">
  <style>
    .h1 { font: 700 34px Helvetica, Arial, sans-serif; }
    .h2 { font: 600 24px Helvetica, Arial, sans-serif; }
    .cell { font: 400 22px Helvetica, Arial, sans-serif; }
    .num { text-anchor: end; font-variant-numeric: tabular-nums; }
    .lab { font: 600 18px Helvetica, Arial, sans-serif; fill: #444; }
    .fine { font: 400 16px Helvetica, Arial, sans-serif; fill: #333; }
    .total { font: 700 30px Helvetica, Arial, sans-serif; }
  </style>
  <rect width="${W}" height="1050" fill="#ffffff"/>
  <rect x="40" y="40" width="920" height="150" fill="none" stroke="#000" stroke-width="2"/>
  <rect x="455" y="40" width="90" height="90" fill="none" stroke="#000" stroke-width="2"/>
  <text x="500" y="105" class="h1" text-anchor="middle">${f.letra}</text>
  <text x="500" y="122" class="fine" text-anchor="middle">COD. ${f.tipoCmp ?? '—'}</text>
  <text x="70" y="90" class="h2">${esc(f.emisor)}</text>
  ${f.cuit ? `<text x="70" y="125" class="lab">CUIT: ${f.cuit.slice(0, 2)}-${f.cuit.slice(2, 10)}-${f.cuit.slice(10)}</text>` : ''}
  <text x="70" y="155" class="lab">IVA RESPONSABLE INSCRIPTO</text>
  <text x="930" y="90" class="h2" text-anchor="end">FACTURA</text>
  <text x="930" y="125" class="lab" text-anchor="end">N° ${nro}</text>
  <text x="930" y="155" class="lab" text-anchor="end">Fecha: ${fechaAR(f.fecha)}</text>
  <line x1="40" y1="230" x2="960" y2="230" stroke="#000" stroke-width="1.5"/>
  <text x="70" y="280" class="lab">Cliente: Consumidor Final</text>
  <text x="70" y="310" class="lab">Condición de venta: Cuenta Corriente</text>
  <line x1="40" y1="490" x2="960" y2="490" stroke="#000"/>
  <text x="70" y="520" class="lab">DESCRIPCIÓN</text>
  <text x="930" y="520" class="lab num">IMPORTE</text>
  ${rows}
  <line x1="40" y1="${590 + f.items.length * 44}" x2="960" y2="${590 + f.items.length * 44}" stroke="#000"/>
  <text x="620" y="${635 + f.items.length * 44}" class="total">TOTAL</text>
  <text x="930" y="${635 + f.items.length * 44}" class="total num">$ ${money(f.total)}</text>
  ${qrBlock}
</svg>`;
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
function money(n) {
  return n.toLocaleString('es-AR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
function fechaAR(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

async function renderFactura(f) {
  let qrDataUri = null;
  if (!f.sinQr) {
    const url = buildAfipQrUrl({
      fecha: f.fecha, cuit: f.cuit, ptoVta: f.ptoVta, tipoCmp: f.tipoCmp,
      nroCmp: f.nroCmp, importe: f.total, codAut: f.cae,
    });
    qrDataUri = await QRCode.toDataURL(url, { errorCorrectionLevel: 'M', margin: 2, width: 340 });
  }
  const svg = invoiceSvg(f, qrDataUri);
  let img = sharp(Buffer.from(svg), { density: 144 }).flatten({ background: '#ffffff' });

  if (f.estilo === 'foto') {
    // Foto con celular: torcida, con sombra y algo de ruido.
    img = sharp(await img.png().toBuffer())
      .rotate(3.5, { background: '#b9b2a6' })
      .modulate({ brightness: 0.82, saturation: 0.9 })
      .blur(0.9)
      .resize({ width: 1150 });
  } else if (f.estilo === 'ticket') {
    // Ticket térmico: texto lavado y borroso, pero el QR se imprime nítido
    // (así son los tickets reales: la tinta térmica degrada texto fino antes
    // que un QR con corrección de errores).
    const washed = await sharp(await img.png().toBuffer())
      .modulate({ brightness: 1.12, saturation: 0.4 })
      .blur(1.6)
      .gamma(1.25)
      .png()
      .toBuffer();
    let composed = sharp(washed);
    if (qrDataUri) {
      // El SVG se rasteriza a density 144 (~2x): escalar coordenadas del QR.
      const { width } = await sharp(washed).metadata();
      const k = width / 1000;
      const qrPng = Buffer.from(qrDataUri.split(',')[1], 'base64');
      const qrCrisp = await sharp(qrPng).resize(Math.round(170 * k), Math.round(170 * k)).png().toBuffer();
      composed = composed.composite([{ input: qrCrisp, left: Math.round(70 * k), top: Math.round((640 + f.items.length * 44) * k) }]);
    }
    img = sharp(await composed.png().toBuffer()).resize({ width: 620 });
  }
  return img.png().toBuffer();
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const groundTruth = {};

  for (const f of FACTURAS) {
    const png = await renderFactura(f);
    await writeFile(path.join(OUT, f.file), png);
    groundTruth[f.file] = {
      cuit: f.cuit, fecha: f.fecha, tipoCmp: f.tipoCmp, ptoVta: f.ptoVta,
      nroCmp: f.nroCmp, total: f.total, tieneQr: !f.sinQr,
    };
    console.log('▸', f.file);
  }

  // Duplicado exacto de la 02 con otro nombre (para el flag de duplicada).
  const dup = await renderFactura(FACTURAS[1]);
  await writeFile(path.join(OUT, '07-ferreteria-duplicada.png'), dup);
  groundTruth['07-ferreteria-duplicada.png'] = { ...groundTruth['02-ferreteria-limpia.png'], duplicadaDe: '02-ferreteria-limpia.png' };
  console.log('▸ 07-ferreteria-duplicada.png');

  // Una versión PDF (imagen embebida, sin capa de texto → ejercita OCR).
  const pdf = await PDFDocument.create();
  const pngImage = await pdf.embedPng(await renderFactura(FACTURAS[0]));
  const page = pdf.addPage([pngImage.width / 2, pngImage.height / 2]);
  page.drawImage(pngImage, { x: 0, y: 0, width: page.getWidth(), height: page.getHeight() });
  await writeFile(path.join(OUT, '08-papelera.pdf'), Buffer.from(await pdf.save()));
  groundTruth['08-papelera.pdf'] = { ...groundTruth['01-papelera-limpia.png'], duplicadaDe: '01-papelera-limpia.png' };
  console.log('▸ 08-papelera.pdf');

  // Extracto bancario: 01 y 03 matchean exacto; 02 con monto distinto
  // (retención mal aplicada); 04 no aparece (sin_match); débito de Edesur
  // sin factura (sin_factura); 05 matchea exacto.
  const extracto = [
    'Fecha;Concepto;Débito;Crédito;Saldo',
    `18/08/2026;TRANSF PAPELERA SARMIENTO SA ${FACTURAS[0].cuit};181.000,00;;3.819.000,00`,
    `19/08/2026;PAGO PROVEEDOR FERRETERIA EL TORNILLO ${FACTURAS[1].cuit};220.500,00;;3.598.500,00`,
    '20/08/2026;TRANSF ESTUDIO RIVAS HONORARIOS;350.000,00;;3.248.500,00',
    '20/08/2026;DEBITO AUTOMATICO EDESUR;98.400,00;;3.150.100,00',
    '21/08/2026;COMPRA TARJETA DEB KIOSCO 24 DE MARZO;47.500,00;;3.102.600,00',
    '21/08/2026;ACREDITACION VENTAS TARJETA;;1.250.000,00;4.352.600,00',
    '21/08/2026;PAGO FLETE DON RAMON;65.000,00;;4.287.600,00',
  ].join('\r\n');
  await writeFile(path.join(OUT, 'extracto-banco.csv'), '\ufeff' + extracto, 'utf8');
  console.log('▸ extracto-banco.csv');

  await writeFile(path.join(OUT, 'ground-truth.json'), JSON.stringify(groundTruth, null, 2));
  console.log('▸ ground-truth.json');
  console.log(`\nListo: ${Object.keys(groundTruth).length + 2} archivos en samples/`);
}

main().catch((err) => {
  console.error('✖', err);
  process.exit(1);
});
