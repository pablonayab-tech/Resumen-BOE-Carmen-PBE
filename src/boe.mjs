// Resumen diario del BOE para el temario de Abogados del Estado.
// Hace lo mismo que el workflow de n8n, pero se ejecuta solo en GitHub Actions.
//
// Variables de entorno:
//   GEMINI_API_KEY, GMAIL_USER, GMAIL_APP_PASSWORD  -> secretos de GitHub
//   FECHA (opcional, AAAAMMDD)  -> analizar un BOE concreto (para pruebas)
//   MODO_PRUEBA ('true'/'false') -> si es 'true', todo va a EMAIL_PABLO
//   EJECUCION_PROGRAMADA ('true') -> la lanzó el horario automático (no una prueba manual)
//   EMAIL_CARMEN, EMAIL_PABLO -> direcciones de correo (secretos, para que no estén a la vista)

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import nodemailer from 'nodemailer';
import { maquetar } from './plantilla.mjs';

const RAIZ = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config.json'), 'utf8'));
cfg.temario = fs.readFileSync(path.join(RAIZ, 'temario.txt'), 'utf8');
// Los correos vienen de los secretos de GitHub, para que no estén a la vista en el repositorio
cfg.emailDestino = (process.env.EMAIL_CARMEN || '').trim();
if (!cfg.emailDestino) {
  const msg = 'Falta el secreto EMAIL_CARMEN (Settings → Secrets and variables → Actions)';
  if (process.env.GITHUB_ACTIONS) console.log('::error::' + msg);
  throw new Error(msg);
}
// Si falta EMAIL_PABLO, las pruebas y los avisos van al propio Gmail que envía, para no bloquear el envío a Carmen
cfg.emailPrueba = cfg.emailAvisos = (process.env.EMAIL_PABLO || '').trim() || (process.env.GMAIL_USER || '').trim();
if (!(process.env.EMAIL_PABLO || '').trim() && process.env.GITHUB_ACTIONS) console.log('::warning::Falta el secreto EMAIL_PABLO: las pruebas y los avisos de error van al Gmail que envía');
const quien = (to) => (to === cfg.emailDestino ? 'Carmen' : 'Pablo');
const ESTADO = path.join(RAIZ, 'estado', 'ultimo_envio.txt');
const LF = '\n';

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log('[' + new Date().toISOString() + ']', ...a);
// Resumen visible en la página de la ejecución (anotaciones de GitHub)
const nota = (txt, tipo = 'notice') => { if (process.env.GITHUB_ACTIONS) console.log('::' + tipo + '::' + String(txt).replace(/\r?\n/g, ' | ').slice(0, 900)); };

// ---------- Fecha y hora de Madrid ----------
function ahoraMadrid() {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Madrid', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).map((x) => [x.type, x.value]));
  return { fecha: p.year + p.month + p.day, minutos: Number(p.hour) * 60 + Number(p.minute), hora: p.hour + ':' + p.minute };
}
const aMinutos = (hhmm) => { const [h, m] = String(hhmm).split(':').map(Number); return h * 60 + m; };

// ---------- HTTP con reintentos ----------
async function pedir(url, opciones = {}, { intentos = 3, espera = 5000, timeout = 60000 } = {}) {
  let ultimo;
  for (let i = 1; i <= intentos; i++) {
    try {
      const r = await fetch(url, { ...opciones, signal: AbortSignal.timeout(timeout) });
      if (r.status === 404) return r; // lo trata quien llama
      if (r.ok) return r;
      ultimo = new Error('HTTP ' + r.status + ' en ' + url + ': ' + (await r.text()).slice(0, 300));
    } catch (e) { ultimo = e; }
    if (i < intentos) await esperar(espera);
  }
  throw ultimo;
}

// ---------- Gemini con cadena de modelos de respaldo ----------
// El último modelo de la cadena (Flash-Lite) es el "de emergencia": funciona, pero es menos fino.
const EMERGENCIA = cfg.modeloEmergencia || cfg.modelos[cfg.modelos.length - 1];
class SoloEmergencia extends Error {}

