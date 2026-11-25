// ─── CONTABILIDAD FOXPRO: importar el Mayor de Cuentas directo desde el PDF ───
// Todo corre en el navegador (pdf.js). No hace falta convertir a Excel:
// se lee el PDF, se valida cuenta por cuenta contra "Totales mes" y, si
// todo cierra, se guarda en public.movimientos_mayores reemplazando el mes
// (mismo formato que ya usa importarMayores(), para que Fondos/Plazos/analisis
// sigan andando igual).

if (typeof pdfjsLib !== 'undefined') {
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
}

let _fxArchivos = [];      // File[] pendientes de procesar
let _fxResultados = [];    // resultado del parseo/validación por archivo

// ─── 1. EXTRAER TEXTO DEL PDF, RESPETANDO LA POSICIÓN REAL DE CADA PALABRA ───
// pdf.js no entrega "líneas" como pdftotext -layout: entrega cada palabra
// con su posición (x,y) en la página. Agrupar por "y" redondeado puede
// partir una misma línea en dos si dos textos de esa línea tienen un y
// levemente distinto (pasa con fuentes en negrita/distinto tamaño, como el
// encabezado "Cuenta: 11101 00000 Caja"). Por eso agrupamos por cercanía
// real (barrido), no por un redondeo fijo.
async function _fxReconstruirLineas(doc){
  const lineas = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items = content.items
      .filter(i => i.str.trim())
      .map(i => ({ x: i.transform[4], y: i.transform[5], str: i.str }));
    items.sort((a,b) => b.y - a.y);
    let fila = [], yRef = null;
    const TOL = 2.5;
    for (const it of items) {
      if (yRef === null || Math.abs(it.y - yRef) <= TOL) {
        fila.push(it);
        yRef = fila.reduce((s,x)=>s+x.y,0) / fila.length;
      } else {
        lineas.push(_fxArmarLinea(fila));
        fila = [it]; yRef = it.y;
      }
    }
    if (fila.length) lineas.push(_fxArmarLinea(fila));
  }
  return lineas;
}
function _fxArmarLinea(fila){
  return fila.sort((a,b)=>a.x-b.x).map(i=>i.str.trim()).filter(Boolean).join(' ');
}

function _fxNum(s){
  s = (s||'').trim();
  if (!s) return 0;
  if (s.includes('*')) return null; // overflow de FoxPro: nunca tomarlo como 0
  return parseFloat(s.replace(/,/g,''));
}

// ─── 2. DETECTAR EL PERÍODO (mes/año) LEYENDO LAS FECHAS DEL ENCABEZADO ───
// No dependemos del nombre del archivo: buscamos específicamente la línea
// "MAYOR DE CUENTAS dd/mm/aaaa AL dd/mm/aaaa" que imprime el propio PDF.
// Ojo: la línea anterior ("DISTRIBUIDORA dd/mm/aaaa") es la fecha en que
// se emitió el reporte, NO el período — si se toma la primera fecha de
// todo el encabezado se detecta mal el mes.
function _fxDetectarPeriodo(lineas){
  const lineaMayor = lineas.find(l => l.includes('MAYOR DE CUENTAS'));
  if (!lineaMayor) return null;
  const fechas = lineaMayor.match(/\d\d\/\d\d\/\d{4}/g);
  if (!fechas || !fechas.length) return null;
  const [dd, mm, aaaa] = fechas[0].split('/');
  return { periodo: mm + '-' + aaaa, mesNum: parseInt(mm), anio: parseInt(aaaa) };
}

// ─── 3. PARSEAR LAS CUENTAS Y SUS MOVIMIENTOS ───
// El concepto puede venir VACÍO (FoxPro imprime esa línea sin texto entre
// el asiento y los importes — pasó en mayo/2026, cuenta 11201, asiento
// "7854 -"). Por eso NO usamos un regex que exija texto ahí: partimos la
// línea en columnas por posición (fecha, asiento, "-", ...concepto..., debe,
// haber, saldo) — el concepto son las palabras que quedan en el medio,
// y puede ser ninguna.
const _fxReCuenta = /^Cuenta: (\d{5}) (\d{5}) (.+)$/;
const _fxReNumero = /^-?[\d,]+\.\d\d$|^-?\*+,?\*+\.\*\*$/;

function _fxParsearLineaMov(l){
  if (!/^\d\d\/\d\d\/\d{4}\s/.test(l)) return null;
  const partes = l.split(' ');
  if (partes.length < 6 || partes[2] !== '-') return null;
  const fechaStr = partes[0], asientoStr = partes[1];
  const saldoStr = partes[partes.length-1];
  const haberStr = partes[partes.length-2];
  const debeStr = partes[partes.length-3];
  if (!_fxReNumero.test(debeStr) || !_fxReNumero.test(haberStr)) return null;
  const concepto = partes.slice(3, partes.length-3).join(' ').trim();
  return { fechaStr, asientoStr, concepto, debeStr, haberStr };
}

function _fxParsearMayor(lineas){
  const cuentas = [];
  const avisos = [];
  let cur = null;
  for (const l of lineas) {
    const mc = l.match(_fxReCuenta);
    if (mc) {
      cur = { cod: mc[1], sub: mc[2], nombre: mc[3].trim(), movs: [], totMes: null };
      cuentas.push(cur);
      continue;
    }
    if (!cur) continue;
    const mm = _fxParsearLineaMov(l);
    if (mm) {
      const { fechaStr, asientoStr, concepto, debeStr, haberStr } = mm;
      const [dd, mo, aa] = fechaStr.split('/');
      const fecha = new Date(parseInt(aa), parseInt(mo)-1, parseInt(dd)).toISOString().split('T')[0];
      const debe = _fxNum(debeStr), haber = _fxNum(haberStr);
      if (debe === null || haber === null) {
        avisos.push(`${cur.nombre}: movimiento del ${fechaStr} (asiento ${asientoStr}) con Debe/Haber ilegible (asteriscos) — revisar a mano`);
        continue;
      }
      const conceptoFinal = concepto ? concepto.toUpperCase() : 'SIN CONCEPTO';
      if (!concepto) avisos.push(`${cur.nombre}: movimiento del ${fechaStr} (asiento ${asientoStr}) sin concepto en el PDF — se guardó igual como "SIN CONCEPTO"`);
      cur.movs.push({ fecha, asiento: parseInt(asientoStr), concepto: conceptoFinal, debe, haber });
      continue;
    }
    if (l.startsWith('Totales mes')) {
      const nums = l.replace('Totales mes','').trim().split(/\s+/).map(_fxNum);
      cur.totMes = nums;
      continue;
    }
    // Línea que empieza con fecha pero no matcheó ningún patrón conocido:
    // en vez de perderla en silencio, se avisa (así nunca vuelve a pasar
    // lo de mayo sin que se note).
    if (/^\d\d\/\d\d\/\d{4}\s/.test(l)) {
      avisos.push(`${cur.nombre}: línea con formato inesperado, no se pudo leer: "${l}"`);
    }
  }
  return { cuentas, avisos };
}

