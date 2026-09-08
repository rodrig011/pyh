# Búsqueda de rentabilidad: entradas y salidas comparables

## Resultado principal

La hipótesis más útil encontrada es **conservar la primera entrada de cada
mercado hasta la liquidación oficial**. Superó a las salidas registradas en
los archivos anteriores y en los mercados posteriores. No se encontró una
mejora uniforme añadiendo confirmaciones de flujo, tendencia o edge mínimo.

Esto es evidencia histórica exploratoria, no una estrategia validada para
dinero real. Los archivos ya habían sido inspeccionados. La separación temporal
evita elegir la política con los resultados posteriores dentro del programa;
no convierte retrospectivamente esos archivos en una prueba nunca vista.

## Datos y protocolo

Entrenamiento: `kalshi-research (1).json` y `kalshi-research 7.json`.
Evaluación posterior: `kalshi-research (2).json`, exportado el 8 de septiembre
de 2026 a las 20:44:46 UTC. El corte de entrenamiento es el 7 de septiembre a
las 07:13:44 UTC. Se excluyen del periodo posterior todos los tickers ya
observados en entrenamiento, además de entradas anteriores al corte.

Se usa solo la primera entrada registrada de cada perfil y ticker. Los
archivos anteriores recuperan las filas truncadas del inicio de SCALP. Los
resultados tienen que proceder de `kalshi-market:official-result`; una etiqueta
contradictoria se excluye. Entrenamiento usa únicamente cierres y etiquetas
disponibles en los archivos anteriores.

Cada operación se normaliza a **un contrato**, manteniendo el costo por
contrato de su entrada original. No se simula reinversión, capital disponible
ni otra secuencia de entradas después de mantener. Se añade un costo adverso
de **1¢ por entrada y 1¢ por venta anticipada**, además de las fees existentes.
Se mantienen las comisiones conservadoras para no atribuir la mejora a una
reducción de costos en el cálculo.

Las salidas alternativas deciden con una observación y ejecutan con la
cotización siguiente, dentro de 45 segundos. El historial tiene un intervalo
típico de 30 segundos. Si no existe esa cotización, el resultado queda sin
resolver: no se inventa una venta al precio del disparador. Un objetivo de
ganancia alcanzado puede terminar en pérdida si el siguiente bid empeora.

## Cinco políticas de salida

1. `recorded`: salida original, con el costo adverso adicional.
2. `settle`: mantener hasta el resultado oficial.
3. `target_10`: intentar vender cuando el beneficio neto observado alcanza 10¢.
4. `timed_120`: intentar vender al cumplirse dos minutos desde la entrada.
5. `flow_reversal`: intentar vender cuando al menos dos de OFI, CVD y desequilibrio
   del libro estén en contra con magnitud superior a 0.20. Si faltan datos,
   esta política espera; no fabrica una confirmación. El JSON informa cuántas
   observaciones completas de flujo existían.

La selección se hace por beneficio medio en entrenamiento sobre los mismos
mercados con ejecución observable en todas las políticas, mínimo 20 mercados.
En los tres perfiles se seleccionó `settle`.

Resultado posterior de mantener frente a las salidas originales, con
exactamente las mismas entradas y cobertura completa en ambas alternativas:

| Perfil | Mercados posteriores | Salida registrada | Mantener | W manteniendo |
|---|---:|---:|---:|---:|
| CAREFUL | 137 | −$6.81 | +$8.173 | 88 / 137 |
| SCALP | 146 | −$7.997 | +$8.361 | 88 / 146 |
| ALWAYS | 149 | −$8.821 | +$1.989 | 84 / 149 |

Estos importes son sumas de resultados normalizados, **no saldos de cuentas**.
Los perfiles observan muchos de los mismos mercados: sus resultados no son
tres pruebas independientes y no deben sumarse como una cartera ejecutable.

Las otras salidas dieron estos resultados posteriores:

| Política | CAREFUL: P/L / mercados resueltos | SCALP: P/L / mercados resueltos | ALWAYS: P/L / mercados resueltos |
|---|---:|---:|---:|
| Objetivo neto 10¢ | −$0.806 / 134 | −$3.979 / 145 | −$7.269 / 149 |
| Cierre a 120s | −$8.546 / 132 | −$7.930 / 145 | −$6.611 / 149 |
| Reversión del flujo | −$9.203 / 137 | −$7.671 / 146 | −$6.560 / 149 |

Los resultados sin cotización de ejecución no están incluidos en esas sumas.
El JSON también produce una comparación sobre el subconjunto común completo
para evitar que la cobertura diferente determine la selección.

La aproximación normal del límite inferior del 95% para el beneficio medio
de `settle` sigue por debajo de cero: CAREFUL −1.33¢, SCALP −1.83¢, ALWAYS
−6.59¢ por mercado. Además, no corrige la dependencia entre ventanas de BTC
ni la comparación de varias hipótesis. **Todavía no demuestra rentabilidad
estable**, aunque justifica una comparación prospectiva.

## Cinco criterios de entrada