async function gemini(body, etapa, timeoutSegundos = cfg.timeoutGeminiSegundos) {
  const errores = [];
  for (const modelo of cfg.modelos) {
    for (let i = 1; i <= cfg.intentosPorModelo; i++) {
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + modelo + ':generateContent', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutSegundos * 1000),
        });
        const txt = await r.text();
        if (!r.ok) {
          errores.push(modelo + ' (intento ' + i + '): HTTP ' + r.status);
          log(etapa + ' · ' + modelo + ' intento ' + i + ' → HTTP ' + r.status);
          if (r.status === 429 || r.status === 404 || r.status === 400) break; // cupo agotado o modelo no válido: siguiente modelo
        } else {
          const resp = JSON.parse(txt);
          const parts = (((resp.candidates || [])[0] || {}).content || {}).parts || [];
          const text = parts.filter((p) => p.text && !p.thought).map((p) => p.text).join('');
          if (!text) throw new Error('respuesta vacía');
          const parsed = JSON.parse(text);
          log(etapa + ' · respondió ' + modelo + ' (intento ' + i + ')');
          nota(etapa + ': respondió ' + modelo + (errores.length ? ' (antes fallaron: ' + errores.join('; ') + ')' : ''));
          return { parsed, modelo };
        }
      } catch (e) {
        errores.push(modelo + ' (intento ' + i + '): ' + (e.name === 'TimeoutError' ? 'sin respuesta (timeout)' : e.message));
        log(etapa + ' · ' + modelo + ' intento ' + i + ' → ' + e.message);
        if (e.name === 'TimeoutError') break; // si no contesta, no se insiste: siguiente modelo
      }
      if (i < cfg.intentosPorModelo) await esperar(5000);
    }
  }
  throw new Error('Ningún modelo de Gemini respondió en la ' + etapa + ':' + LF + errores.join(LF));
}

// ---------- 1. Sumario del BOE ----------
async function descargarSumario(fecha) {
  const r = await pedir('https://www.boe.es/datosabiertos/api/boe/sumario/' + fecha, { headers: { Accept: 'application/json' } }, { intentos: 3, espera: 10000 });
  if (r.status === 404) return null;
  return await r.json();
}

function extraerCandidatas(body) {
  const arr = (x) => (x === undefined || x === null ? [] : Array.isArray(x) ? x : [x]);
  const seen = {};
  const rows = [];
  for (const d of arr(body.data && body.data.sumario && body.data.sumario.diario)) {
    for (const s of arr(d.seccion)) {
      const cod = String(s.codigo);
      if (['1', '3', 'T'].indexOf(cod) === -1) continue;
      for (const dep of arr(s.departamento)) {
        const direct = arr(dep.item);
        const viaEpi = arr(dep.epigrafe).flatMap((e) => arr(e.item));
        for (const it of direct.concat(viaEpi)) {
          if (!it || !it.identificador || seen[it.identificador]) continue;
          seen[it.identificador] = true;
          rows.push({ seccion: cod, departamento: dep.nombre || '', id: it.identificador, titulo: it.titulo || '' });
        }
      }
    }
  }
  return rows;
}

// ---------- 2. Preselección por títulos ----------
function cuerpoPreseleccion(rows) {
  const listado = rows.map((r) => r.id + ' | Sección ' + r.seccion + ' | ' + r.departamento + ' | ' + r.titulo).join(LF);
  const prompt = 'TEMARIO OFICIAL (Abogados del Estado):' + LF + cfg.temario + LF + LF +
    'DISPOSICIONES PUBLICADAS HOY EN EL BOE (id | sección | departamento | título):' + LF + listado + LF + LF +
    'TAREA: PRESELECCIONA solo las disposiciones cuyo TÍTULO indique que crean, modifican, derogan o desarrollan normativa comprendida en algún tema del temario. Prioriza la Sección I (disposiciones generales). Ignora nombramientos, ceses, oposiciones, becas, subvenciones, convenios menores, anuncios y normativa sectorial ajena al programa. Ante duda razonable, inclúyela solo si el título sugiere un cambio normativo con impacto en el temario. Devuelve como máximo ' + cfg.maxNormas + ' ids, ordenados de más a menos importante, copiados EXACTAMENTE de la lista. No inventes ids. Si ninguna es relevante, devuelve una lista vacía.';
  return {
    contents: [{ role: 'user', parts: [{ text: prompt }] }],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: { relevantes: { type: 'ARRAY', items: { type: 'OBJECT', properties: { id: { type: 'STRING' }, motivo: { type: 'STRING' } }, required: ['id'] } } },
        required: ['relevantes'],
      },
    },
  };
}

