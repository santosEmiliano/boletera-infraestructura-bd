# Boletera

Proyecto Final de Ingeniería de Datos (UAA, 2026). Plataforma de venta de boletos para eventos que usa **MySQL, PostgreSQL y MongoDB** sobre tres computadoras físicas, con fragmentación, replicación, monitoreo con Prometheus y Grafana, y un simulador de carga.

Equipo de dos integrantes.

## Estructura

```
docs/          arquitectura, inventario, bitácora, procedimientos de falla
infra/         archivos de Docker Compose por PC y configuración de monitoreo
mysql/         esquema, seeds y configuración de Group Replication
postgres/      esquema, seeds y scripts de replicación
mongo/         scripts de replica sets y sharding, seeds
api/           backend Express que conecta los tres motores
simulator/     simulador de transacciones
```

## Dónde empezar

- `docs/arquitectura.md`: qué corre en cada PC y por qué.
- `docs/bitacora.md`: problemas encontrados y cómo se resolvieron.

Las contraseñas y variables de entorno van en `.env` (no se versiona); cada carpeta de `infra/` tendrá su `.env.example`.
