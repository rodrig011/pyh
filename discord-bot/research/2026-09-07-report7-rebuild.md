# Reporte 7: pérdidas, correcciones y prueba temporal

Se auditó `kalshi-research 7.json`, exportado el 7 de septiembre de 2026 a las
07:13:44 UTC. Contiene 600 observaciones con `brti-latest-v2` y 20 mercados con
resultado oficial. Todas las operaciones llevan `scalp-cost-v1`: la revisión
anterior sí estaba activa. Sus correcciones de costos no fueron suficientes
para hacer rentable la estrategia.

## Qué demuestra este archivo

| Perfil | Cierres | W / L / empate | P/L cerrado | Fees paper incluidas | Cash exportado |
|---|---:|---:|---:|---:|---:|
| CAREFUL | 49 | 13 / 36 / 0 | −$25.529 | $9.47 | $70.371 |
| SCALP | 67 | 19 / 48 / 0 | −$51.541 | $20.23 | $45.259 |
| ALWAYS | 21 | 9 / 11 / 1 | −$2.009 | $3.02 | $97.991 |

SCALP perdió **$31.311 antes de fees**, además de las comisiones. Su tasa de
operaciones cerradas positivas fue 28.36%. No basta con abaratar fees.
Los 56 cierres anticipados sumaron −$55.554; las 11 liquidaciones sumaron
+$4.013. Las 19 reentradas cambiando de lado sumaron −$35.898. Estas categorías
se solapan; no se pueden sumar como pérdidas independientes ni prueban que
mantener todas las posiciones hasta el cierre habría sido rentable.

La aritmética de cantidad, precios, costos y P/L cuadra. Pero el archivo no
exportaba posiciones abiertas. La diferencia entre cash y capital inicial más
P/L cerrado es −$4.10 para CAREFUL y −$3.20 para SCALP. Puede ser capital abierto,
pero este JSON por sí solo no lo demuestra. La nueva exportación incluye las
posiciones y sus costos para cerrar esa reconciliación sin adivinar.

El archivo anterior contenía 314 trades entre los tres perfiles; ninguno está
en el reporte 7, cuyo periodo comienza después. También desaparecen las
observaciones anteriores. No es una truncación normal del ledger de 500 filas.
El código auto-start conserva cuentas existentes; sin el volumen/configuración
de Railway no se puede atribuir el reinicio a una causa concreta. Los archivos
subidos conservan los datos antiguos. No se reescribió el cash para importarlos.

## Fallos de implementación y cambios

### Límite de tiempo desconectado

SCALP declaraba `noEntryWithinSeconds: 60` en la política de scalp, pero el
camino que abre posiciones usaba `minimumSecondsLeft: 20`. CAREFUL tenía una
discrepancia similar entre 120 y 45 segundos. Ambos límites ahora coinciden:
CAREFUL 120s, SCALP 60s. Los perfiles live compartidos heredan esos valores.

La peor operación SCALP fue `KXBTC15M-26SEP070300-00`: UP a 31¢, 41 contratos,
costo $13.53 y 24.316 segundos restantes. Diez segundos después vendió a 3.1¢
con −$12.669 netos. La estimación pasó de 69.74% a aproximadamente 0.00155%.
La entrada nueva se rechaza por el límite de tiempo. Esto reproduce un fallo
concreto; no es una simulación del retorno total de la nueva versión.

### Tamaño y riesgo repetido

Los límites predeterminados por entrada eran 10% CAREFUL y 20% SCALP. Ahora
ambos perfiles usan cuarto de Kelly y un máximo de 2%. En paper el presupuesto
incluye entrada y fee; la cantidad no puede exceder el tamaño disponible al
precio de compra si ese dato existe.

CAREFUL/SCALP paper mantienen además un presupuesto por ticker: las compras
acumuladas no exceden 5% del cash al comenzar a operar ese ticker. Las ganancias
no lo rellenan. Se guarda con la cuenta y sobrevive cierres y reinicios.
Es un límite de exposición y rotación, no un supuesto umbral óptimo aprendido
del reporte 7. Los overrides explícitos de tamaño en llamadas internas siguen
existiendo; 2% es el nuevo default. El control ALWAYS conserva una entrada por
ticker y su política de benchmark.