function procesarPreseleccion(parsed, rows) {
  const byId = {};
  for (const c of rows) byId[c.id] = c;
  const seen = {};
  const relevantes = [];
  for (const r of (parsed.relevantes || [])) {
    const c = byId[r.id];
    if (c && !seen[r.id]) { seen[r.id] = true; relevantes.push({ id: c.id, titulo: c.titulo, seccion: c.seccion, motivo: r.motivo || '' }); }
  }
  return relevantes.slice(0, Number(cfg.maxNormas) || 12);
}

// ---------- 3. Texto oficial de cada norma ----------
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
const tag = (xml, name) => { const m = xml.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>')); return m ? decode(m[1].replace(/<[^>]+>/g, '').trim()) : ''; };

export function leerXml(xml) {
  const max = Number(cfg.maxCaracteresTexto) || 15000;
  const id = tag(xml, 'identificador');
  if (!id) return null;
  const a0 = xml.indexOf('<analisis>');
  const a1 = xml.indexOf('</analisis>');
  const analisis = a0 >= 0 && a1 > a0 ? xml.slice(a0, a1) : '';
  const refs = [];
  const re = /<anterior\s+referencia="([^"]*)"[^>]*>\s*<palabra[^>]*>([\s\S]*?)<\/palabra>\s*<texto>([\s\S]*?)<\/texto>/g;
  let m;
  while ((m = re.exec(analisis)) !== null) refs.push(decode(m[2].trim()) + ' ' + decode(m[3].replace(/<[^>]+>/g, '').trim()) + ' [' + m[1] + ']');
  const t0 = xml.indexOf('<texto>', a1 > 0 ? a1 : 0);
  let texto = t0 >= 0 ? xml.slice(t0) : '';
  texto = decode(texto.replace(/<\/(p|h[1-6]|li|div|tr)>/g, LF).replace(/<[^>]+>/g, ' ')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, LF).trim();
  const total = texto.length;
  let recortado = false;
  if (total > max) { const tail = Math.min(4000, Math.floor(max / 3)); texto = texto.slice(0, max - tail) + LF + '[...TEXTO INTERMEDIO OMITIDO POR LONGITUD...]' + LF + texto.slice(total - tail); recortado = true; }
  return {
    id, url: 'https://www.boe.es/diario_boe/txt.php?id=' + id,
    rango: tag(xml, 'rango'), numero: tag(xml, 'numero_oficial'), titulo: tag(xml, 'titulo'),
    fechaDisposicion: tag(xml, 'fecha_disposicion'), fechaVigencia: tag(xml, 'fecha_vigencia'),
    referencias: refs, texto, recortado,
  };
}

