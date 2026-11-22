# Simulador de transacciones

Lanza compras contra la API, como si fueran muchos compradores a la vez, y mide cuántas salen bien, cuánto tardan y si algún asiento se vendió dos veces. Usa solo los endpoints de `docs/api-contrato.md`, así que funciona igual contra los *stubs* de la API que contra la API conectada a las bases.

No tiene dependencias: necesita Node 20 o más reciente.

## Uso

Con la API corriendo (`cd api; npm start`):

```bash
cd simulator
node run.js                                   # decenas: 50 compras, 10 a la vez
node run.js --perfil cientos                  # 500 compras, 50 a la vez
node run.js --perfil miles                    # 5,000 compras, 200 a la vez
node run.js --escenario preventa --perfil cientos
node run.js --duracion 60 --concurrencia 5    # compra sin parar durante 60 s
node run.js --url http://pc1:4000             # contra la API de otra PC
node run.js -h                                # todas las opciones
```

`--compras` y `--concurrencia` reemplazan los valores del perfil.

## Escenarios

**normal.** Cada comprador hace lo mismo que alguien en la página: elige un evento (del 1 al 40, los que tienen función), consulta sus funciones, consulta los asientos libres, elige de 1 a 4 y compra con un cliente (1 a 8,000) y un método de pago al azar.

**preventa.** Todos quieren un asiento de los mismos pocos de una función (por defecto, 10 asientos de la función 1; se cambian con `--asientos` y `--funcion`). Como máximo pueden salir bien tantas compras como asientos haya en disputa; las demás deben recibir 409. Sirve para probar que ningún asiento se vende dos veces.

En los dos escenarios, al final se juntan los asientos de todas las compras exitosas y se buscan repetidos. Si hay alguno, el reporte marca `Doble venta` con `¡REVISAR!` y el simulador termina con código 1.

## Reporte

En la consola, y completo en `resultados/<fecha>-<escenario>.json` (la carpeta no se versiona):

| Dato | Qué es |
|---|---|
| Compras | `POST /api/compras` que se hicieron, separados en 201, 409, 402, otros 4xx, 5xx y sin respuesta (API caída o timeout de 10 s) |
| Función agotada | Veces que la función elegida ya no tenía asientos libres. No es una falla |
| Fallas al consultar | Veces que falló un `GET` antes de comprar |
| TPS | Compras por segundo, y aparte las exitosas por segundo |
| Latencia | p50, p95, p99 y máximo del `POST /api/compras`, solo de las que tuvieron respuesta |
| Doble venta | Asientos vendidos y cuántos aparecen en más de una compra exitosa |
| Caída más larga | Segundos seguidos con errores y ninguna compra exitosa |
| `linea_de_tiempo` (solo en el JSON) | Por cada segundo: exitosas, rechazadas (409, 402 o función agotada) y errores |

Cuando un intento no llega a comprar (API caída o función agotada), el comprador espera 200 ms antes de volver a intentar.

## Medir una caída

Con `--duracion`, el simulador compra sin parar mientras se apaga un servicio (por ejemplo, el primario de PostgreSQL) y se recupera. `Caída más larga` dice cuántos segundos no hubo ninguna compra exitosa, y la `linea_de_tiempo` del JSON muestra en qué segundo empezó y terminó.

## Cosas a tener en cuenta con los *stubs*

- Los *stubs* tienen 40,000 asientos (1,000 por función) y los guardan en memoria. Con mucha concurrencia o con `--duracion` largas se agotan, y aparecen como `Función agotada`.
- **Al reiniciar la API, los *stubs* olvidan lo vendido** y vuelven a vender los mismos asientos, así que una corrida que atraviesa un reinicio de la API marca doble venta. Con las bases de datos esto no pasa: la revisión solo vale como evidencia contra la API real.

## Cómo se probó

Contra la API con *stubs* en una sola máquina:

| Corrida | Resultado |
|---|---|
| Decenas | 49 exitosas y 1 con 402. Doble venta 0 |
| Miles (5,000, 200 a la vez) | 4,799 exitosas, 82 con 409 y 119 con 402. 1,771 TPS, p95 de 69 ms. Doble venta 0 |
| Preventa (500 compradores por 10 asientos) | 10 exitosas y 490 con 409. Doble venta 0 |
| 30 s apagando la API unos 5 s | `Caída más larga`: 5 s, del segundo 18 al 22 |
