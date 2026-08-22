/**
 * Localización y decodificación del QR dentro de una imagen de factura.
 *
 * Determinístico: sharp decodifica la imagen a RGBA y jsQR busca el código.
 * Las fotos reales vienen torcidas, con sombra o baja resolución, así que
 * probamos una escalera de variantes (escalas, umbralado, recortes por
 * cuadrante) hasta que alguna decodifica.
 */
import sharp from 'sharp';
import jsQR from 'jsqr';

const MAX_DIM = 1600;

/**
 * @param {Buffer} imageBuffer PNG/JPEG/WebP/BMP
 * @returns {Promise<{ text: string, attempt: string } | null>}
 */
export async function scanQr(imageBuffer) {
  const base = sharp(imageBuffer, { failOn: 'none' }).rotate(); // respeta EXIF
  const meta = await base.metadata();
  if (!meta.width || !meta.height) return null;

  const variants = buildVariants(meta);
  for (const variant of variants) {
    const found = await tryVariant(base.clone(), variant);
    if (found) return found;
  }
  return null;
}

function buildVariants(meta) {
  const scale = Math.min(1, MAX_DIM / Math.max(meta.width, meta.height));
  const w = Math.round(meta.width * scale);
  const variants = [
    { name: 'original', width: w },
    { name: 'original-2x', width: Math.min(meta.width, w * 2) },
    { name: 'gris-normalizado', width: w, normalize: true },
    { name: 'umbral-160', width: w, threshold: 160 },
    { name: 'umbral-110', width: w, threshold: 110 },
  ];
  // Los QR de AFIP suelen estar en una esquina: probar cuadrantes al doble
  // de resolución para fotos donde el QR queda chico.
  for (const [name, region] of Object.entries(quadrants(meta))) {
    variants.push({ name: `cuadrante-${name}`, width: w, extract: region });
    variants.push({ name: `cuadrante-${name}-umbral`, width: w, extract: region, threshold: 140 });
  }
  return variants;
}

function quadrants(meta) {
  const hw = Math.floor(meta.width / 2);
  const hh = Math.floor(meta.height / 2);
  return {
    'sup-izq': { left: 0, top: 0, width: hw, height: hh },
    'sup-der': { left: meta.width - hw, top: 0, width: hw, height: hh },
    'inf-izq': { left: 0, top: meta.height - hh, width: hw, height: hh },
    'inf-der': { left: meta.width - hw, top: meta.height - hh, width: hw, height: hh },
  };
}

async function tryVariant(pipeline, variant) {
  try {
    let p = pipeline;
    if (variant.extract) p = p.extract(variant.extract);
    p = p.resize({ width: variant.width, withoutEnlargement: false });
    if (variant.normalize) p = p.grayscale().normalize();
    if (variant.threshold) p = p.grayscale().threshold(variant.threshold);

    const { data, info } = await p.ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const code = jsQR(new Uint8ClampedArray(data.buffer, data.byteOffset, data.length), info.width, info.height);
    if (code && code.data) {
      return { text: code.data, attempt: variant.name };
    }
  } catch {
    // Variante inválida para esta imagen (p.ej. extract fuera de rango): seguimos.
  }
  return null;
}
