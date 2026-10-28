# Resumen diario del BOE

Cada mañana de lunes a sábado lee el BOE, detecta lo que afecta al temario de
Abogados del Estado y envía por email un resumen con el desarrollo en PDF.
Se ejecuta solo en GitHub Actions (no hace falta tener ningún ordenador encendido).

## Qué se puede cambiar (archivo `config.json`)

| Campo | Para qué |
| --- | --- |
| `modelos` | Modelos de Gemini, en orden: si uno falla, prueba el siguiente |
| `intentosPorModelo` | Intentos con cada modelo antes de pasar al siguiente |
| `maxNormas` | Máximo de normas analizadas al día |
| `horaEnvio` | Hora de Madrid a la que empieza a preparar el resumen (llega unos minutos después) |
| `horaLimite` | Hasta qué hora reintenta si el BOE no está publicado o Gemini falla |

El temario está en `temario.txt`.

## Secretos (Settings → Secrets and variables → Actions)

- `GEMINI_API_KEY`: clave de Google AI Studio
- `GMAIL_USER`: el Gmail que envía
- `GMAIL_APP_PASSWORD`: contraseña de aplicación de ese Gmail (16 letras, sin espacios)
- `EMAIL_CARMEN`: a quién llega el resumen cada día
- `EMAIL_PABLO`: a quién llegan las pruebas manuales y los avisos si algo falla

## Probar a mano

Pestaña **Actions → Resumen diario del BOE → Run workflow**. Con "Enviar solo a
Pablo" marcado, el email llega solo a `EMAIL_PABLO`. En "Fecha" se puede poner un
día concreto (por ejemplo `20261023`).
