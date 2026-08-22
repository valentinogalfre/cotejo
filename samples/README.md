# Lote de prueba

Generado con `npm run make-test-data` (determinístico). Los CUITs son sintéticos pero pasan el dígito verificador módulo 11, y cada QR es un QR fiscal **real** según RG 4892/2020 (URL de afip.gob.ar con el JSON oficial en base64) — decodificable con cualquier lector.

| Archivo | Qué demuestra |
|---|---|
| `01-papelera-limpia.png` | Factura B digital limpia → concilia exacto con el extracto |
| `02-ferreteria-limpia.png` | El banco debitó $220.500 pero la factura dice $222.000 → **monto difiere** |
| `03-estudio-limpia.png` | Factura C de servicios → concilia |
| `04-mayorista-foto.png` | Foto torcida con sombra y blur → el QR igual se decodifica; nunca se pagó → **sin match** |
| `05-ticket-borroso.png` | Ticket térmico lavado: texto casi ilegible, QR nítido (como en la realidad) → concilia |
| `06-recibo-sin-qr.png` | Recibo no fiscal sin QR → el sistema lo marca **sin verificar / revisar a mano**, no inventa |
| `07-ferreteria-duplicada.png` | Mismo comprobante que 02 con otro nombre de archivo → **duplicada** |
| `08-papelera.pdf` | PDF escaneado sin capa de texto (mismo comprobante que 01) → ejercita render PDF + OCR, y cae como **duplicada** si se sube junto a 01 |
| `09-imprenta-digital.pdf` | PDF digital con capa de texto real (como los de ARCA) → ejercita el camino "texto embebido, sin OCR" → concilia |
| `extracto-banco.csv` | Formato banco AR (`Fecha;Concepto;Débito;Crédito;Saldo`, importes es-AR). Incluye un débito de Edesur y un flete **sin factura** |
| `ground-truth.json` | Valores reales de cada factura — lo usa `npm run bench` para medir tasa de acierto |

Para el flujo estándar del demo: subí `01`–`07` al paso 1 y `extracto-banco.csv` al paso 2.