export function cuerpoAnalisis(docs) {
  let bloque = '';
  docs.forEach((d, i) => {
    bloque += '=== NORMA ' + (i + 1) + ' ===' + LF + 'ID: ' + d.id + LF + 'Rango: ' + d.rango + LF + 'Número oficial: ' + d.numero + LF + 'Título: ' + d.titulo + LF + 'Fecha disposición (AAAAMMDD): ' + d.fechaDisposicion + LF + 'Fecha vigencia en metadatos (AAAAMMDD): ' + (d.fechaVigencia || 'no consta') + LF + 'Enlace: ' + d.url + LF +
      'REFERENCIAS ANTERIORES (análisis oficial del BOE):' + LF + (d.referencias.length ? d.referencias.join(LF) : '(ninguna indicada)') + LF +
      'TEXTO' + (d.recortado ? ' (recortado)' : '') + ':' + LF + d.texto + LF + LF;
  });
  const prompt = 'TEMARIO OFICIAL (Abogados del Estado):' + LF + cfg.temario + LF + LF + 'NORMAS PUBLICADAS HOY PARA ANALIZAR (datos oficiales del BOE):' + LF + bloque +
    'INSTRUCCIONES:' + LF +
    '- Usa EXCLUSIVAMENTE los datos anteriores. No inventes artículos, números, fechas ni redacciones. Si algo no se puede determinar, escribe "no consta".' + LF +
    '- afectaTemario=true solo si la norma crea, modifica, deroga o actualiza contenido que encaja de verdad en algún tema concreto del temario. Si no, false.' + LF +
    '- tema: formato "Materia – Tema N: título" tomado del temario (ej. "Civil – Tema 55: Arrendamientos urbanos (I)"). Si afecta a varios, sepáralos con " ; ". Indica en puntoTemario el aspecto concreto del tema afectado.' + LF +
    '- articulos: artículos concretos afectados (ej. "art. 20 ter del Real Decreto 1183/2020"), basándote primero en REFERENCIAS ANTERIORES.' + LF +
    '- accion: MODIFICA, AÑADE, DEROGA o NUEVA NORMA. normasAfectadas: qué norma(s) afecta.' + LF +
    '- cambios: por artículo, redaccionAnterior y redaccionNueva SOLO si el texto del BOE las incluye; si no, "no consta".' + LF +
    '- importancia: entero de 1 (marginal) a 5 (fundamental para el examen).' + LF +
    '- entradaVigor y regimenTransitorio: según el texto; si no consta, "no consta".' + LF +
    '- NOMBRES DE NORMAS SIN ABREVIATURAS: cada vez que cites una norma (en normasAfectadas, articulos, cambios y cualquier texto) escribe su denominación oficial COMPLETA, con número, fecha y título, tal como aparece en REFERENCIAS ANTERIORES o en el texto (ej. "Real Decreto 396/2006, de 31 de marzo, por el que se establecen las disposiciones mínimas de seguridad y salud aplicables a los trabajos con riesgo de exposición al amianto"). Nunca uses siglas como RD, RDL, LO, LEC, LRJSP o TRLGSS.' + LF +
    '- tipoNumero: rango, número y fecha completos, sin abreviar (ej. "Real Decreto 847/2026, de 21 de octubre").' + LF +
    '- Redacta en español jurídico claro y conciso.';
  const norma = {
    type: 'OBJECT',
    properties: {
      id: { type: 'STRING' }, afectaTemario: { type: 'BOOLEAN' }, importancia: { type: 'INTEGER' },
      tipoNumero: { type: 'STRING' }, accion: { type: 'STRING' }, normasAfectadas: { type: 'STRING' },
      articulos: { type: 'ARRAY', items: { type: 'STRING' } },
      tema: { type: 'STRING' }, puntoTemario: { type: 'STRING' }, porQueAfecta: { type: 'STRING' },
      queEs: { type: 'STRING' }, entradaVigor: { type: 'STRING' }, regimenTransitorio: { type: 'STRING' },
      cambios: { type: 'ARRAY', items: { type: 'OBJECT', properties: { articulo: { type: 'STRING' }, redaccionAnterior: { type: 'STRING' }, redaccionNueva: { type: 'STRING' }, resumen: { type: 'STRING' } }, required: ['articulo', 'resumen'] } },
    },
    required: ['id', 'afectaTemario', 'importancia', 'tipoNumero', 'accion', 'normasAfectadas', 'articulos', 'tema', 'puntoTemario', 'porQueAfecta', 'queEs', 'entradaVigor', 'regimenTransitorio', 'cambios'],
  };
  return { contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.1, responseMimeType: 'application/json', responseSchema: { type: 'OBJECT', properties: { normas: { type: 'ARRAY', items: norma } }, required: ['normas'] } } };
}