// ─── 4. VALIDAR CADA CUENTA CONTRA "Totales mes" DEL PROPIO PDF ───
// Ojo: en cuentas con mucho movimiento (ej. Deudores por Ventas, Bienes de
// Cambio) el propio PDF imprime el Debe y/o el Haber de "Totales mes" tapado
// con asteriscos (overflow de FoxPro) — no es solo la columna Saldo, como
// podría pensarse. En ese caso, el tercer número de esa línea (la variación
// neta: Debe-Haber) casi siempre sí se puede leer, y lo usamos como respaldo.
// A veces (cuentas MUY grandes, ej. Bienes de Cambio) ni siquiera ese tercer
// número se salva: ahí no hay ningún valor del PDF contra el cual comparar.
// Eso NO es lo mismo que "está mal" — es "FoxPro no imprimió nada para
// chequear". Lo marcamos como "sin_verificar", distinto de un error real
// ("no_cierra"), y se lo mostramos aparte al usuario para que decida.
// estado: 'ok' | 'sin_verificar' | 'no_cierra'
function _fxValidarCuentas(cuentas){
  return cuentas.map(c => {
    const debe = c.movs.reduce((s,m)=>s+m.debe, 0);
    const haber = c.movs.reduce((s,m)=>s+m.haber, 0);
    let estado, motivo;
    if (!c.totMes || c.totMes.length < 2) {
      estado = 'no_cierra'; motivo = 'No se encontró la línea "Totales mes" para validar';
    } else if (c.totMes[0] !== null && c.totMes[1] !== null) {
      if (Math.abs(debe - c.totMes[0]) > 0.01 || Math.abs(haber - c.totMes[1]) > 0.01) {
        estado = 'no_cierra'; motivo = `El total calculado no coincide con "Totales mes" del PDF (PDF dice Debe ${_fxFmt(c.totMes[0])} / Haber ${_fxFmt(c.totMes[1])})`;
      } else { estado = 'ok'; motivo = ''; }
    } else if (c.totMes[2] !== null && c.totMes[2] !== undefined) {
      // Debe y/o Haber tapados con asteriscos: validamos por la variación neta.
      const neto = debe - haber;
      if (Math.abs(neto - c.totMes[2]) > 0.01) {
        estado = 'no_cierra'; motivo = `El Debe/Haber de "Totales mes" vino tapado con asteriscos en el PDF, y la variación neta tampoco coincide (PDF dice ${_fxFmt(c.totMes[2])}, calculado ${_fxFmt(neto)})`;
      } else {
        estado = 'ok'; motivo = `Debe/Haber de "Totales mes" venían tapados con asteriscos en el PDF — validado por la variación neta (coincide: ${_fxFmt(c.totMes[2])})`;
      }
    } else {
      estado = 'sin_verificar'; motivo = 'La línea "Totales mes" del PDF viene completamente tapada con asteriscos (Debe, Haber y variación) — FoxPro no imprimió ningún número para verificar esta cuenta. No es un error detectado, pero no se pudo confirmar automáticamente.';
    }
    return { ...c, debe, haber, estado, ok: estado==='ok', motivo };
  });
}

function _fxFmt(n){ return (n==null?'—':n.toLocaleString('es-AR',{minimumFractionDigits:2,maximumFractionDigits:2})); }

// ─── 5. ARMAR EL FORMATO QUE YA USA public.movimientos_mayores ───
// Mismo criterio que importarMayores(): cuenta = "código nombre" recortado
// a 31 caracteres (así una cuenta cargada por PDF queda igual, carácter a
// carácter, a la misma cuenta cargada en meses viejos por Excel — todos los
// cruces de Fondos/Plazos/analisis siguen funcionando sin tocarlos).
function _fxArmarFilas(periodo, cuentas){
  const filas = [];
  const contadores = {};
  for (const c of cuentas) {
    const cuentaStr = (c.cod + ' ' + c.nombre).slice(0,31);
    for (const m of c.movs) {
      const clave = cuentaStr + '|' + m.fecha + '|' + m.asiento + '|' + m.concepto;
      contadores[clave] = (contadores[clave] || 0) + 1;
      filas.push({
        cuenta: cuentaStr, fecha: m.fecha, asiento: m.asiento, concepto: m.concepto,
        debe: m.debe, haber: m.haber, periodo, linea_detalle: contadores[clave]
      });
    }
  }
  return filas;
}

