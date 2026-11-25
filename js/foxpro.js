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
const _fxReCuenta = /^Cuenta: (\d{5}) (\d{5}) (.+)$/;
const _fxReMov = /^(\d\d\/\d\d\/\d{4}) (\d+) - (.+?) (-?[\d,]+\.\d\d) (-?[\d,]+\.\d\d) (\S+)$/;

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
    const mm = l.match(_fxReMov);
    if (mm) {
      const [, fechaStr, asientoStr, concepto, deStr, haStr] = mm;
      const [dd, mo, aa] = fechaStr.split('/');
      const fecha = new Date(parseInt(aa), parseInt(mo)-1, parseInt(dd)).toISOString().split('T')[0];
      const debe = _fxNum(deStr), haber = _fxNum(haStr);
      if (debe === null || haber === null) {
        avisos.push(`${cur.nombre}: movimiento del ${fechaStr} con importe ilegible (asteriscos) — revisar a mano`);
        continue;
      }
      cur.movs.push({ fecha, asiento: parseInt(asientoStr), concepto: concepto.trim().toUpperCase(), debe, haber });
      continue;
    }
    if (l.startsWith('Totales mes')) {
      const nums = l.replace('Totales mes','').trim().split(/\s+/).map(_fxNum);
      cur.totMes = nums;
      continue;
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
