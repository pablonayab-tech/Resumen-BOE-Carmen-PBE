// Maqueta el email (resumen esquemático) y el PDF (desarrollo) a partir del análisis de Gemini.
// Es el mismo diseño que el nodo "Maquetar informe" de n8n.

export function maquetar({ parsed, meta, fechaBoe, emergencia = false }) {
  const y = Number(fechaBoe.slice(0, 4)), mo = Number(fechaBoe.slice(4, 6)), d = Number(fechaBoe.slice(6, 8));
  const fecha = fechaBoe.slice(6, 8) + '/' + fechaBoe.slice(4, 6) + '/' + fechaBoe.slice(0, 4);
  const fechaLargaRaw = new Date(Date.UTC(y, mo - 1, d, 12)).toLocaleDateString('es-ES', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Madrid' });
  const fechaLarga = fechaLargaRaw.charAt(0).toUpperCase() + fechaLargaRaw.slice(1);
  const esc = (s) => String(s === undefined || s === null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const byId = {};
  for (const m of meta) byId[m.id] = m;
  const normas = (parsed.normas || []).filter((n) => n.afectaTemario && byId[n.id]);
  const n = normas.length;
  const subject = 'BOE ' + fecha + ' – ' + n + (n === 1 ? ' novedad' : ' novedades') + ' del temario';

  // ---------- Utilidades de diseño ----------
  const COLORES = {
    nueva: { fondo: '#e6f4ea', texto: '#1e6b34', borde: '#34a853' },
    modifica: { fondo: '#fff4e0', texto: '#8a5300', borde: '#f29900' },
    deroga: { fondo: '#fde8e8', texto: '#a3221b', borde: '#d93025' },
    anade: { fondo: '#e8f0fe', texto: '#1a4f8b', borde: '#4285f4' },
    otra: { fondo: '#eef1f5', texto: '#3c4652', borde: '#8a96a3' },
  };
  const tipoAccion = (a) => {
    const t = String(a || '').toUpperCase();
    if (t.includes('DEROGA')) return 'deroga';
    if (t.includes('MODIFICA')) return 'modifica';
    if (t.includes('AÑADE') || t.includes('ANADE')) return 'anade';
    if (t.includes('NUEVA')) return 'nueva';
    return 'otra';
  };
  const etiquetaAccion = (a) => {
    const k = tipoAccion(a);
    return { nueva: 'NUEVA NORMA', modifica: 'MODIFICA', deroga: 'DEROGA', anade: 'AÑADE', otra: 'OTRA' }[k];
  };
  const badge = (a) => {
    const c = COLORES[tipoAccion(a)];
    return '<span class="badge" style="background:' + c.fondo + ';color:' + c.texto + ';border-color:' + c.borde + '">' + etiquetaAccion(a) + '</span>';
  };
  const puntos = (v) => {
    const k = Math.max(0, Math.min(5, Number(v) || 0));
    let s = '';
    for (let i = 1; i <= 5; i++) s += '<span class="dot' + (i <= k ? ' on' : '') + '"></span>';
    return '<span class="dots" title="Importancia ' + k + '/5">' + s + '</span>';
  };
  // ---------- Orden: 1º materia (orden del temario), 2º color (verde, azul, naranja, rojo), 3º importancia ----------
  const MATERIAS = [
    ['CIVIL', 'Derecho Civil'],
    ['HIPOTECARIO', 'Derecho Hipotecario'],
    ['PROCESAL', 'Derecho Procesal'],
    ['MERCANTIL', 'Derecho Mercantil'],
    ['TRABAJO', 'Derecho del Trabajo'],
    ['CONSTITUCIONAL', 'Derecho Constitucional'],
    ['ADMINISTRATIVO', 'Derecho Administrativo'],
    ['FINANCIERO', 'Derecho Financiero y Tributario'],
    ['TRIBUTARIO', 'Derecho Financiero y Tributario'],
    ['INTERNACIONAL', 'Derecho Internacional Público y de la UE'],
    ['UNIÓN EUROPEA', 'Derecho Internacional Público y de la UE'],
    ['PENAL', 'Derecho Penal'],
  ];
  const materiaDe = (x) => {
    const t = String(x.tema || '').toUpperCase();
    const prefijo = t.split(/\s[–—-]\s|:/)[0];
    for (const zona of [prefijo, t]) {
      for (let i = 0; i < MATERIAS.length; i++) if (zona.includes(MATERIAS[i][0])) return { idx: i, nombre: MATERIAS[i][1] };
    }
    return { idx: 99, nombre: 'Otras materias' };
  };
  const ORDEN_COLOR = { nueva: 0, anade: 1, modifica: 2, otra: 3, deroga: 4 };
  normas.sort((a, b) => {
    const ma = materiaDe(a), mb = materiaDe(b);
    if (ma.nombre !== mb.nombre) return ma.idx - mb.idx;
    const ca = ORDEN_COLOR[tipoAccion(a.accion)], cb = ORDEN_COLOR[tipoAccion(b.accion)];
    if (ca !== cb) return ca - cb;
    return (b.importancia || 0) - (a.importancia || 0);
  });

  // Denominación oficial completa (con su "apellido"), sin abreviaturas
  const nombreCompleto = (x) => {
    const t = String((byId[x.id] || {}).titulo || '').trim().replace(/\.$/, '');
    return t || String(x.tipoNumero || '');
  };

  const noConsta = (s) => !s || String(s).trim().toLowerCase() === 'no consta';

  // ---------- EMAIL (cuerpo esquemático) ----------
  const lbl = 'font-weight:bold;color:#5a6472;font-size:12px;text-transform:uppercase;letter-spacing:.4px';
  let email = '<div style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:auto;font-size:15px;line-height:1.45;color:#1f2933">';
  email += '<div style="background:#14284b;color:#ffffff;padding:16px 18px;border-radius:10px 10px 0 0">';
  email += '<div style="font-size:12px;letter-spacing:1px;text-transform:uppercase;opacity:.8">Resumen diario del BOE · Abogados del Estado</div>';
  email += '<div style="font-size:22px;font-weight:bold;margin-top:4px">' + esc(fecha) + ' · ' + n + (n === 1 ? ' novedad' : ' novedades') + '</div></div>';
  email += '<div style="border:1px solid #d9e1ec;border-top:0;border-radius:0 0 10px 10px;padding:6px 16px 14px">';
  if (!n) email += '<p>Hoy el BOE no contiene novedades que afecten al temario.</p>';
  let matEmail = '';
  normas.forEach((x, i) => {
    const u = byId[x.id].url;
    const mE = materiaDe(x).nombre;
    if (mE !== matEmail) { matEmail = mE; email += '<div style="margin:18px 0 0;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;color:#14284b;border-bottom:2px solid #14284b;padding-bottom:3px">' + esc(mE) + '</div>'; }
    const c = COLORES[tipoAccion(x.accion)];
    email += '<div style="border-left:5px solid ' + c.borde + ';padding:10px 12px;margin:14px 0;background:#f7f9fc;border-radius:0 8px 8px 0">';
    email += '<div style="font-size:15px;font-weight:bold;color:#14284b;line-height:1.35">' + (i + 1) + '. ' + esc(nombreCompleto(x)) + '</div><div style="margin-top:6px"><span style="display:inline-block;font-size:11px;padding:2px 8px;border-radius:10px;background:' + c.fondo + ';color:' + c.texto + ';border:1px solid ' + c.borde + ';vertical-align:middle">' + etiquetaAccion(x.accion) + '</span></div>';
    email += '<div style="margin-top:6px"><span style="' + lbl + '">Artículos</span><br>' + esc((x.articulos || []).join('; ') || 'no consta') + '</div>';
    email += '<div style="margin-top:6px"><span style="' + lbl + '">Afecta a</span><br>' + esc(x.normasAfectadas) + '</div>';
    email += '<div style="margin-top:6px"><span style="' + lbl + '">Temario</span><br><b>' + esc(x.tema) + '</b> – ' + esc(x.puntoTemario) + '</div>';
    email += '<div style="margin-top:6px"><span style="' + lbl + '">Entrada en vigor</span><br>' + esc(x.entradaVigor) + '</div>';
    email += '<div style="margin-top:8px"><a href="' + esc(u) + '" style="color:#1a4f8b;font-weight:bold">Ver en el BOE →</a></div></div>';
  });
  if (n) email += '<p style="font-size:13px;color:#5a6472;margin:10px 0 0">El desarrollo completo de cada norma va en el PDF adjunto.</p>';
  email += '</div></div>';

  // ---------- PDF (desarrollo) ----------
  const css = [
    '@page{size:A4;margin:14mm 13mm 16mm}',
    '*{box-sizing:border-box;-webkit-print-color-adjust:exact;print-color-adjust:exact}',
    'body{font-family:"Noto Sans","Liberation Sans",Arial,Helvetica,sans-serif;font-size:12.5px;line-height:1.55;color:#1f2933;margin:0}',
    '.cab{background:#14284b;color:#fff;border-radius:12px;padding:22px 24px;margin-bottom:18px}',
    '.cab .kicker{font-size:11px;letter-spacing:1.5px;text-transform:uppercase;opacity:.75}',
    '.cab h1{font-size:26px;margin:6px 0 2px;font-weight:800}',
    '.cab .fecha{font-size:14px;opacity:.9}',
    '.stats{display:flex;gap:8px;flex-wrap:wrap;margin-top:14px}',
    '.stat{background:rgba(255,255,255,.12);border:1px solid rgba(255,255,255,.25);border-radius:20px;padding:4px 12px;font-size:12px}',
    '.stat b{font-size:14px}',
    '.indice{border:1px solid #d9e1ec;border-radius:10px;padding:12px 16px;margin-bottom:20px;background:#f7f9fc;break-inside:avoid}',
    '.indice h2{font-size:13px;letter-spacing:1px;text-transform:uppercase;color:#5a6472;margin:0 0 8px}',
    '.indice table{width:100%;border-collapse:collapse}',
    '.indice td{padding:6px 4px;border-top:1px solid #e3e9f1;vertical-align:top}',
    '.indice tr:first-child td{border-top:0}',
    '.indice .num{width:26px;font-weight:800;color:#14284b}',
    '.indice .nom{font-weight:700;color:#14284b}',
    '.indice .tem{color:#5a6472;font-size:11.5px}',
    '.card{border:1px solid #d9e1ec;border-radius:12px;margin:0 0 18px;overflow:hidden;break-inside:auto}',
    '.card .top{break-inside:avoid;break-after:avoid;padding:14px 18px 12px;border-left:6px solid #8a96a3;background:#fbfcfe;border-bottom:1px solid #e3e9f1}',
    '.card .fila{display:flex;align-items:center;gap:10px;flex-wrap:wrap}',
    '.circ{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;border-radius:50%;background:#14284b;color:#fff;font-weight:800;font-size:13px}',
    '.card h2{font-size:15px;line-height:1.4;color:#14284b;margin:10px 0 0;font-weight:800}',
    '.badge{display:inline-block;font-size:10.5px;font-weight:800;letter-spacing:.6px;padding:3px 9px;border-radius:12px;border:1px solid}',
    '.dots{display:inline-flex;gap:3px;margin-left:auto}',
    '.dot{width:8px;height:8px;border-radius:50%;background:#d9e1ec;display:inline-block}',
    '.dot.on{background:#14284b}',
    '.titulo{color:#5a6472;font-size:11.5px;margin-top:8px}',
    '.chip{display:inline-block;margin-top:10px;background:#e8f0fe;color:#1a4f8b;border:1px solid #b8cdf5;border-radius:8px;padding:5px 10px;font-weight:700;font-size:12px}',
    '.cuerpo{padding:6px 18px 16px}',
    '.sec{margin-top:12px}',
    '.sec h3{font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:#5a6472;margin:0 0 5px;break-after:avoid}',
    '.cambio{border:1px solid #e3e9f1;border-radius:8px;padding:10px 12px;margin:8px 0;break-inside:avoid}',
    '.cambio .art{font-weight:800;color:#14284b}',
    '.cmp{display:flex;gap:8px;margin-top:8px}',
    '.cmp>div{flex:1;border-radius:6px;padding:8px 10px;font-size:11.5px}',
    '.antes{background:#fdecea;border-left:4px solid #d93025}',
    '.ahora{background:#e6f4ea;border-left:4px solid #34a853}',
    '.cmp b{display:block;font-size:10px;letter-spacing:1px;text-transform:uppercase;margin-bottom:3px}',
    '.tema{background:#f2f6fc;border:1px solid #d6e2f3;border-radius:8px;padding:10px 12px}',
    '.tema .t1{font-weight:800;color:#14284b}',
    '.tema .t3{color:#5a6472;font-style:italic;margin-top:4px}',
    '.vig{display:flex;gap:8px}',
    '.vig>div{flex:1;background:#f7f9fc;border:1px solid #e3e9f1;border-radius:8px;padding:8px 10px}',
    '.vig b{display:block;font-size:10px;letter-spacing:1px;text-transform:uppercase;color:#5a6472}',
    '.nota{margin-top:10px;font-size:11px;color:#8a5300;background:#fff4e0;border-radius:6px;padding:6px 10px}',
    '.link{display:inline-block;margin-top:12px;background:#14284b;color:#fff;text-decoration:none;border-radius:8px;padding:7px 14px;font-weight:700;font-size:12px}',
    '.url{display:block;margin-top:4px;font-size:10px;color:#8a96a3;word-break:break-all}',
    '.mat{font-size:12px;letter-spacing:1.5px;text-transform:uppercase;color:#14284b;font-weight:800;border-bottom:2px solid #14284b;padding-bottom:4px;margin:22px 0 12px;break-after:avoid}','.indice .imat td{padding-top:10px;font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:#14284b;font-weight:800;border-top:0}','.vacio{text-align:center;color:#5a6472;padding:30px;border:1px dashed #d9e1ec;border-radius:12px}',
    '.pie{margin-top:18px;font-size:10px;color:#8a96a3;text-align:center}',
  ].join('');

  const cuenta = { nueva: 0, modifica: 0, deroga: 0, anade: 0, otra: 0 };
  normas.forEach((x) => { cuenta[tipoAccion(x.accion)]++; });

  let pdf = '<!DOCTYPE html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Desarrollo BOE ' + esc(fecha) + '</title><style>' + css + '</style></head><body>';

  // Cabecera
  pdf += '<div class="cab"><div class="kicker">Boletín Oficial del Estado · Oposición a Abogados del Estado</div>';
  pdf += '<h1>Novedades del temario</h1><div class="fecha">' + esc(fechaLarga) + '</div>';
  pdf += '<div class="stats"><span class="stat"><b>' + n + '</b> ' + (n === 1 ? 'norma' : 'normas') + '</span>';
  if (cuenta.nueva) pdf += '<span class="stat"><b>' + cuenta.nueva + '</b> nuevas</span>';
  if (cuenta.modifica) pdf += '<span class="stat"><b>' + cuenta.modifica + '</b> modifican</span>';
  if (cuenta.deroga) pdf += '<span class="stat"><b>' + cuenta.deroga + '</b> derogan</span>';
  if (cuenta.anade) pdf += '<span class="stat"><b>' + cuenta.anade + '</b> añaden</span>';
  pdf += '</div></div>';
  if (emergencia) pdf += '<div class="nota" style="font-size:12px;margin:0 0 16px">Aviso: hoy los modelos principales de Gemini no estaban disponibles (saturados o sin cupo) y este desarrollo lo ha preparado el modelo de emergencia, que es menos fino. Puede que se le haya escapado alguna norma o algún detalle: conviene revisar el sumario del BOE del día.</div>';

  if (!n) {
    pdf += '<div class="vacio">Hoy el BOE no contiene novedades que afecten al temario.</div>';
  } else {
    // Índice
    pdf += '<div class="indice"><h2>Índice del día</h2><table>';
    let matIdx = '';
    normas.forEach((x, i) => {
      const mI = materiaDe(x).nombre;
      if (mI !== matIdx) { matIdx = mI; pdf += '<tr class="imat"><td colspan="2">' + esc(mI) + '</td></tr>'; }
      pdf += '<tr><td class="num">' + (i + 1) + '</td><td><div class="nom">' + esc(nombreCompleto(x)) + '</div><div style="margin:3px 0">' + badge(x.accion) + '</div><div class="tem">' + esc(x.tema) + '</div></td></tr>';
    });
    pdf += '</table></div>';

    // Fichas
    let matCard = '';
    normas.forEach((x, i) => {
      const mm = byId[x.id];
      const c = COLORES[tipoAccion(x.accion)];
      const mC = materiaDe(x).nombre;
      if (mC !== matCard) { matCard = mC; pdf += '<div class="mat">' + esc(mC) + '</div>'; }
      pdf += '<div class="card"><div class="top" style="border-left-color:' + c.borde + '">';
      pdf += '<div class="fila"><span class="circ">' + (i + 1) + '</span>' + badge(x.accion) + puntos(x.importancia) + '</div>';
      pdf += '<h2>' + esc(nombreCompleto(x)) + '</h2>';
      pdf += '<div class="chip">' + esc(x.tema) + '</div></div>';
      pdf += '<div class="cuerpo">';
      pdf += '<div class="sec"><h3>Qué es y su objetivo</h3><div>' + esc(x.queEs) + '</div></div>';
      pdf += '<div class="sec"><h3>Normas afectadas</h3><div>' + esc(x.normasAfectadas || 'no consta') + '</div></div>';
      pdf += '<div class="sec"><h3>Qué cambia, artículo por artículo</h3>';
      if ((x.cambios || []).length) {
        x.cambios.forEach((ch) => {
          pdf += '<div class="cambio"><div class="art">' + esc(ch.articulo) + '</div><div>' + esc(ch.resumen) + '</div>';
          const ant = !noConsta(ch.redaccionAnterior);
          const nue = !noConsta(ch.redaccionNueva);
          if (ant || nue) {
            pdf += '<div class="cmp">';
            if (ant) pdf += '<div class="antes"><b>Antes</b>' + esc(ch.redaccionAnterior) + '</div>';
            if (nue) pdf += '<div class="ahora"><b>Ahora</b>' + esc(ch.redaccionNueva) + '</div>';
            pdf += '</div>';
          }
          pdf += '</div>';
        });
      } else {
        pdf += '<div>' + esc((x.articulos || []).join('; ') || 'no consta') + '</div>';
      }
      pdf += '</div>';
      pdf += '<div class="sec"><h3>Temario afectado</h3><div class="tema"><div class="t1">' + esc(x.tema) + '</div><div>' + esc(x.puntoTemario) + '</div>';
      if (!noConsta(x.porQueAfecta)) pdf += '<div class="t3">' + esc(x.porQueAfecta) + '</div>';
      pdf += '</div></div>';
      pdf += '<div class="sec"><h3>Vigencia</h3><div class="vig"><div><b>Entrada en vigor</b>' + esc(x.entradaVigor || 'no consta') + '</div><div><b>Régimen transitorio</b>' + esc(x.regimenTransitorio || 'no consta') + '</div></div></div>';
      if (mm.recortado) pdf += '<div class="nota">Nota: el texto de la norma se analizó recortado por su longitud; conviene revisar el original.</div>';
      pdf += '<a class="link" href="' + esc(mm.url) + '">Abrir en el BOE →</a><span class="url">' + esc(mm.url) + '</span>';
      pdf += '</div></div>';
    });
  }

  pdf += '<div class="pie">Generado automáticamente a partir del BOE del ' + esc(fecha) + '. "No consta" indica que el texto oficial no lo especifica.</div>';
  pdf += '</body></html>';
  return { subject, emailHtml: email, pdfHtml: pdf, count: n };
}
