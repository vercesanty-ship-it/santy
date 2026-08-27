# DTF Ready — contexto del proyecto (para retomar con Claude Code)

Este archivo resume todo lo necesario para seguir este proyecto sin perder contexto. Claude Code lo lee automáticamente al abrir la carpeta.

## Qué es el negocio

SaaS para empresas de DTF (impresión textil por transferencia) y sus clientes finales. El problema que resuelve: los clientes mandan mal los archivos para imprimir (baja resolución, fondo sin quitar, tamaño/DPI incorrecto), y esta herramienta los "arma" bien de forma automática.

- Meta de facturación: 2.000–2.500 USD/mes en suscripciones.
- Mismo motor de armado de archivo para los dos lados: tanto la empresa de DTF como el cliente final pueden subir y corregir archivos de forma independiente (no es un flujo donde uno sube y el otro solo recibe).
- El armado no es 100% automático: además de subir la imagen, el usuario completa tamaño (ancho/alto) y cantidad.
- Cobro: MercadoPago (Stripe no está disponible para registro directo desde Argentina).
- Se planea que sea instalable como PWA desde Chrome, para que los clientes no tengan que entrar siempre a la web.
- Prueba gratis: 5 días, pero hoy no está automatizada — quien quiere probar tiene que escribir y se le manda manualmente.
- WhatsApp de contacto del SaaS: 1168693256.

## Planes definidos

Clientes finales:

- Básico: hasta 10 archivos/mes — 3 USD
- Pro: hasta 60 archivos/mes — 7 USD

Empresas DTF:

- Básico: hasta 20 archivos/mes — 20 USD
- Pro: más de 100 archivos/mes — 30 USD
- Negocio: archivos ilimitados — 40 USD

## Contexto del dueño del proyecto

Santiago nunca programó antes de este proyecto (nivel principiante en código). Está construyendo esto con ayuda de Claude Code — cualquier explicación técnica conviene que sea clara y sin dar por sentado conocimiento previo de programación.

## Qué está construido hasta ahora

Se armó y probó de punta a punta (no es un mockup) un prototipo funcional del motor de mejora/armado de archivo — la pieza central de todo el producto. Vive en `upscale-service/` dentro de este mismo repo.

### Qué hace de verdad

1. Sube una imagen (el diseño del cliente).
2. Quita el fondo automáticamente si se pide (IA real, no un truco de color).
3. Calcula el factor de escalado necesario para llegar a 300 DPI (estándar de impresión DTF) al tamaño físico pedido en cm.
4. Aplica súper-resolución real por red neuronal (no un simple resize/estirado) para agrandar la imagen recuperando detalle.
5. Exporta un PNG con la metadata de DPI correcta, listo para imprimir.
6. Si el archivo original es tan chico que ni la IA puede compensar el escalado sin perder nitidez, avisa con una advertencia en vez de entregar algo pixelado sin decir nada.

### Stack técnico y por qué

- **Backend**: Python + Flask (`app.py`), servidor de desarrollo simple — para producción hay que ponerle un WSGI real (gunicorn) y deploy en algún hosting.
- **Súper-resolución**: `cv2.dnn_superres` (OpenCV) con el modelo FSRCNN (`models/FSRCNN_x2.pb`, `models/FSRCNN_x4.pb`). Se eligió FSRCNN en vez de EDSR o Real-ESRGAN porque:
  - EDSR da algo más de nitidez pero es 100-600x más lento en CPU (se probó: ~13s para agrandar 4x una imagen de 150×150 px — impracticable para un SaaS con archivos reales de mayor tamaño).
  - Real-ESRGAN (lo que usan Pixelcut y similares) da mejor calidad pero requiere más recursos (torch/ncnn-vulkan); quedó fuera del prototipo por peso, pero es la mejora natural a futuro si se justifica el costo de infraestructura.
  - FSRCNN corre en ~0.04s en CPU sin GPU, con salto de calidad real y verificable contra un resize bicúbico común (se comparó visualmente).
  - El modo "Máxima calidad" del selector no usa un modelo distinto (para no cargar un modelo pesado): aplica FSRCNN + un realce de nitidez (unsharp mask) extra sobre el resultado.
