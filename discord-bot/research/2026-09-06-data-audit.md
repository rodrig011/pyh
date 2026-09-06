# Auditoría del precio BRTI y del reporte 6

## Resultado principal

El lector elegía el primer valor de `/cfbenchmarks/values?id=BRTI` y lo
fechaba con la hora de recepción. CF Benchmarks documenta que ese endpoint
devuelve una hora de valores RTI en orden temporal ascendente. Por tanto,
el primer registro puede tener aproximadamente una hora de retraso.
[CF Benchmarks, Values](https://docs.cfbenchmarks.com/api/rest/values/).

El reporte 6 contiene 1,804 observaciones de 63 contratos. Su comparación
temporal respalda este diagnóstico. Usando las mismas 57 ventanas, se compara
el strike con la media de los precios registrados durante el minuto previo al
inicio del contrato, desplazando las horas de registro:

| Desplazamiento del registro | Ventanas | Error absoluto mediano | RMSE |
| --- | ---: | ---: | ---: |
| 0 minutos | 57 | $74.49 | $119.17 |
| 15 minutos | 57 | $81.55 | $110.30 |
| 30 minutos | 57 | $69.23 | $95.36 |
| 45 minutos | 57 | $39.05 | $69.25 |
| 60 minutos | 57 | $1.24 | $2.66 |
| 75 minutos | 57 | $39.85 | $68.87 |

Los datos publicados una hora después encajan mucho mejor con el strike.
Esta comparación diagnostica un desfase; usa observaciones posteriores y **no
es un backtest operable**. El reporte carece de timestamps originales BRTI y
del cuerpo HTTP, por lo que no permite reconstruir cada precio correcto
disponible en tiempo real. Una consulta pública del contrato desde este entorno
recibió HTTP 403; no se usaron credenciales reales para afirmar una verificación.

## Resultados registrados

| Grupo | Trades cerrados | W | L | P/L neto | Fees incluidos |
| --- | ---: | ---: | ---: | ---: | ---: |
| ALWAYS, reporte 6 completo | 63 | 35 | 28 | +$5.656 | $14.90 |
| Nuevos respecto al reporte 5 | 41 | 22 | 19 | −$4.184 | $9.70 |
| Entradas forzadas | 9 | 2 | 7 | −$1.750 | $1.68 |
| Entradas aceptadas por el modelo | 54 | 33 | 21 | +$7.406 | $13.22 |

Saldo paper registrado: $105.656 desde $100. Son resultados simulados del
ledger; no demuestran fills ni ganancias reales. Los 41 trades nuevos ganaron
el 53.66% de las veces y aun así perdieron $4.18 netos.

Las 16 entradas con probabilidad del lado comprado **≥99%** acertaron el
resultado oficial de liquidación en **8 casos y fallaron en 8**. Sus cierres
paper fueron 9 positivos y 7 negativos, con **−$10.76** netos: dos se cerraron
antes del vencimiento. W/L del trade y acierto de liquidación son mediciones
distintas.

Con una observación por contrato, la más cercana a cinco minutos del cierre,
hay 62 contratos con resultado oficial y probabilidad registrada: Brier del
modelo **0.362139**, frente a **0.142539** del punto medio de Kalshi. Menor es
mejor. El Brier mide error probabilístico global; la calibración requiere
también comparar frecuencias observadas por rango de probabilidad.
[Scikit-learn, calibración](https://scikit-learn.org/stable/modules/calibration.html).

En 27 contratos, las pocas muestras del último minuto quedaron del lado
opuesto al resultado oficial. Una media de dos muestras no es la liquidación
oficial de 60 segundos; esta discrepancia sirve para detectar el problema de
datos, no para cambiar retrospectivamente el resultado de Kalshi.

## Último mercado del reporte

`KXBTC15M-26SEP061330-30`: entrada UP a 58¢, salida a 88¢, ocho contratos,
$0.24 de fees totales. P/L = 8 × ($0.88 − $0.58) − $0.24 = **+$2.16**.
El ledger dice `model flipped`, una salida anticipada. El resultado oficial
de ese contrato todavía no aparece en el archivo.

La última observación registra BTC $79,687.05, strike $79,628.73 y 558.586
segundos restantes; YES bid/ask 88¢/89¢ y probabilidad del modelo 85.488%.
El precio BTC pertenece al flujo afectado por el desfase: esta observación no
sustenta una recomendación actual ni una probabilidad recalibrada.

## Correcciones

- Selección BRTI por timestamp de cálculo, con soporte de orden ascendente o
  descendente. Rechazo de otro índice, valores repetidos, tiempos ausentes,
  valores malformados y precios con más de 15 segundos de antigüedad.
- Historial del proveedor convertido a intervalos de 30 segundos para cargar
  gráfica y volatilidad al arrancar. La inferencia excluye muestras del lector
  anterior; los registros previos permanecen disponibles para auditoría.
- Lectura real del libro Kalshi, reconstrucción de asks desde bids NO y
  profundidad cercana al mejor precio. OFI calculado entre snapshots del mismo
  ticker; CVD y desequilibrio se conservan como señales distintas. OFI es una
  medida muestreada del contrato, no flujo completo de exchanges BTC.
  [Formato oficial del libro](https://docs.kalshi.com/getting_started/orderbook_responses).
- El umbral de liquidez de ejecución de ALWAYS ya no elimina la penalización
  de confianza por libro fino. Las unidades dependen del campo de la API:
  `yes_bid=1` significa 1¢ y `yes_bid_dollars=1` significa 100¢.
- El último minuto utiliza los segundos BRTI ya observados en el promedio.
  Si falta esa historia, el motor lo declara en lugar de usar el spot actual
  como si todo el promedio estuviera por ocurrir.
- El precio de entrada se valida en el lado que se compraría. Una entrada
  rechazada por precio o tiempo conserva una evaluación disponible para
  gestionar la posición existente.
- Motivos numéricos de entrada, hora del proveedor y evidencias en la
  exportación v2. La validación de producción excluye observaciones antiguas
  sin timestamps verificados; su historial y P/L no se reinician.

Se revisaron también [Vela](https://github.com/routsiddharth/vela), un proyecto
público sobre liquidación TWAP de Kalshi, y el trabajo de
[Cont, Kukanov y Stoikov](https://arxiv.org/abs/1011.6402) sobre OFI. Sus resultados
no validan este bot ni sus coeficientes. No se copiaron claves, credenciales,
estrategias ejecutables ni cifras de rentabilidad como prueba propia.

## Verificación y límites

La suite completa pasó **1,301/1,301**. Diez regresiones nuevas cubren el
desfase de una hora, timestamps, arranque con historial, unidades, profundidad,
OFI, promedio de liquidación, gestión de salidas y exclusión de datos antiguos.

Un test anterior exigía más de 25% de retorno en una única trayectoria
artificial. Con las salidas corregidas, esa trayectoria produjo +39.11% con
sesgo +6¢ y −8.54% con sesgo −6¢. Se reemplazó esa garantía de una sola semilla
por ocho trayectorias fijas en ambos sentidos, incluyendo las perdedoras. La
simulación verifica comportamiento bajo supuestos; no demuestra rentabilidad
en Kalshi. No se eligieron nuevos umbrales de trading a partir de esos retornos.

La mejora demostrada es la integridad del precio y del cálculo. El éxito o la
ganancia de la nueva versión necesitan mercados posteriores con el flujo
corregido y ejecución medible. No se reajustan probabilidades con los datos
desfasados ni se atribuyen ganancias retrospectivas al arreglo.

Para reproducir los números, desde `discord-bot/`:

```sh
node scripts/audit-research.mjs '/ruta/kalshi-research 6.json' '/ruta/kalshi-research 5.json'
```
