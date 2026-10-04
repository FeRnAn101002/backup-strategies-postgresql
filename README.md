# 🛟 PgBackupLab — Estrategias de respaldo en PostgreSQL

[![CI/CD - GitHub Pages](https://github.com/FeRnAn101002/backup-strategies-postgresql/actions/workflows/deploy.yml/badge.svg)](https://github.com/FeRnAn101002/backup-strategies-postgresql/actions/workflows/deploy.yml)
[![Simulacro semanal de restauración](https://github.com/FeRnAn101002/backup-strategies-postgresql/actions/workflows/simulacro.yml/badge.svg)](https://github.com/FeRnAn101002/backup-strategies-postgresql/actions/workflows/simulacro.yml)

**Demo en vivo:** <https://fernan101002.github.io/backup-strategies-postgresql/>

Laboratorio interactivo para practicar las tres estrategias clásicas de respaldo de PostgreSQL
sobre un **PostgreSQL 18 real** que se ejecuta en el navegador con WebAssembly ([PGlite](https://pglite.dev)).
No necesita servidor ni instalación.

| Estrategia | Herramienta equivalente en producción | Qué demuestra |
|---|---|---|
| Respaldo **lógico** completo | `pg_dump` (es el propio pg_dump compilado a WebAssembly) | Script SQL portable, instantánea consistente |
| Respaldo **físico** completo | `pg_basebackup` | Copia del directorio de datos, restauración rápida |
| **Continuo / PITR** | Archivado de WAL (`archive_command`, pgBackRest, WAL-G) | Recuperar hasta el instante previo a un error |

Además: provocación de desastres (DELETE sin WHERE, UPDATE masivo, TRUNCATE, DROP TABLE),
restauración en una **instancia nueva**, verificación por **huellas** (filas + MD5 por tabla),
integridad por **SHA-256**, medición de **RTO/RPO** y política de retención **GFS**.

> El "archivo de cambios" de la estrategia PITR se implementa con triggers que registran cada fila
> modificada (un WAL *lógico*), porque PGlite no expone el WAL físico. El concepto —respaldo base +
> reproducción ordenada de cambios hasta un punto— es el mismo que usa PostgreSQL.

## Uso

1. **Respaldar** → *Físico completo*.
2. **Generar actividad** varias veces (simula ventas después del respaldo).
3. **Provocar un desastre** → *DELETE sin WHERE en pedidos*.
4. **Recuperar** → elige el respaldo físico y el último punto **antes** del desastre → *Restaurar*.
5. Compara las huellas, revisa el RTO medido y pulsa *Promover a producción*.

## Desarrollo

```bash
npm ci
npm test        # respaldo lógico, físico, PITR, SHA-256 y GFS contra PostgreSQL real
npm run dev     # http://localhost:5173
npm run build   # genera dist/
```

## Automatización

- `deploy.yml`: en cada push a `main` ejecuta las pruebas, construye y publica en **GitHub Pages**; termina con una prueba de humo.
- `simulacro.yml`: cada lunes repite el ciclo respaldar → desastre → restaurar → verificar (un respaldo que no se prueba no es un respaldo).

## Autor

Luis Fernando Vilca Barrientos — Base de Datos II, Universidad Privada de Tacna (2026).

Licencia MIT.