// ─── 6. HANDLERS DE LA PANTALLA ───
function fxDragOver(e){ e.preventDefault(); document.getElementById('fx-drop').style.borderColor='var(--P)'; }
function fxDragLeave(e){ document.getElementById('fx-drop').style.borderColor='var(--brd)'; }
function fxDrop(e){
  e.preventDefault();
  document.getElementById('fx-drop').style.borderColor='var(--brd)';
  const files = Array.from(e.dataTransfer.files).filter(f=>f.type==='application/pdf'||f.name.toLowerCase().endsWith('.pdf'));
  if (files.length) _fxAgregarArchivos(files);
}
function fxSeleccionarArchivos(input){
  const files = Array.from(input.files||[]);
  if (files.length) _fxAgregarArchivos(files);
  input.value = '';
}
function _fxAgregarArchivos(files){
  _fxArchivos.push(...files);
  _fxRenderListaArchivos();
}
function fxQuitarArchivo(i){
  _fxArchivos.splice(i,1);
  _fxRenderListaArchivos();
}
function _fxRenderListaArchivos(){
  const el = document.getElementById('fx-archivos');
  if (!el) return;
  el.innerHTML = _fxArchivos.length ? _fxArchivos.map((f,i)=>
    `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--bg2);border-radius:6px;margin-bottom:4px;font-size:13px">
      <span>📄 ${esc(f.name)}</span>
      <button class="btn sm D" onclick="fxQuitarArchivo(${i})" title="Quitar">✕</button>
    </div>`).join('') : '<div style="font-size:12px;color:var(--txt2)">Sin archivos seleccionados.</div>';
  const btn = document.getElementById('btn-fx-procesar');
  if (btn) btn.disabled = !_fxArchivos.length;
}

async function fxProcesarArchivos(){
  if (!_fxArchivos.length) return;
  const btn = document.getElementById('btn-fx-procesar');
  _bloquearBoton(btn, true, '⏳ Leyendo PDF...');
  _setImportStatus('fx-status', 'loading', 'Extrayendo texto del PDF y validando cuenta por cuenta. No cierres esta pantalla.');
  document.getElementById('fx-preview').innerHTML = '';

  _fxResultados = [];
  try {
    for (const file of _fxArchivos) {
      const data = new Uint8Array(await file.arrayBuffer());
      const doc = await pdfjsLib.getDocument({ data }).promise;
      const lineas = await _fxReconstruirLineas(doc);
      const periodoInfo = _fxDetectarPeriodo(lineas);
      if (!periodoInfo) {
        _fxResultados.push({ archivo: file.name, error: 'No se pudo detectar el mes/año en el encabezado del PDF.' });
        continue;
      }
      const { cuentas, avisos } = _fxParsearMayor(lineas);
      if (!cuentas.length) {
        _fxResultados.push({ archivo: file.name, periodo: periodoInfo.periodo, error: 'No se detectó ninguna cuenta ("Cuenta: ...") en el PDF. ¿Es el archivo correcto?' });
        continue;
      }
      const cuentasValidadas = _fxValidarCuentas(cuentas);
      const faltan = Object.entries(CUENTAS_MAYORES_OBLIGATORIAS)
        .filter(([cod]) => !cuentas.some(c=>c.cod===cod))
        .map(([cod,nom]) => `${cod} ${nom}`);
      const sinVerificar = cuentasValidadas.filter(c=>c.estado==='sin_verificar');
      _fxResultados.push({
        archivo: file.name,
        periodo: periodoInfo.periodo,
        mesNum: periodoInfo.mesNum,
        anio: periodoInfo.anio,
        cuentas: cuentasValidadas,
        avisos,
        faltan,
        sinVerificar,
        sePuedeImportar: cuentasValidadas.every(c=>c.estado!=='no_cierra'),
        todoOk: cuentasValidadas.every(c=>c.estado==='ok')
      });
    }
    _fxRenderPreview();
    _setImportStatus('fx-status', '', '');
  } catch(e) {
    console.error(e);
    _setImportStatus('fx-status', 'err', 'Error inesperado leyendo el PDF: ' + (e.message||e));
  } finally {
    _bloquearBoton(btn, false);
  }
}

