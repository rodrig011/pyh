# Auditoría de ejecución y repositorios útiles

Se comparó `kalshi-research (1).json` con `kalshi-research.json`. El archivo
nuevo contiene 859 observaciones, 30 tickers y 29 mercados con observaciones
válidas y resultado oficial para evaluar el modelo. Todos los timestamps de
precio exportados pasan la comprobación de antigüedad de `brti-latest-v2`.
No se usaron cuentas reales, claves ni órdenes para esta investigación.

## Qué pasó con el dinero paper

| Perfil | Saldo anterior | Saldo nuevo | Cambio | Trades nuevos | Fees modeladas nuevas |
| --- | ---: | ---: | ---: | ---: | ---: |
| CAREFUL | $108.15 | $102.417 | −$5.733 | 57 | $13.98 |
| SCALP | $117.829 | $101.410 | −$16.419 | 174 | $41.08 |
| ALWAYS | $100.04 | $98.37 | −$1.67 | 23 | $4.52 |

Las fórmulas de entrada, salida, cantidad, fees y P/L cuadran en todos los
trades exportados. No faltan trades del reporte anterior ni hay claves
duplicadas. El deterioro es real dentro de esta simulación; no es un reset.

SCALP acumuló 211 trades en 29 mercados, con $52.50 de resultado bruto y
$51.09 de fees modeladas: queda **+$1.41**. El 97.3% del resultado bruto se
consumió en esas fees. Son 72 ganancias, 135 pérdidas y cuatro empates al
tratar residuos de hasta $0.00000001 como cero. El contador anterior puede
clasificar residuos como −$0.0000000000000002 como una pérdida; esta auditoría
no cambia los importes originales.

| Tipo de salida SCALP | Trades | P/L neto | Fees modeladas |
| --- | ---: | ---: | ---: |
| Corte por pérdida | 89 | −$44.230 | $20.00 |
| Cambio de lado del modelo | 66 | −$33.864 | $18.58 |
| Ganancia cobrada anticipadamente | 39 | +$26.208 | $9.20 |
| Liquidación oficial | 17 | +$53.296 | $3.31 |

Las 194 salidas anticipadas sumaron **−$51.886**, incluso antes de fees su
resultado agregado fue −$4.106. Las 17 liquidaciones ganadoras rescataron el
saldo. Esto **no demuestra que mantener todas las posiciones hasta liquidar
sería mejor**: las operaciones mantenidas fueron seleccionadas por la propia
política de salida.

## Fallos y decisiones sustentadas por los datos

### 1. SCALP estaba usando una ventaja de liquidación para una salida anticipada

`paperTick` abría directamente las oportunidades del motor. Ese motor descontaba
la comisión de entrada pero suponía liquidación, mientras la posición podía
venderse segundos después pagando otra comisión. La comprobación adicional
presente en otros flujos de scalping no estaba conectada a este perfil.

La nueva comprobación utiliza el objetivo hipotético del modelo, sin redondear
precios fraccionarios a centavos enteros:

`presupuesto = objetivo − entrada − fee(entrada) − fee(objetivo)`

Para SCALP debe cubrir el margen ya configurado de 0.25¢. Se aplica en el motor
compartido que consultan paper y las señales live SCALP. No supone que el precio
objetivo vaya a alcanzarse ni que exista una orden disponible a ese precio.

Aplicada descriptivamente a las entradas guardadas:

| Presupuesto en el momento de entrada | Trades | P/L observado original |
| --- | ---: | ---: |
| No cubría ambas fees y margen | 139 | −$19.148 |
| Sí los cubría | 72 | +$20.558 |

No se eligió un nuevo umbral buscando el mayor retorno. Se conectó un requisito
de costos a un perfil que ya planeaba salir antes. **Esta partición no es un
backtest de la versión nueva**: conservar tamaños y salidas originales tras
eliminar otras entradas ignora los cambios en capital y posiciones disponibles.
El chequeo preliminar con fees al precio de entrada daba 140 casos; el cálculo
final usa la fee del precio objetivo y da 139.

### 2. Las salidas comparaban con un importe que la venta no entregaría