// ---------- 4. PDF con Chrome ----------
export function generarPdf(html, nombre) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boe-'));
  const htmlPath = path.join(dir, 'informe.html');
  const pdfPath = path.join(dir, nombre);
  fs.writeFileSync(htmlPath, html);
  const chrome = process.env.CHROME_BIN || 'google-chrome';
  execFileSync(chrome, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-pdf-header-footer', '--print-to-pdf=' + pdfPath, 'file://' + htmlPath], { stdio: 'pipe', timeout: 120000 });
  return fs.readFileSync(pdfPath);
}

// ---------- 5. Email ----------
const transporte = () => nodemailer.createTransport({
  host: 'smtp.gmail.com', port: 465, secure: true,
  auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
});

async function enviar({ to, subject, html, attachments }) {
  let ultimo;
  for (let i = 1; i <= 3; i++) {
    try {
      const info = await transporte().sendMail({ from: '"Resumen BOE" <' + process.env.GMAIL_USER + '>', to, subject, html, attachments });
      log('Email enviado a ' + quien(to) + ' (' + info.messageId + ')');
      nota('Email enviado a ' + quien(to) + ': ' + subject);
      return;
    } catch (e) { ultimo = e; log('Fallo al enviar email (intento ' + i + '): ' + e.message); await esperar(5000); }
  }
  throw ultimo;
}

async function avisarError(mensaje, fecha) {
  const run = process.env.GITHUB_RUN_ID ? process.env.GITHUB_SERVER_URL + '/' + process.env.GITHUB_REPOSITORY + '/actions/runs/' + process.env.GITHUB_RUN_ID : '';
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  try {
    await enviar({
      to: cfg.emailAvisos,
      subject: 'Error en el Resumen diario del BOE (' + fecha.slice(6, 8) + '/' + fecha.slice(4, 6) + '/' + fecha.slice(0, 4) + ')',
      html: '<div style="font-family:Arial,sans-serif"><h3>El resumen del BOE de hoy ha fallado</h3><p>No se ha enviado el resumen a la destinataria.</p>' +
        (run ? '<p><a href="' + run + '">Ver la ejecución en GitHub</a></p>' : '') +
        '<pre style="white-space:pre-wrap;background:#f5f5f5;padding:8px">' + esc(mensaje).slice(0, 4000) + '</pre></div>',
    });
  } catch (e) { log('No se pudo enviar el aviso de error: ' + e.message); }
}

function avisoModeloEmergencia(sumarioUrl) {
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:0 auto 10px;background:#fff4e0;border:1px solid #f2c27a;color:#6b4300;border-radius:8px;padding:10px 14px;font-size:14px;line-height:1.45">' +
    '<b>Aviso:</b> hoy los modelos principales de Gemini estaban saturados y este resumen lo ha preparado el modelo de emergencia, que es menos fino. ' +
    'Puede que se le haya escapado alguna norma: conviene echar un vistazo al <a href="' + sumarioUrl + '" style="color:#6b4300;font-weight:bold">sumario del BOE de hoy</a>.</div>';
}

// ---------- Programa principal ----------
function marcarDia(fecha, programada, modoPrueba) {
  if (!programada || modoPrueba) return;
  fs.mkdirSync(path.dirname(ESTADO), { recursive: true });
  fs.writeFileSync(ESTADO, fecha + LF);
}

