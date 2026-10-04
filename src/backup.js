// Núcleo de PgBackupLab: estrategias de respaldo y recuperación sobre PostgreSQL real (PGlite).
// Este módulo no toca el DOM, por eso se prueba igual en Node (Vitest) y en el navegador.
import { PGlite } from '@electric-sql/pglite'
import { pgDump } from '@electric-sql/pglite-tools/pg_dump'

export const TABLAS = ['clientes', 'productos', 'pedidos', 'detalle_pedido']

const ESQUEMA = `
CREATE TABLE clientes (
  id serial PRIMARY KEY,
  nombre text NOT NULL,
  email text UNIQUE NOT NULL,
  ciudad text NOT NULL,
  creado timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE productos (
  id serial PRIMARY KEY,
  nombre text NOT NULL,
  precio numeric(10,2) NOT NULL CHECK (precio > 0),
  stock int NOT NULL DEFAULT 0
);
CREATE TABLE pedidos (
  id serial PRIMARY KEY,
  cliente_id int NOT NULL REFERENCES clientes(id),
  fecha timestamptz NOT NULL DEFAULT now(),
  estado text NOT NULL DEFAULT 'pendiente'
);
CREATE TABLE detalle_pedido (
  id serial PRIMARY KEY,
  pedido_id int NOT NULL REFERENCES pedidos(id) ON DELETE CASCADE,
  producto_id int NOT NULL REFERENCES productos(id),
  cantidad int NOT NULL CHECK (cantidad > 0),
  precio numeric(10,2) NOT NULL
);

INSERT INTO clientes (nombre, email, ciudad)
SELECT 'Cliente ' || g, 'cliente' || g || '@correo.pe',
       (ARRAY['Tacna','Lima','Arequipa','Cusco','Puno','Moquegua'])[1 + g % 6]
FROM generate_series(1, 40) g;

INSERT INTO productos (nombre, precio, stock)
SELECT 'Producto ' || g, round((5 + (g * 37) % 300)::numeric, 2), 10 + (g * 13) % 90
FROM generate_series(1, 25) g;

INSERT INTO pedidos (cliente_id, fecha, estado)
SELECT 1 + (g * 7) % 40, timestamptz '2026-09-01' + g * interval '5 hours',
       (ARRAY['pendiente','pagado','enviado','entregado'])[1 + g % 4]
FROM generate_series(1, 120) g;

INSERT INTO detalle_pedido (pedido_id, producto_id, cantidad, precio)
SELECT p, 1 + (p * 3 + l * 11) % 25, 1 + (p + l) % 4, 0
FROM generate_series(1, 120) p, generate_series(1, 3) l
WHERE (p + l) % 5 <> 0;

UPDATE detalle_pedido d SET precio = pr.precio FROM productos pr WHERE pr.id = d.producto_id;
`

// "Journal" de cambios: emula el archivado continuo del WAL (archive_command) a nivel lógico.
// Cada fila modificada queda registrada con un número de secuencia (LSN) y una marca de tiempo.
const JOURNAL = `
CREATE TABLE IF NOT EXISTS _journal (
  lsn bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT clock_timestamp(),
  tabla text NOT NULL,
  op text NOT NULL,
  nuevo jsonb,
  viejo jsonb
);
CREATE OR REPLACE FUNCTION _journal_fila() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _journal (tabla, op, nuevo, viejo) VALUES (TG_TABLE_NAME, TG_OP,
    CASE WHEN TG_OP <> 'DELETE' THEN to_jsonb(NEW) END,
    CASE WHEN TG_OP <> 'INSERT' THEN to_jsonb(OLD) END);
  RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION _journal_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO _journal (tabla, op) VALUES (TG_TABLE_NAME, 'TRUNCATE');
  RETURN NULL;
END $$;
`

export async function crearInstancia(opciones = {}) {
  return PGlite.create(opciones)
}

export async function crearBaseDemo(pg) {
  await pg.exec(ESQUEMA)
  await pg.exec(JOURNAL)
  for (const t of TABLAS) {
    await pg.exec(`
      CREATE TRIGGER ${t}_journal AFTER INSERT OR UPDATE OR DELETE ON ${t}
        FOR EACH ROW EXECUTE FUNCTION _journal_fila();
      CREATE TRIGGER ${t}_journal_trunc AFTER TRUNCATE ON ${t}
        FOR EACH STATEMENT EXECUTE FUNCTION _journal_truncate();`)
  }
}