Las señales live comparten los defaults de tamaño y tiempo, y su cálculo de
cantidad contempla fees. Su presupuesto real sigue bajo los límites existentes
de la cuenta; el límite paper de 5% por ticker no se presenta como una protección
live que no se haya implementado. No se armó ni desplegó live trading.

### Caps que no limitaban la probabilidad

El score de cobertura podía decir 70 o 90 mientras la probabilidad del modelo
superaba ese porcentaje. El cap ahora afecta Fair P(YES)/P(NO), manteniendo la
suma en 1. Las penalizaciones de liquidez y volatilidad afectan ese techo.
Un booleano de "calibrado" no basta para autorizar probabilidades excepcionales.

El modelo bruto se conserva para auditar. Al recortar YES de casi 100% a 90%,
no se convierte automáticamente el NO en una oportunidad del 10%: cada lado
usa la estimación menos optimista entre la bruta y la limitada para calcular
su edge, y el intervalo conserva ambos escenarios. Esto evita crear una
oportunidad artificial por el propio cap.

Estos caps son una política de evidencia, **no calibración estadística**. La
interfaz identifica explícitamente el score como cobertura de datos, no tasa
de victorias. Dentro del último minuto, la distancia en sigma usa la referencia
de la media de liquidación; también se conserva la distancia sigma del spot.

### Salidas con datos diferentes y umbral equivocado

La entrada paper recibía la cinta del ticker a través de `readBoard`, pero
`holdTick` llamaba directamente a `directionalRead` y omitía esa selección.
Ahora entrada y salida reciben CVD del mismo ticker. El recorrido live también
consulta la cinta del contrato que está sosteniendo.

Las salidas suaves requieren que el cobro neto supere el extremo superior del
valor estimado de mantener, además del margen. Una nueva señal de entrada del
lado contrario no basta por sí sola cuando mantener todavía tiene más valor
según esos mismos datos. Los stops explícitos siguen actuando; una venta cuyos
ingresos se consuman completamente en fees se identifica como no útil.

El reporte contenía una venta paper a 0.6¢ con fee estimada de 1¢ por contrato:
el cobro total fue negativo. La política nueva evita esa salida voluntaria.
No se borraron ni corrigieron retrospectivamente esas pérdidas.

### Incertidumbre de volatilidad

La estimación EWMA asigna poco peso a datos antiguos, pero su error usaba todo
el historial como si tuviera pesos iguales. Ahora usa el tamaño efectivo
aproximado `(1 + lambda) / (1 - lambda)`, limitado por la historia disponible:
unos 32.3 datos efectivos para lambda 0.94. El escenario superior también
conserva la volatilidad observada con saltos, aunque la estimación central sea
robusta a ellos. No es un intervalo de confianza calibrado sobre estos mercados.

## Investigación cuantitativa reproducible

Se añadió un candidato de una sola variable que aprende qué fracción de la
discrepancia modelo/mercado conservar:

`logit(P candidato) = logit(P mercado) + peso × (logit(P modelo) − logit(P mercado))`