async function procesar({ fecha, destinatario, aceptarEmergencia = true }) {
  const sumario = await descargarSumario(fecha);
  if (!sumario) return 'sin-boe';
  const rows = extraerCandidatas(sumario);
  log(rows.length + ' disposiciones candidatas (secciones I, III y T)');
  nota('BOE ' + fecha + ': ' + rows.length + ' disposiciones candidatas');
  const fechaTxt = fecha.slice(6, 8) + '/' + fecha.slice(4, 6) + '/' + fecha.slice(0, 4);

  // Si una etapa solo la ha podido hacer el modelo de emergencia y aún hay tiempo, mejor reintentar luego
  let emergencia = false;
  const comprobarModelo = (r, etapa) => {
    if (r.modelo !== EMERGENCIA) return;
    if (!aceptarEmergencia) throw new SoloEmergencia('La ' + etapa + ' solo la ha podido hacer el modelo de emergencia (' + EMERGENCIA + ')');
    emergencia = true;
  };

  let relevantes = [];
  if (rows.length) {
    const pre = await gemini(cuerpoPreseleccion(rows), 'preselección');
    comprobarModelo(pre, 'preselección');
    relevantes = procesarPreseleccion(pre.parsed, rows);
  }
  log(relevantes.length + ' normas preseleccionadas: ' + relevantes.map((r) => r.id).join(', '));

  let maq = null;
  if (relevantes.length) {
    const docs = [];
    for (const r of relevantes) {
      const resp = await pedir('https://www.boe.es/diario_boe/xml.php?id=' + r.id, {}, { intentos: 3, espera: 5000 });
      const d = resp.status === 404 ? null : leerXml(await resp.text());
      if (d) docs.push(d);
      await esperar(1500);
    }
    if (!docs.length) throw new Error('No se pudo leer ningún XML de las disposiciones preseleccionadas');
    await esperar((Number(cfg.esperaSegundos) || 6) * 1000);
    const an = await gemini(cuerpoAnalisis(docs), 'análisis', cfg.timeoutAnalisisSegundos || cfg.timeoutGeminiSegundos);
    comprobarModelo(an, 'análisis');
    const meta = docs.map((d) => ({ id: d.id, url: d.url, titulo: d.titulo, rango: d.rango, numero: d.numero, fechaVigencia: d.fechaVigencia, recortado: d.recortado }));
    maq = maquetar({ parsed: an.parsed, meta, fechaBoe: fecha, emergencia });
  }
  const sumarioUrl = 'https://www.boe.es/boe/dias/' + fecha.slice(0, 4) + '/' + fecha.slice(4, 6) + '/' + fecha.slice(6, 8) + '/';
  const avisoEmergencia = emergencia ? avisoModeloEmergencia(sumarioUrl) : '';
  if (emergencia) nota('Se envía con el aviso de modelo de emergencia', 'warning');

  if (!maq || !maq.count) {
    await enviar({
      to: destinatario,
      subject: 'BOE ' + fechaTxt + ' – 0 novedades del temario',
      html: '<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:auto">' + avisoEmergencia + '<h2>BOE ' + fechaTxt + ' – 0 novedades del temario</h2><p>Hoy el BOE no contiene disposiciones que afecten al temario de Abogados del Estado.</p></div>',
    });
  } else {
    const fechaIso = fecha.slice(0, 4) + '-' + fecha.slice(4, 6) + '-' + fecha.slice(6, 8);
    let adjunto, avisoPdf = '';
    try {
      adjunto = { filename: 'Desarrollo-BOE-' + fechaIso + '.pdf', content: generarPdf(maq.pdfHtml, 'Desarrollo-BOE-' + fechaIso + '.pdf'), contentType: 'application/pdf' };
    } catch (e) {
      log('No se pudo generar el PDF: ' + e.message);
      nota('No se pudo generar el PDF, se adjunta HTML: ' + e.message, 'warning');
      adjunto = { filename: 'Desarrollo-BOE-' + fechaIso + '.html', content: maq.pdfHtml, contentType: 'text/html' };
      avisoPdf = '<p style="background:#fff3cd;padding:6px;font-family:Arial">Aviso: no se pudo generar el PDF; se adjunta el desarrollo en HTML (ábrelo en el navegador).</p>';
    }
    await enviar({ to: destinatario, subject: maq.subject, html: avisoPdf + avisoEmergencia + maq.emailHtml, attachments: [adjunto] });
  }
  return 'enviado';
}