/** Simula la operación diaria del negocio: nuevos clientes, pedidos y cambios de estado. */
export async function generarActividad(pg, n = 5) {
  await pg.transaction(async (tx) => {
    for (let i = 0; i < n; i++) {
      const { rows: [c] } = await tx.query(
        `INSERT INTO clientes (nombre, email, ciudad)
         VALUES ('Nuevo ' || md5(random()::text), md5(random()::text) || '@correo.pe', 'Tacna') RETURNING id`)
      const { rows: [p] } = await tx.query(
        'INSERT INTO pedidos (cliente_id, estado) VALUES ($1, $2) RETURNING id', [c.id, 'pagado'])
      await tx.query(
        `INSERT INTO detalle_pedido (pedido_id, producto_id, cantidad, precio)
         SELECT $1, id, 1 + floor(random() * 3)::int, precio FROM productos ORDER BY random() LIMIT 2`, [p.id])
      await tx.query(
        `UPDATE pedidos SET estado = 'enviado' WHERE id = (SELECT id FROM pedidos WHERE estado = 'pagado' ORDER BY id LIMIT 1)`)
    }
  })
}

export const DESASTRES = {
  delete_sin_where: { titulo: 'DELETE sin WHERE en pedidos', sql: 'DELETE FROM pedidos' },
  update_masivo: { titulo: 'UPDATE masivo de precios a 0,01', sql: 'UPDATE productos SET precio = 0.01' },
  truncate: { titulo: 'TRUNCATE de detalle_pedido', sql: 'TRUNCATE detalle_pedido' },
  drop_table: { titulo: 'DROP TABLE clientes CASCADE', sql: 'DROP TABLE clientes CASCADE' },
}

export async function provocarDesastre(pg, clave) {
  const d = DESASTRES[clave]
  if (!d) throw new Error(`Desastre desconocido: ${clave}`)
  await pg.exec(d.sql)
  return d.titulo
}

/** Huella de verificación: filas y MD5 del contenido de cada tabla, en orden por clave primaria. */
export async function huella(pg) {
  const out = {}
  for (const t of TABLAS) {
    try {
      const { rows: [r] } = await pg.query(
        `SELECT count(*)::int AS filas, md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) AS md5 FROM ${t} x`)
      out[t] = r
    } catch {
      out[t] = { filas: null, md5: 'TABLA AUSENTE' }
    }
  }
  return out
}

export function compararHuellas(esperada, obtenida) {
  return TABLAS.map((t) => ({
    tabla: t,
    esperadas: esperada[t]?.filas ?? null,
    obtenidas: obtenida[t]?.filas ?? null,
    ok: esperada[t]?.md5 === obtenida[t]?.md5,
  }))
}