Los pesos candidatos son 0, 0.25, 0.5, 0.75 y 1. Se selecciona por log-loss en
mercados anteriores, con una penalización pequeña hacia el precio del mercado.
La idea de contrastar la señal respecto al precio de Kalshi y reservar el
periodo posterior se revisó en
[kalshi-btc15-ml-experiment](https://github.com/AllAboutAI-YT/kalshi-btc15-ml-experiment).
La implementación es local, no ejecuta un bot externo ni usa un LLM para fijar
probabilidades. La diferencia entre confianza y calibración se apoya en
[Guo y colaboradores](https://proceedings.mlr.press/v70/guo17a.html); su artículo
no constituye evidencia de rentabilidad en Kalshi.

Entrenamiento: `kalshi-research (1).json`. Evaluación posterior: reporte 7.
Se usa el primer dato disponible después de cada hora de decisión, con máximo
35 segundos de demora, un dato por ticker. No se elige retrospectivamente
el tick que más conviene. Las cifras difieren de auditorías que seleccionaban
el dato más cercano, que podía caer antes o después del horizonte.

| Tiempo objetivo antes del cierre | Mercados entrenamiento / prueba | Peso aprendido | Brier bruto / mercado / candidato |
|---|---:|---:|---:|
| 10 minutos | 29 / 19 | 0.75 | 0.210966 / 0.226883 / 0.214486 |
| 5 minutos | 29 / 20 | 1.00 | 0.126181 / 0.120557 / 0.126181 |
| 2 minutos | 25 / 17 | 0.00 | 0.157915 / 0.092604 / 0.092604 |

Menor Brier es mejor. A dos minutos, el entrenamiento anterior ya eligió
conservar el precio del mercado. A cinco minutos, eligió el modelo y perdió
contra el mercado en la evaluación posterior. No hay una victoria uniforme.

En la prueba sencilla de una unidad, entrada con 6¢ netos, fees y 1¢ supuesto
de slippage, el modelo bruto hizo 1 trade (+9¢) a diez minutos, 0 a cinco y
3 trades (−134¢) a dos. El candidato hizo 0 trades en los tres horizontes.
**No se presenta dejar de operar como una máquina rentable.** Tampoco es un
replay de los 67 trades del scalper: son otras reglas, frecuencia y tamaño.
El candidato queda en investigación, sin promoción automática a ejecución.

Los próximos exports incluyen `modelResearch`: una evaluación incremental que
solo ajusta cada predicción con mercados ya cerrados y cuyo resultado estaba
disponible entonces. Se registra cuándo se obtuvo el resultado oficial. En
los datos antiguos sin ese timestamp se declara la suposición de disponibilidad
60 segundos después del cierre. También se evita que un mercado observado a
otro horizonte cuente como si fuera un dato de cinco minutos.

## Trazabilidad y límites

Las observaciones nuevas conservan una entrada de replay con precios, tiempos,
cotizaciones, tamaños, microestructura y cinta permitida. Se excluyen claves,
órdenes reales y datos de pagos. Una prueba confirma que reproduce la
probabilidad y decisión del motor. Los datos ausentes del pasado no se fabrican.

Las operaciones nuevas se etiquetan `bounded-risk-v2`; las anteriores conservan
su versión. El comando de reset paper archiva el periodo previo y la exportación
incluye esos archivos. Eso protege resets dentro del mismo almacenamiento;
no puede rescatar un volumen eliminado o impedir la pérdida de un contenedor
sin persistencia. Las posiciones abiertas y el P/L cerrado se muestran por
separado para evitar confundir cash con ganancia liquidada.

Las fees siguen siendo estimaciones conservadoras del simulador. No se
redujeron retrospectivamente para mostrar más ganancias. Kalshi documenta
[fees y redondeo por fill/orden](https://docs.kalshi.com/getting_started/fee_rounding).
No se reconstruyeron las colas, latencia ni todos los fills parciales del pasado.
La cota de tamaño al entrar tampoco demuestra que una cotización siga disponible
cuando una orden real llegue al exchange.

Verificación: **1,321/1,321 pruebas**. Incluye 14 regresiones nuevas sobre caps,
tiempo, tamaño, presupuesto, fees, profundidad, CVD al salir, archivo/reinicio,
replay y separación temporal del entrenamiento. No se cambió `main`, no se
desplegó Railway, no se colocaron órdenes y los saldos históricos no se alteraron.

Reproducción, desde `discord-bot/`:

```sh
node scripts/audit-execution.mjs '/ruta/kalshi-research 7.json' '/ruta/kalshi-research (1).json'
node scripts/compare-models.mjs '/ruta/kalshi-research (1).json' '/ruta/kalshi-research 7.json'
```

Estas correcciones reducen exposición injustificada y hacen comprobable la
ejecución. Todavía no prueban que `bounded-risk-v2` aumente el win rate o el P/L.