Los cortes y cobros anticipados comparaban el valor del modelo con el bid bruto.
Una venta a 50¢ con 2¢ de fee entrega 48¢: si el modelo valora mantener en 50¢,
vender no mejora su propio valor esperado. La comparación ahora usa el bid
menos la comisión de salida. El costo de entrada ya pagado no se vuelve a
descontar en esta comparación. Los stops configurados y las señales contrarias
siguen disponibles.

Faltaba la probabilidad exacta al salir en las 194 salidas anticipadas de SCALP.
No se sustituyó por una observación cercana de otro instante. Las próximas
salidas guardarán probabilidad, bid, fee, valor neto de venta, decisión y
timestamps para que este problema pueda medirse trade por trade.

### 3. Hay mucha rotación, pero una pausa arbitraria no está validada

SCALP hizo hasta 17 operaciones en un contrato. La mediana de tiempo en una
posición y de espera para reentrar fueron aproximadamente 20 segundos.
Las 67 reentradas cambiando de lado sumaron −$13.783.

Sin embargo, las 126 reentradas ocurridas dentro de 30 segundos sumaron
**+$10.10**. No se añadió un cooldown elegido retrospectivamente ni un límite
nuevo de trades con la afirmación de que mejoraría la ganancia. Es necesario
comparar políticas completas, incluyendo oportunidades perdidas y capital.

### 4. El historial de investigación perdía una variable usada al operar

Las 859 observaciones tenían CVD ausente. El recorder no recibía la cinta de
trades, aunque el flujo de entradas paper sí podía consultarla. Se conectó una
consulta acotada de los últimos 100 trades del contrato, con timeout de 1.5s,
para registrar CVD cuando haya datos. Si falla, queda ausente; no se inventa.
OFI sigue siendo una medición entre snapshots del contrato Kalshi, no el flujo
completo de todos los exchanges de BTC.

### 5. Las fees del paper son aproximadas