export async function sha256(datos) {
  const bytes = typeof datos === 'string' ? new TextEncoder().encode(datos) : new Uint8Array(await datos.arrayBuffer())
  const hash = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

async function ultimoLsn(pg) {
  const { rows: [r] } = await pg.query('SELECT coalesce(max(lsn), 0)::int AS lsn FROM _journal')
  return r.lsn
}

let secuencia = 0
function nuevoId(tipo) {
  secuencia += 1
  return `${tipo}-${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${secuencia}`
}

/** Estrategia 1 — Respaldo lógico completo con pg_dump (script SQL portable entre versiones). */
export async function backupLogico(pg) {
  const t0 = performance.now()
  const lsn = await ultimoLsn(pg)
  const archivo = await pgDump({ pg })
  const sql = await archivo.text()
  // pg_dump trabaja dentro de una transacción REPEATABLE READ de solo lectura (instantánea consistente);
  // en PGlite la sesión es compartida, así que se cierra y se restablece el search_path que vació.
  if (await pg.isInTransaction()) await pg.exec('ROLLBACK')
  await pg.exec('RESET search_path')
  return {
    id: nuevoId('logico'), tipo: 'logico', fecha: new Date().toISOString(), lsn,
    nombre: 'tienda.sql', datos: new Blob([sql], { type: 'application/sql' }),
    bytes: new Blob([sql]).size, sha256: await sha256(sql), huella: await huella(pg),
    ms: Math.round(performance.now() - t0),
  }
}

/** Estrategia 2 — Respaldo físico completo: copia comprimida del directorio de datos (como pg_basebackup). */
export async function backupFisico(pg) {
  const t0 = performance.now()
  await pg.exec('CHECKPOINT')
  const lsn = await ultimoLsn(pg)
  const datos = await pg.dumpDataDir('gzip')
  return {
    id: nuevoId('fisico'), tipo: 'fisico', fecha: new Date().toISOString(), lsn,
    nombre: 'pgdata.tar.gz', datos, bytes: datos.size, sha256: await sha256(datos), huella: await huella(pg),
    ms: Math.round(performance.now() - t0),
  }
}

/** Copia al archivo externo los cambios del journal que aún no se archivaron (equivale a archive_command). */
export async function archivarJournal(pg, archivo) {
  const desde = archivo.length ? archivo[archivo.length - 1].lsn : 0
  const { rows } = await pg.query(
    'SELECT lsn::int, ts, tabla, op, nuevo, viejo FROM _journal WHERE lsn > $1 ORDER BY lsn', [desde])
  for (const r of rows) archivo.push({ ...r, ts: new Date(r.ts).toISOString() })
  return rows.length
}

/** Verifica que el archivo de respaldo no se haya alterado comparando su SHA-256. */
export async function verificarIntegridad(backup) {
  const actual = await sha256(backup.tipo === 'logico' ? await backup.datos.text() : backup.datos)
  return actual === backup.sha256
}

/** Restaura un respaldo completo en una instancia NUEVA (nunca sobre la base dañada). */
export async function restaurar(backup) {
  if (!(await verificarIntegridad(backup))) throw new Error('El archivo de respaldo está corrupto (SHA-256 no coincide).')
  const t0 = performance.now()
  let pg
  if (backup.tipo === 'fisico') {
    pg = await PGlite.create({ loadDataDir: backup.datos })
  } else {
    pg = await PGlite.create()
    await pg.exec(await backup.datos.text())
    await pg.exec('RESET search_path')
  }
  return { pg, ms: Math.round(performance.now() - t0) }
}

async function aplicarCambio(tx, c) {
  if (c.op === 'TRUNCATE') {
    await tx.exec(`DELETE FROM ${c.tabla}`)
  } else if (c.op === 'DELETE') {
    await tx.query(`DELETE FROM ${c.tabla} WHERE id = $1`, [c.viejo.id])
  } else {
    if (c.op === 'UPDATE') await tx.query(`DELETE FROM ${c.tabla} WHERE id = $1`, [c.viejo.id])
    await tx.query(`INSERT INTO ${c.tabla} SELECT * FROM jsonb_populate_record(NULL::${c.tabla}, $1)`, [c.nuevo])
  }
}

/**
 * Estrategia 3 — Recuperación a un punto en el tiempo (PITR):
 * respaldo físico base + reproducción del journal archivado hasta el LSN objetivo.
 */
export async function restaurarPITR(base, archivo, lsnObjetivo) {
  if (base.tipo !== 'fisico') throw new Error('PITR necesita un respaldo físico como base.')
  if (lsnObjetivo < base.lsn) throw new Error('El punto elegido es anterior al respaldo base; elija un respaldo más antiguo.')
  const { pg, ms: msBase } = await restaurar(base)
  const t0 = performance.now()
  const cambios = archivo.filter((c) => c.lsn > base.lsn && c.lsn <= lsnObjetivo)
  await pg.transaction(async (tx) => {
    // Durante la reproducción no se disparan triggers ni se validan FKs fila a fila (igual que en una réplica).
    await tx.exec("SET LOCAL session_replication_role = 'replica'")
    for (const c of cambios) await aplicarCambio(tx, c)
    // Los cambios reproducidos pasan a formar parte del journal de la nueva línea de tiempo.
    for (const c of cambios) {
      await tx.query('INSERT INTO _journal (lsn, ts, tabla, op, nuevo, viejo) VALUES ($1, $2, $3, $4, $5, $6)',
        [c.lsn, c.ts, c.tabla, c.op, c.nuevo, c.viejo])
    }
    await tx.exec("SELECT setval('_journal_lsn_seq', (SELECT coalesce(max(lsn), 1) FROM _journal))")
    for (const t of TABLAS) {
      await tx.exec(`SELECT setval(pg_get_serial_sequence('${t}', 'id'), (SELECT coalesce(max(id), 1) FROM ${t}))`)
    }
  })
  return { pg, ms: msBase + Math.round(performance.now() - t0), aplicados: cambios.length }
}

/** Política de retención GFS (abuelo-padre-hijo): qué respaldos conservar de una lista de fechas. */
export function retencionGFS(fechas, { diarios = 7, semanales = 4, mensuales = 12 } = {}) {
  const ordenadas = [...fechas].map((f) => new Date(f)).sort((a, b) => b - a)
  const conservar = new Set()
  const tomar = (clave, limite) => {
    const vistos = new Set()
    for (const f of ordenadas) {
      const k = clave(f)
      if (!vistos.has(k) && vistos.size < limite) {
        vistos.add(k)
        conservar.add(f.toISOString())
      }
    }
  }
  tomar((f) => f.toISOString().slice(0, 10), diarios)
  tomar((f) => {
    const d = new Date(Date.UTC(f.getUTCFullYear(), f.getUTCMonth(), f.getUTCDate()))
    d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7))
    return d.toISOString().slice(0, 10)
  }, semanales)
  tomar((f) => f.toISOString().slice(0, 7), mensuales)
  return conservar
}
