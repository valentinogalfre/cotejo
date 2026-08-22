# Cotejo — Conciliador AFIP on-device

**Agente local de back-office que concilia facturas argentinas contra el extracto bancario, con extracción auto-verificada contra el QR fiscal de ARCA/AFIP. 100% on-device vía [QVAC](https://docs.qvac.tether.io): cero cloud, cero API keys, cero datos que salen de la máquina.**

> Aleph Hackathon 2026 · Track **QVAC** (Tether) + **General** (Crecimiento)

## El problema

Toda pyme argentina pierde horas por mes cotejando facturas (PDF de ARCA, fotos de tickets, comprobantes arrugados) contra el extracto del banco. Delegarlo a un SaaS con IA significa mandarle tus datos financieros a un tercero. Y los modelos chicos que sí corren en tu máquina... alucinan importes.

## El truco: extracción auto-verificada

Toda factura electrónica argentina lleva un **QR fiscal obligatorio (RG 4892/2020)** que codifica CUIT, fecha, importe total, tipo y número de comprobante y CAE — firmado por el emisor ante ARCA.

Cotejo lo usa como **fuente de verdad determinística contra la que se cotejea al modelo**:

1. El OCR local lee la factura y un LLM de 4B estructura los datos (salida forzada por JSON Schema → gramática de llama.cpp).
2. En paralelo, el QR se decodifica **sin IA** (jsQR + base64 + JSON).
3. Si el modelo leyó `$118.000` y el QR dice `$181.000` → **el sistema atrapa la alucinación solo, la corrige y la registra como evidencia** (en pantalla: valor tachado en rojo → valor del QR).

La debilidad conocida de los modelos 1–4B se convierte en el feature central: cada corrección es una demostración visible de que el pipeline no confía a ciegas en la IA. Y lo que no se pudo leer se reporta como **ilegible** — categoría de primera clase, no un dato inventado.

## Pipeline

```
factura (PDF/foto) ──► render/decodificación
        │                    │
        ▼                    ▼
  OCR local QVAC       QR fiscal ARCA (determinístico)
        │                    │
        ▼                    │
  LLM 4B local (JSON Schema) │
        │                    │
        └──── cross-check ◄──┘     ⟵ el QR corrige/verifica al modelo
                  │
                  ▼
   conciliación vs extracto CSV ──► panel + reporte CSV
   (conciliada / monto difiere / duplicada / sin match / débito sin factura,
    cada una con explicación de una frase)
```

## Capacidades y modelos QVAC usados

| Capacidad | Modelo | Uso |
|---|---|---|
| [OCR](https://docs.qvac.tether.io/ai-capabilities/ocr) | `OCR_LATIN` (ONNX det+rec, es/en) | texto crudo de la factura, con confianza por bloque |
| [Text generation](https://docs.qvac.tether.io/ai-capabilities/text-generation) | `QWEN3_4B_INST_Q4_K_M` (llama.cpp, Q4) | extracción estructurada con `responseFormat: json_schema` |

**Toda la integración con `@qvac/sdk` vive en un solo archivo: [`src/qvac.js`](src/qvac.js).**

<!-- PERMALINKS (completar al pushear):
- loadModel OCR+LLM: src/qvac.js líneas ~50-75
- ocr(): src/qvac.js líneas ~88-110
- completion() con json_schema: src/qvac.js líneas ~118-145
- downloadAsset (offline-ready): src/qvac.js líneas ~160-170
-->

## Setup desde clone limpio

Requisitos: Node ≥ 22.17, macOS/Linux. ~4 GB de disco para modelos.

```bash
git clone <este-repo> && cd cotejo
npm install
npm run make-test-data        # genera facturas sintéticas + extracto en samples/
npm run prefetch-models       # baja OCR + Qwen3 4B (una vez; después, offline)
npm start                     # http://127.0.0.1:4877
```

Flujo: arrastrá los archivos de `samples/` al paso 1, `samples/extracto-banco.csv` al paso 2, y **COTEJAR TODO**.

- LLM más liviano: `QVAC_LLM=1.7b npm start` (Qwen3 1.7B).
- Solo UI, sin modelos (dev): `npm run dev` (extracción por regex, marcada como MOCK).

## Evidencia, no vibes

```bash
npm test              # 32 tests de contrato (QR fiscal, CUIT mod-11, matching, es-AR parsing)
npm run bench         # pipeline completo × N corridas vs ground truth → tasa por campo + latencias
```

<!-- RESULTADOS BENCH (completar con la corrida final):
Modelo: Qwen3 4B Q4_K_M · Hardware: MacBook (Apple M5, 16 GB) · macOS 26
- campo/tasa...
- latencia p50/p90...
-->

## Arquitectura

- `src/qvac.js` — **única** frontera con `@qvac/sdk` (OCR + completion + prefetch).
- `src/afip-qr.js` — decodificación determinística del QR fiscal (RG 4892/2020) + validación CUIT módulo 11. Sin IA.
- `src/qr-scan.js` — localización del QR en fotos reales (escalera de variantes: escalas, umbrales, cuadrantes).
- `src/extract.js` — prompt + JSON Schema + validación semántica local con reintento. Lo inválido se anula a `null`, jamás se inventa.
- `src/crosscheck.js` — el QR corrige/verifica al modelo; cada corrección queda loggeada.
- `src/reconcile.js` — matching contra el extracto con explicaciones de una frase.
- `src/pdf.js` / `src/statement.js` — render PDF→PNG + texto embebido; parser de CSVs bancarios (débito/crédito o importe firmado, es-AR).
- `src/server.js` + `public/` — server local (127.0.0.1) + panel con registro de evidencia en vivo (SSE).

## Privacidad

El server escucha solo en `127.0.0.1` y no hace ninguna request saliente. Con los modelos ya descargados, **todo funciona en modo avión** — así se graba el demo.