Con salida a liquidación se comparan: todas las primeras entradas, confirmación
de flujo (dos de tres mediciones alineadas y todas disponibles), tendencia
alineada con fuerza de al menos 0.30, edge registrado de al menos 6¢, y precio
entre 25¢ y 75¢. No se busca una segunda entrada si la primera no pasa.

| Criterio | CAREFUL posterior | SCALP posterior | ALWAYS posterior |
|---|---:|---:|---:|
| Todas | +$8.173, 137 trades | +$8.361, 146 trades | +$1.989, 149 trades |
| Flujo alineado | +$1.298, 77 | +$5.254, 98 | −$6.400, 51 |
| Tendencia alineada | +$5.650, 62 | +$4.860, 61 | +$3.540, 37 |
| Edge ≥6¢ | +$1.175, 36 | +$1.050, 15 | +$0.900, 4 |
| Precio 25–75¢ | +$6.420, 117 | +$6.600, 132 | +$1.770, 147 |

Sobre las mismas oportunidades de entrenamiento, y exigiendo al menos 20
trades anteriores, el criterio de mayor beneficio acumulado fue 25–75¢ para
CAREFUL/SCALP y todas las entradas para ALWAYS. Las oportunidades rechazadas
aportan cero; no se cuentan como victorias. En el periodo posterior ese filtro
de precio no superó a conservar todas las primeras entradas. No se implementó
como una supuesta mejora ganadora.

## Fuentes externas revisadas

- [AllAboutAI: Kalshi BTC15 ML](https://github.com/AllAboutAI-YT/kalshi-btc15-ml-experiment):
  compara una corrección del modelo respecto al precio del mercado y separa
  cronológicamente entrenamiento y evaluación. Su propio README reconoce que
  el intervalo de la mejora publicada cruza cero. Es una referencia metodológica,
  no un bot rentable listo para copiar.
- [RL Trader para BTC horario](https://github.com/VishalBalaji13/RL-Trader-for-Kalshi-Bitcoin-Hourly-Markets):
  propone acciones de comprar, mantener y cerrar, tamaño fijo y penalización
  por rotación. El README muestra ejecución en demo, no una prueba reproducible
  de ganancias netas en BTC15. No se instaló ni ejecutó ese código.
- [HftBacktest: modelos de ejecución](https://hftbacktest.readthedocs.io/en/latest/order_fill.html):
  las colas, cantidades y latencia importan; que el precio toque un límite no
  basta para demostrar una ejecución. Nuestro historial no permite evaluar con
  rigor market making ni suponer que habríamos capturado el spread.
- [Cont, Kukanov y Stoikov](https://arxiv.org/abs/1011.6402): estudian la relación
  entre flujo de órdenes e impacto en precios de acciones. Motiva una hipótesis
  sobre flujo; no demuestra que el mismo filtro sea rentable en Kalshi. Los
  resultados locales anteriores son los que deciden si ese filtro ayuda.

El arbitraje entre plataformas requiere cotizaciones simultáneas, contratos
con reglas de liquidación compatibles y costos/ejecución en ambas. Esos datos
no están en estos reportes. Tampoco hay evidencia aquí para presentar un modelo
de reinforcement learning como una mejora sobre las reglas simples.

## Cambio implementado para comprobarlo hacia adelante

`paired-exits-v1` observa pasivamente la **primera entrada nueva** de cada
mercado y perfil. Registra su costo por contrato. Cuando el bot sale, guarda
su beneficio normalizado; cuando Kalshi publica el resultado del mismo ticker,
calcula cuánto habría dado mantener. Consulta también contratos que el bot ya
vendió. No usa el precio local de BTC para decidir una liquidación.

El estudio se guarda con la cuenta, sobrevive reinicios y se archiva al reset
paper. Un redeploy a mitad de mercado no convierte una reentrada antigua en
una nueva primera entrada. La comparación usa solo pares completos y muestra
cuántos faltan por liquidar.

El dashboard muestra ambos resultados como una comparación de investigación,
separada del dinero de la cuenta. El export incluye los registros permitidos
y versiones de implementación. No cambia las entradas, salidas ni órdenes de
la estrategia actual; esta versión agrega evidencia prospectiva para decidir
una modificación posterior. También contiene las correcciones `bounded-risk-v2`
del commit anterior, que no estaban documentadas en el último archivo recibido.

No se alteraron saldos ni trades históricos. No se armó ni desplegó live trading.
No hay promoción automática a dinero real de ninguna hipótesis.

Verificación: **1,330/1,330 pruebas aprobadas**, incluyendo nueve pruebas del
estudio: entrada real del simulador, resultado oficial, reentradas, reinicios,
archivo de resets, consultas después de vender, datos exportados, ejecución
posterior al disparador, datos ausentes y separación temporal.

Reproducción desde `discord-bot/`:

```sh
node scripts/compare-exits.mjs '/ruta/kalshi-research (1).json' '/ruta/kalshi-research 7.json' '/ruta/kalshi-research (2).json'
```
