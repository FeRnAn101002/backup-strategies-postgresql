import {
  DESASTRES, TABLAS, archivarJournal, backupFisico, backupLogico, compararHuellas, crearBaseDemo,
  crearInstancia, generarActividad, huella, provocarDesastre, restaurar, restaurarPITR, verificarIntegridad,
} from './backup.js'

const $ = (sel) => document.querySelector(sel)
const estado = {
  pg: null,
  archivo: [],          // cambios archivados fuera de la base (equivale al archivo de WAL)
  backups: [],
  huellas: new Map(),   // LSN archivado -> huella, para verificar cualquier punto de recuperación
  etiquetas: new Map(), // LSN archivado -> operación que lo produjo
}

const kb = (n) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(2)} MB`)
const hora = (iso) => new Date(iso).toLocaleTimeString('es-PE', { hour12: false })
const escapar = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])

function log(texto, tipo = '') {
  const li = document.createElement('li')
  li.className = tipo
  li.innerHTML = `<time>${hora(new Date().toISOString())}</time> ${texto}`
  $('#bitacora').prepend(li)
}

async function ocupado(boton, fn) {
  const botones = document.querySelectorAll('button')
  botones.forEach((b) => (b.disabled = true))
  boton?.classList.add('trabajando')
  try {
    await fn()
  } catch (e) {
    log(`❌ ${escapar(e.message)}`, 'error')
  } finally {
    botones.forEach((b) => (b.disabled = false))
    boton?.classList.remove('trabajando')
  }
}

/** Archiva los cambios nuevos y guarda la huella del estado actual para ese LSN. */
async function sincronizar(etiqueta) {
  const nuevos = await archivarJournal(estado.pg, estado.archivo)
  const h = await huella(estado.pg)
  const lsn = estado.archivo.at(-1)?.lsn ?? 0
  estado.huellas.set(lsn, h)
  if (etiqueta && nuevos) estado.etiquetas.set(lsn, etiqueta)
  pintarProduccion(h)
  pintarPuntos()
  return nuevos
}

function pintarProduccion(h) {
  $('#tabla-huella tbody').innerHTML = TABLAS.map((t) => {
    const r = h[t]
    const malo = r.filas === null
    return `<tr class="${malo ? 'mal' : ''}"><td>${t}</td><td>${malo ? '—' : r.filas}</td><td><code>${malo ? 'TABLA AUSENTE' : r.md5.slice(0, 12) + '…'}</code></td></tr>`
  }).join('')
  $('#ind-wal').textContent = estado.archivo.length
  const ultimo = estado.backups.at(-1)
  const lsn = estado.archivo.at(-1)?.lsn ?? 0
  $('#ind-rpo').textContent = ultimo ? estado.archivo.filter((c) => c.lsn > ultimo.lsn).length : '—'
  $('#ind-rpo').parentElement.classList.toggle('alerta', !!ultimo && lsn > ultimo.lsn)
}

function pintarBackups() {
  const tbody = $('#tabla-backups tbody')
  if (!estado.backups.length) return
  tbody.innerHTML = estado.backups.map((b) => `
    <tr>
      <td><span class="chip ${b.tipo}">${b.tipo === 'logico' ? 'Lógico' : 'Físico'}</span> ${hora(b.fecha)}</td>
      <td>${b.lsn}</td><td>${kb(b.bytes)}</td><td>${b.ms} ms</td>
      <td><code title="${b.sha256}">${b.sha256.slice(0, 10)}…</code></td>
      <td class="mini">
        <button data-descargar="${b.id}" title="Copia externa (regla 3-2-1)">⬇</button>
        <button data-verificar="${b.id}" title="Verificar SHA-256">✔</button>
      </td>
    </tr>`).join('')
  const sel = $('#sel-backup')
  const previo = sel.value
  sel.innerHTML = estado.backups.map((b) =>
    `<option value="${b.id}">${b.tipo === 'logico' ? 'Lógico (pg_dump)' : 'Físico (base)'} · ${hora(b.fecha)} · LSN ${b.lsn}</option>`).reverse().join('')
  if (previo && estado.backups.some((b) => b.id === previo)) sel.value = previo
  pintarPuntos()
}

function pintarPuntos() {
  const b = estado.backups.find((x) => x.id === $('#sel-backup').value)
  const sel = $('#sel-punto')
  if (!b) {
    sel.innerHTML = ''
    return
  }
  const opciones = [`<option value="${b.lsn}">Momento del respaldo (LSN ${b.lsn})</option>`]
  if (b.tipo === 'fisico') {
    const cambios = estado.archivo.filter((c) => c.lsn > b.lsn && estado.huellas.has(c.lsn))
    for (const c of cambios) {
      const tras = estado.etiquetas.get(c.lsn) ?? `${c.op} en ${c.tabla}`
      opciones.push(`<option value="${c.lsn}">LSN ${c.lsn} · ${hora(c.ts)} · después de: ${tras}</option>`)
    }
    $('#ayuda-punto').textContent = `PITR: ${cambios.length} puntos disponibles después del respaldo. Elige el último ANTES del desastre.`
  } else {
    $('#ayuda-punto').textContent = 'Un respaldo lógico solo vuelve al momento en que se tomó (sin PITR).'
  }
  sel.innerHTML = opciones.reverse().join('')
  // Por defecto se sugiere el punto más reciente que no sea un desastre.
  const seguro = [...sel.options].findIndex((o) => !o.text.includes('💥'))
  sel.selectedIndex = Math.max(seguro, 0)
}

async function iniciar() {
  estado.pg = await crearInstancia()
  await crearBaseDemo(estado.pg)
  const { rows: [v] } = await estado.pg.query("SELECT split_part(version(), ' on ', 1) AS v")
  $('#version').textContent = `${v.v} · base de datos “tienda” con 4 tablas relacionadas`
  $('#sel-desastre').innerHTML = Object.entries(DESASTRES).map(([k, d]) => `<option value="${k}">${d.titulo}</option>`).join('')
  await sincronizar()
  log('✅ Base de datos <strong>tienda</strong> creada y archivado continuo de cambios activado.', 'ok')
  $('#cargando').remove()
}

$('#btn-actividad').addEventListener('click', (e) => ocupado(e.currentTarget, async () => {
  await generarActividad(estado.pg, 5)
  const n = await sincronizar('actividad del negocio')
  log(`🛒 Actividad del negocio: 5 clientes y pedidos nuevos (${n} cambios archivados).`)
}))

for (const [id, fn, nombre] of [['#btn-logico', backupLogico, 'lógico con pg_dump'], ['#btn-fisico', backupFisico, 'físico del directorio de datos']]) {
  $(id).addEventListener('click', (e) => ocupado(e.currentTarget, async () => {
    await sincronizar()
    const b = await fn(estado.pg)
    estado.backups.push(b)
    pintarBackups()
    $('#sel-backup').value = b.id
    pintarPuntos()
    await sincronizar()
    log(`💾 Respaldo ${nombre}: ${kb(b.bytes)} en ${b.ms} ms (LSN ${b.lsn}).`, 'ok')
  }))
}

$('#btn-desastre').addEventListener('click', (e) => ocupado(e.currentTarget, async () => {
  const titulo = await provocarDesastre(estado.pg, $('#sel-desastre').value)
  const n = await sincronizar(`💥 ${titulo}`)
  log(`💥 Desastre: <strong>${titulo}</strong> (${n} cambios registrados).`, 'error')
}))

$('#sel-backup').addEventListener('change', pintarPuntos)

$('#btn-restaurar').addEventListener('click', (e) => ocupado(e.currentTarget, async () => {
  const b = estado.backups.find((x) => x.id === $('#sel-backup').value)
  if (!b) throw new Error('Primero crea un respaldo.')
  const objetivo = Number($('#sel-punto').value)
  const pitr = b.tipo === 'fisico' && objetivo > b.lsn
  const r = pitr ? await restaurarPITR(b, estado.archivo, objetivo) : await restaurar(b)
  const esperada = pitr ? estado.huellas.get(objetivo) : b.huella
  const comparacion = compararHuellas(esperada, await huella(r.pg))
  const ok = comparacion.every((x) => x.ok)
  const lsnActual = estado.archivo.at(-1)?.lsn ?? 0
  const perdidos = estado.archivo.filter((c) => c.lsn > objetivo).length

  $('#resultado').innerHTML = `
    <div class="veredicto ${ok ? 'bien' : 'mal'}">${ok ? '✔ Restauración verificada' : '✖ La verificación falló'}</div>
    <table class="tabla">
      <thead><tr><th>Tabla</th><th>Esperadas</th><th>Restauradas</th><th>MD5</th></tr></thead>
      <tbody>${comparacion.map((x) => `<tr><td>${x.tabla}</td><td>${x.esperadas ?? '—'}</td><td>${x.obtenidas ?? '—'}</td><td>${x.ok ? '✔' : '✖'}</td></tr>`).join('')}</tbody>
    </table>
    <div class="indicadores">
      <div class="indicador"><span>${r.ms} ms</span><small>RTO medido</small></div>
      <div class="indicador"><span>${pitr ? r.aplicados : 0}</span><small>cambios reproducidos (PITR)</small></div>
      <div class="indicador"><span>${perdidos}</span><small>cambios descartados (posteriores al punto)</small></div>
    </div>
    ${ok ? '<button id="btn-promover" class="verde">Promover a producción</button>' : ''}`

  log(`♻️ Restauración ${pitr ? `PITR hasta LSN ${objetivo}` : `completa (${b.tipo})`} en ${r.ms} ms: ${ok ? 'verificada ✔' : 'NO coincide ✖'}.`, ok ? 'ok' : 'error')
  const promover = $('#btn-promover')
  if (!promover) return r.pg.close()
  promover.addEventListener('click', () => ocupado(promover, async () => {
    await estado.pg.close()
    estado.pg = r.pg
    // Nueva línea de tiempo: los cambios posteriores al punto recuperado ya no forman parte de la historia.
    estado.archivo = estado.archivo.filter((c) => c.lsn <= objetivo)
    for (const k of estado.huellas.keys()) if (k > objetivo) estado.huellas.delete(k)
    for (const k of estado.etiquetas.keys()) if (k > objetivo) estado.etiquetas.delete(k)
    await sincronizar()
    $('#resultado').innerHTML = ''
    log(`🚀 Instancia restaurada promovida a producción (antes LSN ${lsnActual}, ahora ${objetivo}).`, 'ok')
  }))
}))

document.addEventListener('click', (e) => {
  const desc = e.target.closest('[data-descargar]')
  const ver = e.target.closest('[data-verificar]')
  if (desc) {
    const b = estado.backups.find((x) => x.id === desc.dataset.descargar)
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(b.datos), download: `${b.id}-${b.nombre}` })
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
    log(`⬇ Copia externa descargada: ${b.id}-${b.nombre}`)
  } else if (ver) {
    const b = estado.backups.find((x) => x.id === ver.dataset.verificar)
    verificarIntegridad(b).then((ok) => log(`${ok ? '✔' : '✖'} SHA-256 de ${b.id}: ${ok ? 'íntegro' : 'ALTERADO'}.`, ok ? 'ok' : 'error'))
  }
})

$('#btn-sql').addEventListener('click', (e) => ocupado(e.currentTarget, async () => {
  const salida = $('#sql-salida')
  try {
    const res = await estado.pg.exec($('#txt-sql').value)
    const ult = res.at(-1)
    if (!ult?.fields?.length) {
      salida.textContent = `OK (${ult?.affectedRows ?? 0} filas afectadas)`
    } else {
      const cols = ult.fields.map((f) => f.name)
      salida.textContent = [cols.join(' | '), ...ult.rows.slice(0, 50).map((r) => cols.map((c) => r[c]).join(' | '))].join('\n')
    }
    await sincronizar('consola SQL')
  } catch (err) {
    salida.textContent = `ERROR: ${err.message}`
  }
}))
$('#txt-sql').addEventListener('keydown', (e) => e.key === 'Enter' && $('#btn-sql').click())

iniciar().catch((e) => {
  $('#cargando').innerHTML = `<p>No se pudo iniciar PostgreSQL: ${escapar(e.message)}</p>`
})
