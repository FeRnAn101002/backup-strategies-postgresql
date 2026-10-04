import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  archivarJournal, backupFisico, backupLogico, compararHuellas, crearBaseDemo, crearInstancia,
  generarActividad, huella, provocarDesastre, restaurar, restaurarPITR, retencionGFS, verificarIntegridad,
} from '../src/backup.js'

const abiertas = []
const abrir = (pg) => (abiertas.push(pg), pg)
afterAll(async () => Promise.all(abiertas.map((pg) => pg.close())))

describe('estrategias de respaldo', () => {
  let pg
  beforeAll(async () => {
    pg = abrir(await crearInstancia())
    await crearBaseDemo(pg)
  })

  it('carga la base de demostración', async () => {
    const h = await huella(pg)
    expect(h.clientes.filas).toBe(40)
    expect(h.pedidos.filas).toBe(120)
    expect(h.detalle_pedido.filas).toBeGreaterThan(250)
  })

  it('respaldo lógico (pg_dump) se restaura idéntico', async () => {
    const b = await backupLogico(pg)
    expect(await b.datos.text()).toContain('PostgreSQL database dump')
    await provocarDesastre(pg, 'delete_sin_where')
    const { pg: nueva } = await restaurar(b)
    abrir(nueva)
    expect(compararHuellas(b.huella, await huella(nueva)).every((r) => r.ok)).toBe(true)
  })

  it('respaldo físico (directorio de datos) se restaura idéntico', async () => {
    const otra = abrir(await crearInstancia())
    await crearBaseDemo(otra)
    const b = await backupFisico(otra)
    await provocarDesastre(otra, 'drop_table')
    expect((await huella(otra)).clientes.md5).toBe('TABLA AUSENTE')
    const { pg: nueva } = await restaurar(b)
    abrir(nueva)
    expect(compararHuellas(b.huella, await huella(nueva)).every((r) => r.ok)).toBe(true)
  })

  it('detecta un respaldo alterado por su SHA-256', async () => {
    const otra = abrir(await crearInstancia())
    await crearBaseDemo(otra)
    const b = await backupLogico(otra)
    const alterado = { ...b, datos: new Blob([(await b.datos.text()).replace('Cliente 1', 'Cliente X')]) }
    expect(await verificarIntegridad(b)).toBe(true)
    expect(await verificarIntegridad(alterado)).toBe(false)
    await expect(restaurar(alterado)).rejects.toThrow(/corrupto/)
  })
})

describe('recuperación a un punto en el tiempo (PITR)', () => {
  it('recupera todo lo ocurrido después del respaldo y justo antes del desastre', async () => {
    const pg = abrir(await crearInstancia())
    await crearBaseDemo(pg)
    const archivo = []
    await archivarJournal(pg, archivo)
    const base = await backupFisico(pg)

    await generarActividad(pg, 4)            // cambios posteriores al respaldo
    await archivarJournal(pg, archivo)
    const antes = await huella(pg)
    const lsnAntes = archivo.at(-1).lsn

    await provocarDesastre(pg, 'delete_sin_where')
    await archivarJournal(pg, archivo)

    const { pg: recuperada, aplicados } = await restaurarPITR(base, archivo, lsnAntes)
    abrir(recuperada)
    expect(aplicados).toBeGreaterThan(0)
    expect(compararHuellas(antes, await huella(recuperada)).every((r) => r.ok)).toBe(true)
    // El respaldo completo, por sí solo, habría perdido la actividad posterior (RPO > 0).
    expect(compararHuellas(antes, base.huella).some((r) => !r.ok)).toBe(true)

    // La base recuperada sigue operando con normalidad (secuencias ajustadas).
    await generarActividad(recuperada, 1)
  })

  it('rechaza un punto anterior al respaldo base', async () => {
    const pg = abrir(await crearInstancia())
    await crearBaseDemo(pg)
    await generarActividad(pg, 1)
    const base = await backupFisico(pg)
    await expect(restaurarPITR(base, [], 1)).rejects.toThrow(/anterior/)
  })
})

describe('retención GFS', () => {
  it('conserva 7 diarios, 4 semanales y 12 mensuales sin duplicar', () => {
    const fechas = Array.from({ length: 400 }, (_, i) => new Date(Date.UTC(2026, 9, 3) - i * 86400000).toISOString())
    const keep = retencionGFS(fechas)
    expect(keep.size).toBeGreaterThanOrEqual(12)
    expect(keep.size).toBeLessThanOrEqual(23)
    expect(keep.has(fechas[0])).toBe(true)
  })
})