const _FX_MESES = ['','Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];

function _fxRenderPreview(){
  const el = document.getElementById('fx-preview');
  if (!el) return;
  el.innerHTML = _fxResultados.map((r, idx) => {
    if (r.error) {
      return `<div class="card" style="border:2px solid var(--D);margin-bottom:12px">
        <div style="font-weight:700;color:var(--D)">❌ ${esc(r.archivo)}</div>
        <div style="font-size:13px;margin-top:4px">${esc(r.error)}</div>
      </div>`;
    }
    const mesNombre = (_FX_MESES[r.mesNum]||'?') + ' ' + r.anio;
    const badge = { ok: '<span class="b bP">✅ OK</span>', sin_verificar: '<span class="b bW">❔ Sin verificar</span>', no_cierra: '<span class="b bD">⚠️ No cierra</span>' };
    const filasCuentas = r.cuentas.map(c => `
      <tr>
        <td>${esc(c.cod)}${c.sub!=='00000'?'-'+esc(c.sub):''}</td>
        <td>${esc(c.nombre)}</td>
        <td style="text-align:right">${c.movs.length}</td>
        <td style="text-align:right">${_fxFmt(c.debe)}</td>
        <td style="text-align:right">${_fxFmt(c.haber)}</td>
        <td style="text-align:center">${badge[c.estado]||''}</td>
      </tr>
      ${c.estado!=='ok' && c.motivo ? `<tr><td colspan="6" style="font-size:11px;color:${c.estado==='no_cierra'?'var(--D)':'var(--W)'};padding-top:0">${esc(c.motivo)}</td></tr>` : ''}
      ${c.estado==='ok' && c.motivo ? `<tr><td colspan="6" style="font-size:11px;color:var(--txt2);padding-top:0">ℹ️ ${esc(c.motivo)}</td></tr>` : ''}
    `).join('');
    const color = r.todoOk ? 'var(--P)' : (r.sePuedeImportar ? 'var(--W)' : 'var(--D)');
    return `<div class="card" style="margin-bottom:12px;border:2px solid ${color}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:700">${r.todoOk?'✅':r.sePuedeImportar?'❔':'⚠️'} ${esc(r.archivo)} — ${mesNombre}</div>
        ${r.sePuedeImportar
          ? `<button class="btn P" onclick="fxConfirmarImportacion(${idx})">💾 Confirmar e importar ${mesNombre}</button>`
          : `<span style="color:var(--D);font-weight:600;font-size:13px">No se va a guardar nada de este mes hasta que cierre</span>`}
      </div>
      ${r.faltan.length ? `<div style="font-size:12px;color:var(--W);margin-bottom:8px">⚠️ Faltan en el PDF: ${esc(r.faltan.join(', '))}</div>` : ''}
      ${r.sinVerificar.length ? `<div style="font-size:12px;color:var(--W);margin-bottom:8px">❔ ${r.sinVerificar.length} cuenta(s) sin verificar — el PDF no imprimió números para chequearlas (ver detalle abajo). No es un error detectado, pero conviene mirarlo.</div>` : ''}
      ${r.avisos.length ? `<div style="font-size:12px;color:var(--D);margin-bottom:8px">⚠️ ${r.avisos.map(esc).join('<br>')}</div>` : ''}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Código</th><th>Cuenta</th><th style="text-align:right">Movs</th><th style="text-align:right">Debe</th><th style="text-align:right">Haber</th><th style="text-align:center">Estado</th></tr></thead>
      <tbody>${filasCuentas}</tbody></table></div>
    </div>`;
  }).join('');
}

async function fxConfirmarImportacion(idx){
  const r = _fxResultados[idx];
  if (!r || !r.sePuedeImportar) return;
  const avisoSinVerificar = r.sinVerificar.length
    ? ` Ojo: ${r.sinVerificar.map(c=>c.nombre).join(', ')} no se pudo verificar contra el PDF (FoxPro no imprimió números para esa cuenta) — se va a importar igual, con lo que dice el PDF.`
    : '';
  if (!await _confirmar(`¿Reemplazar los movimientos de ${(_FX_MESES[r.mesNum]||'')} ${r.anio} por los de este PDF?${avisoSinVerificar}`, {titulo:'Confirmar importación', textoOk:'Importar'})) return;

  const filas = _fxArmarFilas(r.periodo, r.cuentas);
  try {
    await sb.from('movimientos_mayores').delete().eq('periodo', r.periodo);
    const batchSize = 500;
    let guardados = 0;
    for (let i=0; i<filas.length; i+=batchSize) {
      const batch = filas.slice(i, i+batchSize);
      const { error } = await sb.from('movimientos_mayores').insert(batch);
      if (!error) { guardados += batch.length; continue; }
      for (const fila of batch) {
        const { error: e2 } = await sb.from('movimientos_mayores').insert(fila);
        if (!e2) guardados++;
      }
    }
    await sb.from('import_mayor_log').insert({
      periodo: r.periodo, archivo: r.archivo, movimientos: guardados,
      cargado_por: usuarioActual?.nombre || '', avisos: r.avisos.concat(r.faltan.map(f=>'Falta cuenta: '+f))
    });
    toast(`✅ ${(_FX_MESES[r.mesNum]||'')} ${r.anio} importado: ${guardados} movimientos`);
    _fxArchivos = _fxArchivos.filter(f=>f.name!==r.archivo);
    _fxResultados.splice(idx,1);
    _fxRenderListaArchivos();
    _fxRenderPreview();
    cargarMesesFoxPro();
  } catch(e) {
    console.error(e);
    toast('❌ Error guardando: '+(e.message||e), 'err', 5000);
  }
}

// ─── 7. LISTA DE MESES YA GUARDADOS ───
async function cargarMesesFoxPro(){
  const el = document.getElementById('fx-meses');
  if (!el) return;
  el.innerHTML = '<div style="font-size:12px;color:var(--txt2)">Cargando...</div>';
  const [{data: movs}, {data: log}] = await Promise.all([
    sb.from('movimientos_mayores').select('periodo'),
    sb.from('import_mayor_log').select('*').order('cargado', {ascending:false})
  ]);
  const conteos = {};
  (movs||[]).forEach(m => { conteos[m.periodo] = (conteos[m.periodo]||0) + 1; });
  const ultimoLogPorPeriodo = {};
  (log||[]).forEach(l => { if (!ultimoLogPorPeriodo[l.periodo]) ultimoLogPorPeriodo[l.periodo] = l; });

  const periodos = Object.keys(conteos).sort((a,b) => {
    const [ma,aa] = a.split('-'), [mb,ab] = b.split('-');
    return (ab+mb.padStart(2,'0')).localeCompare(aa+ma.padStart(2,'0'));
  });
  if (!periodos.length) { el.innerHTML = '<div style="font-size:12px;color:var(--txt2)">Todavía no hay meses cargados.</div>'; return; }

  el.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Mes</th><th style="text-align:right">Movimientos</th><th>Cargado</th><th>Archivo</th></tr></thead><tbody>
    ${periodos.map(p => {
      const [mm,aaaa] = p.split('-');
      const log = ultimoLogPorPeriodo[p];
      const fecha = log ? new Date(log.cargado).toLocaleString('es-AR') : '— (cargado antes de esta pantalla)';
      return `<tr><td>${_FX_MESES[parseInt(mm)]||mm} ${aaaa}</td><td style="text-align:right">${conteos[p]}</td><td style="font-size:12px">${esc(fecha)}</td><td style="font-size:12px">${esc(log?.archivo||'—')}</td></tr>`;
    }).join('')}
  </tbody></table></div>`;
}

// ═══════════════════════════════════════════════════════════════════════
// ─── FASE 2: BALANCE DE SUMAS Y SALDOS ───
// Se guarda en analisis.balance_sumas_saldos — un cajón separado a propósito
// (la API no lo ve directo, solo Power BI por conexión directa). Por eso
// esto no usa sb.from(): llama a una función de la base (fx_guardar_balance)
// que sí tiene permiso de entrar ahí, y de paso devuelve la comparación
// Balance vs Mayor ya calculada.
// ═══════════════════════════════════════════════════════════════════════

let _fxArchivosBalance = [];
let _fxResultadosBalance = [];

// La columna "Acumulado" del balance es UN SOLO TOTAL CORRIENDO de principio
// a fin del documento entero (no se reinicia por rubro ni por sección —
// "Total X" de cada rubro/sección es sencillamente ese mismo total corrido
// hasta ese punto). Cuando una cuenta viene tapada con asteriscos, su valor
// se puede despejar con el próximo "Total" visible más adelante, restando
// lo que ya se sabe que se acumuló antes. Si hay DOS cuentas tapadas
// seguidas sin ningún "Total" visible entre medio, no se pueden separar —
// se avisa en vez de inventar cómo repartir el total entre ellas.
const _FX_GRUPOS_BALANCE = new Set(['ACTIVO','PASIVO','CORRIENTE','NO CORRIENTE','INGRESOS','EGRESOS']);

function _fxDetectarPeriodoBalance(lineas){
  for (const l of lineas) {
    const m = l.match(/(\d\d\/\d\d\/\d{4})\s+AL\s+(\d\d\/\d\d\/\d{4})/);
    if (m) {
      const [dd, mm, aaaa] = m[1].split('/');
      return { periodo: mm+'-'+aaaa, mesNum: parseInt(mm), anio: parseInt(aaaa) };
    }
  }
  return null;
}

function _fxParsearFilaBalance(l){
  const partes = l.trim().split(/\s+/);
  if (partes.length < 6) return null;
  const ultimos5 = partes.slice(-5);
  if (!ultimos5.every(x => _fxReNumero.test(x))) return null;
  const [, acumStr, debeStr, haberStr] = ultimos5;
  const primero = partes[0];
  if (primero === 'Total') return { esTotal: true, acumulado: _fxNum(acumStr) };
  const esMaestra = primero.includes('...');
  const esCodigo = /^\d{5}-\d{5}$/.test(primero);
  if (!esMaestra && !esCodigo) return null;
  let codigo, nota = null;
  if (esMaestra) {
    codigo = 'SIN-COD-MAQ';
    nota = 'El PDF imprime el código como "Maestra..."';
  } else {
    const [cod, sub] = primero.split('-');
    codigo = sub === '00000' ? cod : primero;
  }
  const cuentaNombre = partes.slice(1, partes.length-5).join(' ').trim();
  return { esTotal: false, codigo, cuenta: cuentaNombre, acumulado: _fxNum(acumStr), debe: _fxNum(debeStr), haber: _fxNum(haberStr), nota };
}

function _fxParsearBalance(lineas){
  const cuentas = [];
  const avisos = [];
  let rubroActual = null;
  let corriendo = 0;
  let pendientes = [];
  for (const l of lineas) {
    if (/^\s*CUENTA\s/.test(l)) continue;
    const f = _fxParsearFilaBalance(l);
    if (f) {
      if (f.esTotal) {
        if (f.acumulado !== null) {
          if (pendientes.length === 1) {
            const deducido = f.acumulado - corriendo;
            pendientes[0].acumulado_anterior = deducido;
            pendientes[0].dato_deducido = true;
            pendientes[0].nota = (pendientes[0].nota ? pendientes[0].nota+'. ' : '') + `Acumulado tapado con asteriscos en el PDF — deducido del total impreso más adelante (coincide con lo esperado)`;
            corriendo += deducido;
          } else if (pendientes.length > 1) {
            avisos.push(`No se pudo separar el acumulado de estas cuentas (vinieron tapadas juntas, sin ningún total entre medio para distinguirlas): ${pendientes.map(p=>p.cuenta).join(', ')}`);
            pendientes.forEach(p => { p.acumulado_anterior = null; p.dato_deducido = true; p.nota = (p.nota?p.nota+'. ':'')+'No se pudo deducir: hay más de una cuenta tapada entre dos totales visibles'; p.irresoluble = true; });
            corriendo = f.acumulado;
          }
          pendientes = [];
        }
        continue;
      }
      if (f.acumulado === null) {
        f.acumulado_anterior = null;
        f.dato_deducido = true;
        f.nota = (f.nota?f.nota+'. ':'')+'Acumulado tapado con asteriscos en el PDF — pendiente de deducir con el próximo total visible';
        pendientes.push(f);
      } else {
        f.acumulado_anterior = f.acumulado;
        f.dato_deducido = false;
        corriendo += f.acumulado;
      }
      f.rubro = rubroActual;
      cuentas.push(f);
      continue;
    }
    const txt = l.trim();
    if (txt && !_FX_GRUPOS_BALANCE.has(txt)) rubroActual = txt;
  }
  // Cuentas que quedaron tapadas y nunca aparece un "Total" después para deducirlas.
  if (pendientes.length) {
    avisos.push(`Quedaron sin poder verificar (no hubo ningún total visible después de ellas en el PDF): ${pendientes.map(p=>p.cuenta).join(', ')}`);
    pendientes.forEach(p => { p.irresoluble = true; });
  }
  return { cuentas, avisos };
}

function fxDragOverBalance(e){ e.preventDefault(); document.getElementById('fx-drop-balance').style.borderColor='var(--P)'; }
function fxDragLeaveBalance(e){ document.getElementById('fx-drop-balance').style.borderColor='var(--brd)'; }
function fxDropBalance(e){
  e.preventDefault();
  document.getElementById('fx-drop-balance').style.borderColor='var(--brd)';
  const files = Array.from(e.dataTransfer.files).filter(f=>f.type==='application/pdf'||f.name.toLowerCase().endsWith('.pdf'));
  if (files.length) { _fxArchivosBalance.push(...files); _fxRenderListaArchivosBalance(); }
}
function fxSeleccionarArchivosBalance(input){
  const files = Array.from(input.files||[]);
  if (files.length) { _fxArchivosBalance.push(...files); _fxRenderListaArchivosBalance(); }
  input.value = '';
}
function fxQuitarArchivoBalance(i){
  _fxArchivosBalance.splice(i,1);
  _fxRenderListaArchivosBalance();
}
function _fxRenderListaArchivosBalance(){
  const el = document.getElementById('fx-archivos-balance');
  if (!el) return;
  el.innerHTML = _fxArchivosBalance.length ? _fxArchivosBalance.map((f,i)=>
    `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--bg2);border-radius:6px;margin-bottom:4px;font-size:13px">
      <span>📄 ${esc(f.name)}</span>
      <button class="btn sm D" onclick="fxQuitarArchivoBalance(${i})" title="Quitar">✕</button>
    </div>`).join('') : '<div style="font-size:12px;color:var(--txt2)">Sin archivos seleccionados.</div>';
  const btn = document.getElementById('btn-fx-procesar-balance');
  if (btn) btn.disabled = !_fxArchivosBalance.length;
}

async function fxProcesarArchivosBalance(){
  if (!_fxArchivosBalance.length) return;
  const btn = document.getElementById('btn-fx-procesar-balance');
  _bloquearBoton(btn, true, '⏳ Leyendo PDF...');
  _setImportStatus('fx-status-balance', 'loading', 'Extrayendo texto del PDF y deduciendo las cuentas tapadas. No cierres esta pantalla.');
  document.getElementById('fx-preview-balance').innerHTML = '';

  _fxResultadosBalance = [];
  try {
    for (const file of _fxArchivosBalance) {
      const data = new Uint8Array(await file.arrayBuffer());
      const doc = await pdfjsLib.getDocument({ data }).promise;
      const lineas = await _fxReconstruirLineas(doc);
      const periodoInfo = _fxDetectarPeriodoBalance(lineas);
      if (!periodoInfo) {
        _fxResultadosBalance.push({ archivo: file.name, error: 'No se pudo detectar el período (fecha "... AL ...") en el encabezado del PDF.' });
        continue;
      }
      const { cuentas, avisos } = _fxParsearBalance(lineas);
      if (!cuentas.length) {
        _fxResultadosBalance.push({ archivo: file.name, periodo: periodoInfo.periodo, error: 'No se detectó ninguna cuenta en el PDF. ¿Es el archivo correcto?' });
        continue;
      }
      const sumaSaldoFinal = cuentas.reduce((s,c)=>s + ((c.acumulado_anterior||0) + c.debe - c.haber), 0);
      _fxResultadosBalance.push({
        archivo: file.name,
        periodo: periodoInfo.periodo,
        mesNum: periodoInfo.mesNum,
        anio: periodoInfo.anio,
        cuentas,
        avisos,
        sumaSaldoFinal,
        sePuedeImportar: !cuentas.some(c=>c.irresoluble)
      });
    }
    _fxRenderPreviewBalance();
    _setImportStatus('fx-status-balance', '', '');
  } catch(e) {
    console.error(e);
    _setImportStatus('fx-status-balance', 'err', 'Error inesperado leyendo el PDF: ' + (e.message||e));
  } finally {
    _bloquearBoton(btn, false);
  }
}

function _fxRenderPreviewBalance(){
  const el = document.getElementById('fx-preview-balance');
  if (!el) return;
  el.innerHTML = _fxResultadosBalance.map((r, idx) => {
    if (r.error) {
      return `<div class="card" style="border:2px solid var(--D);margin-bottom:12px">
        <div style="font-weight:700;color:var(--D)">❌ ${esc(r.archivo)}</div>
        <div style="font-size:13px;margin-top:4px">${esc(r.error)}</div>
      </div>`;
    }
    const mesNombre = (_FX_MESES[r.mesNum]||'?') + ' ' + r.anio;
    const filas = r.cuentas.map(c => `
      <tr>
        <td style="font-size:11px;color:var(--txt2)">${esc(c.rubro||'—')}</td>
        <td>${esc(c.codigo)}</td>
        <td>${esc(c.cuenta)}</td>
        <td style="text-align:right">${c.irresoluble?'<span class="b bD">⚠️ sin verificar</span>':c.dato_deducido?`<span class="b bW" title="${esc(c.nota||'')}">🔎 ${_fxFmt(c.acumulado_anterior)}</span>`:_fxFmt(c.acumulado_anterior)}</td>
        <td style="text-align:right">${_fxFmt(c.debe)}</td>
        <td style="text-align:right">${_fxFmt(c.haber)}</td>
      </tr>
    `).join('');
    return `<div class="card" style="margin-bottom:12px;border:2px solid ${r.sePuedeImportar?'var(--P)':'var(--D)'}">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <div style="font-weight:700">${r.sePuedeImportar?'✅':'⚠️'} ${esc(r.archivo)} — ${mesNombre}</div>
        ${r.sePuedeImportar
          ? `<button class="btn P" onclick="fxConfirmarImportacionBalance(${idx})">💾 Confirmar e importar ${mesNombre}</button>`
          : `<span style="color:var(--D);font-weight:600;font-size:13px">No se va a guardar nada de este mes hasta resolverlo</span>`}
      </div>
      <div style="font-size:12px;color:var(--txt2);margin-bottom:8px">Suma de saldos finales: ${_fxFmt(r.sumaSaldoFinal)} (un descuadre chico acá es normal, es un defecto propio de FoxPro — no es un error de esta lectura)</div>
      ${r.avisos.length ? `<div style="font-size:12px;color:var(--D);margin-bottom:8px">⚠️ ${r.avisos.map(esc).join('<br>')}</div>` : ''}
      <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Rubro</th><th>Código</th><th>Cuenta</th><th style="text-align:right">Acum. anterior</th><th style="text-align:right">Debe</th><th style="text-align:right">Haber</th></tr></thead>
      <tbody>${filas}</tbody></table></div>
      <div id="fx-comparacion-${idx}" style="margin-top:12px"></div>
    </div>`;
  }).join('');
}

async function fxConfirmarImportacionBalance(idx){
  const r = _fxResultadosBalance[idx];
  if (!r || !r.sePuedeImportar) return;
  if (!await _confirmar(`¿Reemplazar el balance de ${(_FX_MESES[r.mesNum]||'')} ${r.anio} por el de este PDF?`, {titulo:'Confirmar importación', textoOk:'Importar'})) return;

  const filas = r.cuentas.map(c => ({
    codigo: c.codigo, cuenta: c.cuenta, rubro: c.rubro,
    acumulado_anterior: c.acumulado_anterior, debe_mes: c.debe, haber_mes: c.haber,
    dato_deducido: c.dato_deducido, nota: c.nota
  }));
  try {
    const { data, error } = await sb.rpc('fx_guardar_balance', { p_periodo: r.periodo, p_filas: filas });
    if (error) { toast('❌ Error guardando: '+error.message, 'err', 5000); return; }
    toast(`✅ Balance de ${(_FX_MESES[r.mesNum]||'')} ${r.anio} importado`);
    _fxRenderComparacionBalance(idx, data);
  } catch(e) {
    console.error(e);
    toast('❌ Error guardando: '+(e.message||e), 'err', 5000);
  }
}

function _fxRenderComparacionBalance(idx, comparacion){
  const el = document.getElementById('fx-comparacion-'+idx);
  if (!el) return;
  if (!comparacion || !comparacion.length) {
    el.innerHTML = '<div style="font-size:12px;color:var(--txt2)">Sin datos de comparación contra el Mayor (¿se cargó el Mayor de este mes en la otra sección?).</div>';
    return;
  }
  const badge = { 'Coincide':'<span class="b bP">✅ Coincide</span>', 'No coincide':'<span class="b bD">⚠️ No coincide</span>', 'Falta en el mayor':'<span class="b bA">❔ Falta en el Mayor</span>', 'Sin movimiento':'<span class="b bW">— Sin movimiento</span>' };
  el.innerHTML = `<div style="font-weight:600;font-size:13px;margin-bottom:6px">⚖️ Comparación Balance vs Mayor</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Cuenta</th><th style="text-align:right">Debe (Balance)</th><th style="text-align:right">Debe (Mayor)</th><th style="text-align:right">Haber (Balance)</th><th style="text-align:right">Haber (Mayor)</th><th style="text-align:center">Estado</th></tr></thead>
    <tbody>${comparacion.map(c=>`<tr><td>${esc(c.cuenta)}</td><td style="text-align:right">${_fxFmt(c.debe_mes)}</td><td style="text-align:right">${_fxFmt(c.mayor_debe)}</td><td style="text-align:right">${_fxFmt(c.haber_mes)}</td><td style="text-align:right">${_fxFmt(c.mayor_haber)}</td><td style="text-align:center">${badge[c.estado]||esc(c.estado)}</td></tr>`).join('')}</tbody></table></div>`;
}

// ═══════════════════════════════════════════════════════════════════════
// ─── FASE 3: TABLERO — resumen, fondos y faltantes ───
// Todo llega de una sola vez por fx_tablero() (lee el cajón "analisis",
// que la API no ve directo). El filtro de ZONA todavía no se puede hacer:
// las vistas agrupan por el nombre tal cual lo escribe FoxPro, sin vínculo
// con el cliente/zona real del ERP — eso es la Fase 4, pendiente.
// ═══════════════════════════════════════════════════════════════════════
let _tabData = null;
let _tabCharts = {};

function _tabDestruir(nombre){ if(_tabCharts[nombre]){ try{_tabCharts[nombre].destroy();}catch(e){} delete _tabCharts[nombre]; } }
function _tabColores(){
  const isDark = matchMedia('(prefers-color-scheme: dark)').matches;
  return { grid: isDark?'rgba(255,255,255,0.08)':'rgba(0,0,0,0.06)', texto: isDark?'#aaa':'#777' };
}
function _tabOrdenPeriodos(a,b){
  const [ma,aa]=a.split('-'),[mb,ab]=b.split('-');
  return (aa+ma.padStart(2,'0')).localeCompare(ab+mb.padStart(2,'0'));
}

async function fxCargarTablero(){
  const el = document.getElementById('tab-status');
  if(el){el.style.display='block';el.textContent='Cargando...';}
  const { data, error } = await sb.rpc('fx_tablero');
  if (error) { if(el)el.textContent='❌ Error: '+error.message; console.error(error); return; }
  _tabData = data || {};
  if(el){el.style.display='none';el.textContent='';}
  _tabPoblarFiltroMes();
  tabRenderTodo();
}

function _tabPoblarFiltroMes(){
  const sel = document.getElementById('tab-filtro-mes');
  if (!sel || !_tabData) return;
  const periodos = Array.from(new Set((_tabData.resumen_mes||[]).map(r=>r.periodo))).sort(_tabOrdenPeriodos);
  const actual = sel.value;
  sel.innerHTML = '<option value="">Todos los meses cargados</option>' + periodos.map(p=>{
    const [mm,aaaa] = p.split('-');
    return `<option value="${esc(p)}">${_FX_MESES[parseInt(mm)]||mm} ${aaaa}</option>`;
  }).join('');
  if (periodos.includes(actual)) sel.value = actual;
}

function tabRenderTodo(){
  if (!_tabData) return;
  tabRenderResumen();
  tabRenderFondos();
  tabRenderFaltantes();
}

function tabRenderResumen(){
  const filtro = document.getElementById('tab-filtro-mes')?.value || '';
  const filas = (_tabData.resumen_mes||[]).filter(r=>!filtro||r.periodo===filtro).sort((a,b)=>_tabOrdenPeriodos(a.periodo,b.periodo));
  const {grid,texto} = _tabColores();
  _tabDestruir('resumen');
  const ctx = document.getElementById('tab-chart-resumen');
  if (ctx) {
    _tabCharts.resumen = new Chart(ctx, {
      type:'bar',
      data:{ labels: filas.map(f=>f.periodo),
        datasets:[
          {label:'Ventas', data:filas.map(f=>f.ventas||0), backgroundColor:'#378ADD'},
          {label:'Cobros', data:filas.map(f=>f.cobros||0), backgroundColor:'#1D9E75'},
          {label:'Compras', data:filas.map(f=>f.compras||0), backgroundColor:'#D85A30'},
          {label:'Pagos a prov.', data:filas.map(f=>f.pagos_proveedores||0), backgroundColor:'#C47A00'},
          {label:'Sueldos', data:filas.map(f=>f.sueldos||0), backgroundColor:'#8E44AD'},
        ]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{position:'bottom',labels:{color:texto,boxWidth:10,font:{size:10}}}},
        scales:{x:{ticks:{color:texto,font:{size:10}},grid:{display:false}}, y:{ticks:{color:texto,font:{size:10}},grid:{color:grid}}}}
    });
  }
  const tbl = document.getElementById('tab-tabla-resumen');
  if (tbl) tbl.innerHTML = `<div class="tbl-wrap"><table class="tbl"><thead><tr><th>Mes</th><th style="text-align:right">Ventas</th><th style="text-align:right">Cobros</th><th style="text-align:right">Compras</th><th style="text-align:right">Pagos prov.</th><th style="text-align:right">Sueldos</th><th style="text-align:right">Clientes activos</th></tr></thead><tbody>
    ${filas.map(f=>`<tr><td>${esc(f.periodo)}</td><td style="text-align:right">${_fxFmt(f.ventas)}</td><td style="text-align:right">${_fxFmt(f.cobros)}</td><td style="text-align:right">${_fxFmt(f.compras)}</td><td style="text-align:right">${_fxFmt(f.pagos_proveedores)}</td><td style="text-align:right">${_fxFmt(f.sueldos)}</td><td style="text-align:right">${f.clientes_activos??'—'}</td></tr>`).join('') || '<tr><td colspan="7" style="text-align:center;color:var(--txt2)">Sin datos — cargá el Mayor en la pestaña de arriba</td></tr>'}
  </tbody></table></div>`;
}

function tabRenderFondos(){
  const filtro = document.getElementById('tab-filtro-mes')?.value || '';
  const filas = (_tabData.fondos||[]).filter(r=>!filtro||r.periodo===filtro);
  const porCat = {};
  filas.forEach(f=>{
    if(!porCat[f.categoria]) porCat[f.categoria] = {ingreso:0, egreso:0};
    if(f.tipo==='Ingreso') porCat[f.categoria].ingreso += f.importe||0;
    else porCat[f.categoria].egreso += f.importe||0;
  });
  const cats = Object.keys(porCat).sort((a,b)=>(porCat[b].ingreso+porCat[b].egreso)-(porCat[a].ingreso+porCat[a].egreso));
  const {grid,texto} = _tabColores();
  _tabDestruir('fondos');
  const ctx = document.getElementById('tab-chart-fondos');
  if (ctx) {
    _tabCharts.fondos = new Chart(ctx, {
      type:'bar', indexAxis:'y',
      data:{ labels: cats,
        datasets:[
          {label:'Ingresos', data:cats.map(c=>porCat[c].ingreso), backgroundColor:'#1D9E75'},
          {label:'Egresos', data:cats.map(c=>-porCat[c].egreso), backgroundColor:'#D85A30'},
        ]},
      options:{responsive:true,maintainAspectRatio:false,
        plugins:{legend:{position:'bottom',labels:{color:texto,boxWidth:10,font:{size:10}}},
          tooltip:{callbacks:{label:c=>' '+c.dataset.label+': '+_fxFmt(Math.abs(c.parsed.x))}}},
        scales:{x:{ticks:{color:texto,font:{size:10},callback:v=>_fxFmt(Math.abs(v))},grid:{color:grid}}, y:{ticks:{color:texto,font:{size:10}},grid:{display:false}}}}
    });
  }
}

function tabRenderFaltantes(){
  const cobertura = (_tabData.cobertura||[]).filter(r=>r.estado!=='Está');
  const mesesDeducidos = (_tabData.mes_deducido||[]).filter(r=>r.neto_deducido!==null && r.neto_deducido!==undefined);
  const tbl = document.getElementById('tab-tabla-faltantes');
  if (!tbl) return;
  const filasCobertura = cobertura.length ? cobertura.map(c=>`<tr><td>${esc(c.periodo)}</td><td>${esc(c.cuenta)}</td><td>${c.estado==='Mes sin mayor'?'<span class="b bD">Mes sin Mayor cargado</span>':'<span class="b bW">Falta esta cuenta en ese mes</span>'}</td></tr>`).join('') : '<tr><td colspan="3" style="color:var(--txt2);text-align:center">✅ Sin faltantes — está todo lo cargado</td></tr>';
  const filasDeducidas = mesesDeducidos.map(m=>`<tr><td>${esc(m.periodo_balance)}</td><td>${esc(m.cuenta)}</td><td>${esc(m.cuales)}</td><td style="text-align:right">${_fxFmt(m.neto_deducido)}</td></tr>`).join('');
  tbl.innerHTML = `
    <div style="font-weight:600;font-size:13px;margin-bottom:6px">Cuentas que faltan en el Mayor (pedir a FoxPro)</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Mes</th><th>Cuenta</th><th>Qué pasa</th></tr></thead><tbody>${filasCobertura}</tbody></table></div>
    ${mesesDeducidos.length ? `<div style="font-weight:600;font-size:13px;margin:14px 0 6px">Mes deducido a partir del Balance (cuando falta un solo mes, se puede calcular solo)</div>
    <div class="tbl-wrap"><table class="tbl"><thead><tr><th>Balance de</th><th>Cuenta</th><th>Mes que falta</th><th style="text-align:right">Movimiento neto deducido</th></tr></thead><tbody>${filasDeducidas}</tbody></table></div>` : ''}
  `;
}

function tabExportarExcel(cual){
  if (!_tabData) return;
  const mapa = { resumen:['resumen_mes','resumen_mensual'], fondos:['fondos','fondos'], clientes:['clientes_mes','ventas_por_cliente'], proveedores:['proveedores_mes','compras_por_proveedor'] };
  const conf = mapa[cual];
  if (!conf) return;
  const filas = _tabData[conf[0]] || [];
  if (!filas.length) { toast('No hay datos para exportar'); return; }
  const ws = XLSX.utils.json_to_sheet(filas);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Datos');
  XLSX.writeFile(wb, `lila_${conf[1]}_${new Date().toISOString().slice(0,10)}.xlsx`);
}