export async function main() {
  const programada = process.env.EJECUCION_PROGRAMADA === 'true';
  const inicio = ahoraMadrid();
  const fecha = (process.env.FECHA || '').trim() || inicio.fecha;
  const modoPrueba = String(process.env.MODO_PRUEBA || cfg.modoPrueba).toLowerCase() === 'true';
  const destinatario = modoPrueba ? cfg.emailPrueba : cfg.emailDestino;
  log('BOE ' + fecha + ' · hora Madrid ' + inicio.hora + ' · ' + (programada ? 'programada' : 'manual') + ' · para ' + quien(destinatario));

  // Ejecución manual (pruebas o envíos excepcionales): un solo intento, inmediato.
  if (!programada) {
    try {
      const r = await procesar({ fecha, destinatario });
      if (r === 'sin-boe') { nota('El BOE de ' + fecha + ' no está publicado (404)', 'warning'); log('El BOE de ' + fecha + ' no está publicado (404).'); }
      else log('Terminado correctamente.');
    } catch (e) {
      log('ERROR: ' + (e.stack || e.message)); nota('ERROR: ' + e.message, 'error');
      await avisarError(e.message, fecha); process.exitCode = 1;
    }
    return;
  }

  // Ejecución programada: espera a la hora de envío y reintenta hasta la hora límite.
  if (inicio.minutos < aMinutos(cfg.horaMinima)) { nota('Demasiado pronto (' + inicio.hora + '); lo hará la siguiente ejecución'); log('Todavía es pronto.'); return; }
  const ultimo = fs.existsSync(ESTADO) ? fs.readFileSync(ESTADO, 'utf8').trim() : '';
  if (ultimo === fecha) { nota('El resumen de hoy ya estaba enviado'); log('El resumen de hoy ya se envió. Nada que hacer.'); return; }

  const envio = aMinutos(cfg.horaEnvio), limite = aMinutos(cfg.horaLimite);
  if (inicio.minutos < envio) {
    const min = envio - inicio.minutos;
    log('Esperando ' + min + ' min hasta las ' + cfg.horaEnvio + ' (hora de Madrid)...');
    await esperar(min * 60000);
  }

  let ultimoError = null;
  let yaEsperoEmergencia = false;
  for (let intento = 1; ; intento++) {
    try {
      // El modelo de emergencia se acepta si ya se esperó una vez o si es tarde (horaAceptarEmergencia)
      const aceptarEmergencia = yaEsperoEmergencia || ahoraMadrid().minutos >= aMinutos(cfg.horaAceptarEmergencia || '08:45');
      const r = await procesar({ fecha, destinatario, aceptarEmergencia });
      if (r === 'enviado') { marcarDia(fecha, programada, modoPrueba); log('Terminado correctamente.'); return; }
      ultimoError = new Error('El BOE de hoy no está publicado todavía en la API oficial (404).');
      log('El BOE de ' + fecha + ' aún no está publicado (404).');
    } catch (e) {
      if (e instanceof SoloEmergencia) {
        yaEsperoEmergencia = true;
        const hasta = aMinutos(cfg.horaAceptarEmergencia || '08:45') - ahoraMadrid().minutos;
        const min = Math.max(0, Math.min(Number(cfg.minutosEsperaEmergencia) || 10, hasta));
        nota(e.message + '. Se reintenta con los modelos principales en ' + min + ' min', 'warning');
        log(e.message + '. Reintento en ' + min + ' min.');
        await esperar(min * 60000);
        continue;
      }
      ultimoError = e;
      log('ERROR (intento ' + intento + '): ' + (e.stack || e.message));
    }
    const ahora = ahoraMadrid().minutos;
    if (ahora + cfg.minutosEntreReintentos > limite) break;
    nota('Intento ' + intento + ' fallido (' + ultimoError.message.split('\n')[0] + '); se reintenta en ' + cfg.minutosEntreReintentos + ' min', 'warning');
    await esperar(cfg.minutosEntreReintentos * 60000);
  }
  nota('ERROR: ' + ultimoError.message, 'error');
  await avisarError(ultimoError.message + '\n\n(Se ha reintentado hasta las ' + cfg.horaLimite + '.)', fecha);
  marcarDia(fecha, programada, modoPrueba); // no se insiste más hoy
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main();
}
