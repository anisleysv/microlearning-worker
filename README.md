# Microlearning Worker

Servicio independiente de Microlearning Center que genera una imagen a partir de un texto mediante **FLUX.1 Schnell en Cloudflare Workers AI**.

Repositorio: https://github.com/anisleysv/microlearning-worker

## Arquitectura

Cliente local → Worker autenticado → binding Workers AI → imagen JPEG.

El modelo se ejecuta en Cloudflare, no en la GPU de tu PC. El Worker usa `env.AI.run` con el modelo fijo `@cf/black-forest-labs/flux-1-schnell`. No necesita guardar un token de la API de Cloudflare en el código. La clave `IMAGE_API_KEY` protege el acceso al servicio y es distinta de las credenciales de tu cuenta.

No incluye almacenamiento de imágenes, RAG, generación de voz ni integración con la aplicación pública. El cliente guarda el archivo localmente. Ningún prompt ni imagen se registra explícitamente; la observabilidad del Worker está desactivada.

## Requisitos e instalación

- Node.js 22 o superior y npm.
- Cuenta de Cloudflare con Workers AI disponible, para generación real.
- Inicio de sesión en Wrangler para desarrollo con IA y despliegue.

```powershell
npm ci
npm test
npm run check
npm run build:check
```

Las pruebas simulan el binding: no requieren cuenta, no consumen cuota y no certifican la calidad de una imagen real. La comprobación de compilación tampoco despliega.

Si esta terminal solo tiene Node y no npm, una vez instaladas las dependencias puedes ejecutar:
```powershell
node --test
node --check src/index.js
node node_modules/wrangler/bin/wrangler.js deploy --dry-run --outdir .local-review/build
```

## Desarrollo con generación real

1. Ejecuta `npx wrangler login`.
2. Copia `.dev.vars.example` a `.dev.vars` y configura `IMAGE_API_KEY` con una clave aleatoria de al menos 32 caracteres. Puedes generar una localmente con:
   `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`
3. Ejecuta `npm run dev`. Normalmente escucha en `http://127.0.0.1:8787`.

**Workers AI es remoto incluso en desarrollo** (`remote: true`). Cada generación real usa tu cuenta y cuota de Cloudflare; no es una simulación local gratuita ilimitada. Los prompts se envían a Cloudflare. El nivel gratuito de Workers AI ofrece actualmente 10.000 Neurons diarios compartidos; revisa las condiciones y el plan de tu cuenta antes de usarlo.

Desde otra terminal de PowerShell:
```powershell
$env:WORKER_URL = 'http://127.0.0.1:8787'
$workerSecret = Read-Host 'Clave IMAGE_API_KEY' -AsSecureString
$env:IMAGE_API_KEY = [System.Net.NetworkCredential]::new('', $workerSecret).Password
node scripts/generate.mjs "Ilustración educativa de una biblioteca digital, sin texto" output/biblioteca.jpg
Remove-Item Env:IMAGE_API_KEY
```

Introduce la misma clave de `.dev.vars`. El cliente no carga ese archivo automáticamente. No sobrescribe imágenes existentes; usa un nombre nuevo. El tiempo límite del cliente es 120 segundos; si expira, la generación remota puede continuar y consumir cuota. No se reintenta automáticamente.

## Contrato HTTP

### GET /health
Devuelve `{"status":"ok","service":"microlearning-worker"}`. Comprueba que el Worker responde, no que la cuenta tenga acceso o cuota de IA.

### POST /api/images
Cabeceras obligatorias:
- `Authorization: Bearer <IMAGE_API_KEY>`
- `Content-Type: application/json`

Cuerpo:
```json
{
  "prompt": "Una ilustración sobre aprendizaje con inteligencia artificial",
  "steps": 4,
  "format": "jpeg"
}
```

- `prompt`: obligatorio; 1–2048 caracteres Unicode después de recortar espacios.
- `steps`: opcional, entero de 1 a 8; predeterminado 4.
- `format`: opcional, `jpeg` (binario) o `json`; predeterminado `jpeg`.
- Límite del cuerpo: 16 KiB. Otros campos se rechazan.
- La versión inicial no expone dimensiones, semillas ni selección de modelo.

El formato JSON devuelve `model`, `mimeType: "image/jpeg"` e `image` en Base64.
Las respuestas llevan `Cache-Control: no-store`.

Errores: 400 entrada inválida; 401 clave inválida; 403 origen/preflight no autorizado; 404 ruta inexistente; 405 método; 413 tamaño; 415 tipo; 429 cuota si el binding expone ese estado; 502 fallo/respuesta inválida de IA; 503 falta de configuración. Otros fallos de cuota que el binding no identifica con estado HTTP se devuelven como 502. Los errores internos del proveedor no se exponen.

## Acceso desde navegador

Por defecto `ALLOWED_ORIGINS` está vacío: solo clientes sin cabecera Origin, como el cliente local o un backend, pueden acceder. Para una herramienta privada de navegador, configura una lista de orígenes exactos separados por comas.

CORS no sustituye autenticación. **No incrustes IMAGE_API_KEY en Microlearning Center, GitHub Pages ni ningún JavaScript público.** Para integrar una interfaz pública sería necesario un backend con autenticación de usuario o un acceso protegido. Esta versión es para un productor de contenido privado; una clave compartida no incorpora cuotas por usuario ni rate limiting distribuido.

## Despliegue posterior a aprobación

No hay despliegue automático ni workflow de publicación. Cuando se autorice:
```powershell
npx wrangler login
npm run deploy
npx wrangler secret put IMAGE_API_KEY
```

El primer despliegue rechazará la generación con 503 hasta configurar el secreto. Introduce la clave en el prompt de Wrangler, nunca como argumento ni en Git. Si hay varias cuentas, selecciona la correcta mediante `CLOUDFLARE_ACCOUNT_ID` en tu entorno. La URL final será la indicada por Wrangler.

Configura WORKER_URL con esa URL HTTPS y usa el cliente local para una prueba real. Confirma JPEG legible y revisa consumo de cuota. El despliegue del Worker es independiente de GitHub Pages.

## Archivos privados

Git ignora dependencias, herramientas locales, cachés de Wrangler, .dev.vars, .env, imágenes en output/, informes locales, archivos comprimidos y carpetas context/, design/ y skills/. Nunca guardes credenciales reales en ejemplos ni en la configuración pública.

## Referencias oficiales

- [FLUX.1 Schnell: entrada y salida](https://developers.cloudflare.com/workers-ai/models/flux-1-schnell/)
- [Binding Workers AI](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [Precios y cuota](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