- **Remoción de fondo**: `rembg` con el modelo `u2netp` (liviano, ~4-15MB, rápido en CPU). Importante: rembg 2.0.81 trae por defecto un modelo nuevo (`bria-rmbg-2.0`, ~1GB) que es demasiado pesado — hay que forzar explícitamente `new_session("u2netp")` como está hecho en el código, si no se re-descarga el modelo gigante.
- **Frontend**: HTML/CSS/JS plano (`templates/index.html`, `static/style.css`, `static/app.js`), sin framework — estilo visual inspirado en Pixelcut (paleta violeta/rosa, dropzone grande, slider de comparación antes/después con clip-path, chips de resultado).

### Gotcha técnico importante (por si se repite)

Al instalar `opencv-contrib-python` normal, el módulo `cv2.dnn_superres` aparece vacío (sin `DnnSuperResImpl_create`) — es un bug conocido que ocurre cuando hay múltiples paquetes de OpenCV instalados a la vez (`opencv-python` + `opencv-python-headless` + `opencv-contrib-python`). La solución fue desinstalar todos y dejar solo `opencv-contrib-python-headless` (última versión, compatible con numpy 2.x). Si en algún momento el módulo de súper-resolución deja de funcionar, revisar primero que no haya paquetes de opencv duplicados instalados.

### Estructura de archivos

```
upscale-service/
  app.py                  → backend Flask: recibe imagen + parámetros, aplica IA, devuelve PNG en base64 + diagnóstico
  templates/index.html    → página única
  static/style.css        → estilos
  static/app.js           → subida (drag&drop), slider antes/después, llamada a /api/process
  models/
    FSRCNN_x2.pb          → modelo de súper-resolución x2
    FSRCNN_x4.pb          → modelo de súper-resolución x4
  requirements.txt        → Flask, opencv-contrib-python-headless, pillow, numpy, rembg, onnxruntime
  README.md               → instrucciones para correrlo localmente
```

### Endpoint principal

`POST /api/process` — multipart/form-data con:

- `file`: la imagen
- `ancho_cm`, `alto_cm`: tamaño físico deseado
- `cantidad`: cantidad de prendas del pedido
- `quitar_fondo`: `"true"` / `"false"`
- `modo`: `"rapido"` o `"calidad"`

Devuelve JSON con: `image_base64` (PNG resultado), `original_size`, `final_size`, `dpi`, `escala_aplicada`, `tiempo_segundos`, `warning` (si corresponde), y los datos del pedido (`ancho_cm`, `alto_cm`, `cantidad`).

## Qué falta para que sea el producto real (en orden sugerido)

1. Login y cuentas de usuario — hoy cualquiera usa la herramienta sin cuenta.
2. Planes y límites — contar archivos procesados por mes por usuario y cortar según el plan (ver tabla de planes arriba).
3. Cobro con MercadoPago — activar/renovar plan, manejar suscripciones.
4. Guardar historial de archivos procesados (hoy se genera y se descarga, no persiste en ningún lado — no hay base de datos todavía).
5. Automatizar la prueba gratis de 5 días (hoy es manual por WhatsApp).
6. Deploy a un hosting real (Railway, Render, o un VPS chico) — hoy solo corre localmente. Debe ser algo económico, dado que los planes son de pocos dólares por mes.
7. Empaquetar como PWA instalable desde Chrome.
8. (Opcional, más adelante) Sumar Real-ESRGAN como motor de súper-resolución para un tier premium, si se justifica el costo de cómputo extra.

## Notas de investigación (por si es útil al decidir mejoras)

Herramientas tipo Pixelcut / Let's Enhance / Upscale.media suelen basarse en Real-ESRGAN (+ GFPGAN para restaurar rostros en fotos, no relevante acá). Para impresión DTF: 300 DPI al tamaño físico final es el estándar, PNG con transparencia es el formato de entrega habitual (no TIFF/PDF, que son más de flujos offset), y la remoción de fondo suele venir empaquetada junto con la mejora de imagen porque los diseños para prendas necesitan transparencia, no un fondo blanco.