El simulador redondea la fee de cada contrato hacia arriba a un centavo y luego
multiplica por cantidad. Kalshi documenta fees, redondeo y acumulación a nivel
de fills/orden, con precisión de saldo diferente según el tipo de miembro.
Por eso los $51.09 son **costos del simulador**, no una factura de Kalshi.
[Redondeo oficial](https://docs.kalshi.com/getting_started/fee_rounding),
[tarifario](https://kalshi.com/docs/kalshi-fee-schedule.pdf).

No se rebajaron retrospectivamente esos costos ni se incrementó el saldo para
presentar una mejora. La exportación ahora declara esta limitación. Una
reconciliación exacta requerirá fills, multiplicador de fees y precisión de la
cuenta; el precio cotizado por sí solo no los demuestra.

## El modelo frente al precio de Kalshi

Se seleccionó una observación por mercado, a no más de 20 segundos del horizonte
indicado, con resultado oficial y precio verificado. Menor Brier es mejor.

| Horizonte | Mercados | Brier modelo | Brier mercado | Aciertos modelo / mercado |
| --- | ---: | ---: | ---: | ---: |
| 10 minutos antes del cierre | 29 | 0.199713 | 0.202685 | 22 / 22 |
| 5 minutos antes del cierre | 29 | 0.080736 | 0.087791 | 24 / 25 |

La estimación probabilística ya no presenta en esta muestra el desastre del
lector de una hora de retraso. La pequeña ventaja Brier es descriptiva, no
significancia estadística ni prueba de rentabilidad. A cinco minutos, Kalshi
acertó más lados aunque tuvo un Brier algo peor. Acertar el lado, estimar bien
una probabilidad y ganar al precio ejecutable son objetivos diferentes.

El modelo conserva coeficientes heurísticos: 0.4 para microestructura y 0.05
para tendencia en log-odds. No aprendió coeficientes nuevos de estos 29 mercados.
La nota A/B/C mide cobertura de evidencia, no una frecuencia de victorias
demostrada. El reporte no tiene todavía mercados de validación fuera de muestra.

## Repositorios investigados y qué sirve

Se hicieron búsquedas web y de repositorios GitHub, incluyendo 15 candidatos
en la búsqueda `kalshi btc`. La selección siguiente se basa en utilidad
técnica; no es una revisión exhaustiva de todo GitHub. Ningún código externo se
ejecutó, recibió credenciales o se incorporó como dependencia.

| Proyecto | Utilidad concreta | Límite |
| --- | --- | --- |
| [AllAboutAI-YT/kalshi-btc15-ml-experiment](https://github.com/AllAboutAI-YT/kalshi-btc15-ml-experiment) | Modelo de corrección respecto al precio de Kalshi, cortes temporales, walk-forward, separación de un día y prueba final reservada. | Educativo, sin datos históricos redistribuidos ni ejecución live; su mejora declarada no prueba una ventaja estable. |
| [routsiddharth/vela](https://github.com/routsiddharth/vela) | TWAP, estudio de frecuencia, calibración de fills y comparación entre probabilidades y fills que realmente se ejecutan. | Propios supuestos y resultados; no transfieren una rentabilidad a nuestro bot. |
| [nkaz001/hftbacktest](https://github.com/nkaz001/hftbacktest) | Latencia, colas, profundidad y fills parciales para reducir la distancia entre paper y ejecución. | No es un modelo de liquidación Kalshi; necesita datos L2/L3 y una adaptación. |
| [karma659/kalshi-btc-trading-engine](https://github.com/karma659/kalshi-btc-trading-engine) | Separación de señal, órdenes confirmadas y replay; experimentos con modelos y control por ticker. | Su propio código describe problemas de reentradas y modelos de salida; sus métricas no son evidencia independiente de ganancias. |
| [Quentin-Piot/prediction-market-backtester](https://github.com/Quentin-Piot/prediction-market-backtester) | Separar predicción, ejecución y contabilidad en experimentos reproducibles. | Documenta fills inmediatos sin modelo completo de profundidad/ejecución parcial. |
| [freqtrade/freqtrade](https://github.com/freqtrade/freqtrade) | Comprobar que una estrategia no usa datos del futuro al repetir backtests con datos recortados. | No es un adaptador de contratos binarios Kalshi. |

Se inspeccionó código concreto en
[train.py, revisión 19a152b](https://github.com/AllAboutAI-YT/kalshi-btc15-ml-experiment/blob/19a152bd779a8ff26dc3af9ea14e09c3d869cbfa/train.py),
[a4_frequency.py](https://github.com/routsiddharth/vela/blob/ecade821de06c98a6e025229c5554404236345e1/backtest/strategy_search/a4_frequency.py),
[step3_fill_calibration.py](https://github.com/routsiddharth/vela/blob/ecade821de06c98a6e025229c5554404236345e1/analysis/step3_fill_calibration.py) y
[strategy13.js](https://github.com/karma659/kalshi-btc-trading-engine/blob/e3923eab2ddc1a7327ca02c148e2e1ccf4d0cfca/backend/strategy13.js).
Se revisaron también las limitaciones de [fills de hftbacktest](https://hftbacktest.readthedocs.io/en/latest/order_fill.html)
y el [análisis de información futura de Freqtrade](https://www.freqtrade.io/en/stable/lookahead-analysis/).

## Cambios, pruebas y siguiente medición

- Presupuesto de ambas fees conectado al perfil SCALP compartido por paper y señales live.
- Comparación de salida con cobro neto; conservación de stops y reversals.
- Evidencia de entrada/salida versionada `scalp-cost-v1`, sin borrar historia.
- CVD conectado al recorder, diagnóstico de salidas incompletas y empates numéricos.
- Auditor offline reproducible, sin credenciales ni órdenes.
- Suite completa: **1,307 pruebas aprobadas**; seis regresiones nuevas cubren
  los costos de ambos lados, precios fraccionarios, valoración de salidas,
  stops, exportación, CVD y contabilidad.

La comparación siguiente debe separar trades `scalp-cost-v1` de los anteriores
y medir neto después de fees, rotación, pérdida máxima y diferencia entre valor
de mantener y cobro de vender. Las probabilidades necesitan pruebas cronológicas
contra el precio de Kalshi, y las ejecuciones necesitan profundidad y latencia.
No se afirma que el filtro ya ganó los $19.15 ni que la ganancia esté asegurada.

Para reproducir la auditoría, desde `discord-bot/`:

```sh
node scripts/audit-execution.mjs '/ruta/kalshi-research (1).json' '/ruta/kalshi-research.json'
```
