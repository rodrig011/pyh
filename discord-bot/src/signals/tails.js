/**
 * Fat tails, because bitcoin does not move in a bell curve.
 *
 * The engine prices a digital with a log-normal model: the chance of finishing
 * above the strike comes from a normal distribution of log returns. That model
 * is wrong in a specific and dangerous direction.
 *
 * Real 15-minute bitcoin returns are leptokurtic — far more of the movement
 * arrives in a few violent bursts than a normal distribution allows. The
 * practical consequence is precise: when price has already moved away from the
 * strike, a normal model says "it will not come back" with far more confidence
 * than it has earned. And that is exactly the situation the engine calls a
 * trade, because a price sitting on the strike is a coin flip nobody can beat.
 *
 * So the Gaussian is overconfident precisely where the money is placed. Every
 * cent of that overconfidence looks like edge, gets sized like edge, and is
 * not edge.
 *
 * A Student-t with a few degrees of freedom fixes the shape. Nothing here
 * makes the engine more certain — it makes it correctly less certain, which is
 * the only kind of accuracy that survives contact with a real market.
 */

const EPSILON = 3e-12;
const TINY = 1e-300;

/** Log gamma, Lanczos. Needed for the beta function underneath the t CDF. */
export function logGamma(x) {
  const coefficients = [
    76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155,
    0.1208650973866179e-2, -0.5395239384953e-5,
  ];

  let y = x;
  let temporary = x + 5.5;
  temporary -= (x + 0.5) * Math.log(temporary);

  let series = 1.000000000190015;
  for (const coefficient of coefficients) {
    y += 1;
    series += coefficient / y;
  }

  return -temporary + Math.log((2.5066282746310005 * series) / x);
}

/** Continued fraction for the incomplete beta, Lentz's method. */
function betaContinuedFraction(a, b, x) {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;

  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < TINY) d = TINY;
  d = 1 / d;
  let h = d;

  for (let m = 1; m <= 300; m += 1) {
    const m2 = 2 * m;

    let numerator = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;
    h *= d * c;

    numerator = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + numerator * d;
    if (Math.abs(d) < TINY) d = TINY;
    c = 1 + numerator / c;
    if (Math.abs(c) < TINY) c = TINY;
    d = 1 / d;

    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < EPSILON) break;
  }

  return h;
}

/** Regularized incomplete beta I_x(a, b). */
export function incompleteBeta(a, b, x) {
  if (!(a > 0) || !(b > 0) || !Number.isFinite(x)) return null;
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  const front = Math.exp(
    logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x),
  );

  return x < (a + 1) / (a + b + 2)
    ? (front * betaContinuedFraction(a, b, x)) / a
    : 1 - (front * betaContinuedFraction(b, a, 1 - x)) / b;
}

/**
 * Student-t CDF with `nu` degrees of freedom.
 *
 * As nu grows this becomes the normal CDF, which is the check the tests make:
 * a fat-tailed model has to contain the thin-tailed one as a special case, or
 * it is not a generalisation, it is a different guess.
 */
export function studentTCdf(x, nu) {
  if (!Number.isFinite(x) || !(nu > 0)) return null;

  const tail = incompleteBeta(nu / 2, 0.5, nu / (nu + x * x));
  if (tail === null) return null;

  return x >= 0 ? 1 - 0.5 * tail : 0.5 * tail;
}

/**
 * The chance of finishing above the strike, with tails that match the asset.
 *
 * `sigma` still means what it always meant — the standard deviation of the log
 * return over the remaining horizon. The t distribution has variance
 * nu/(nu−2), so it is rescaled to keep sigma honest; without that, raising the
 * tail weight would quietly also raise the volatility and two different
 * changes would be tangled into one knob.
 *
 * `degreesOfFreedom` at Infinity gives exactly the old log-normal answer, so
 * the change can be switched off and measured rather than believed.
 */
export function probabilityAboveFatTailed(spot, strike, sigma, degreesOfFreedom = 4) {
  if (!(spot > 0) || !(strike > 0)) return null;
  if (!(sigma > 0)) return spot > strike ? 1 : spot < strike ? 0 : 0.5;

  const nu = degreesOfFreedom;
  if (!(nu > 2)) return null;

  // Rescale so the distribution's standard deviation is still sigma.
  const scale = sigma * Math.sqrt((nu - 2) / nu);
  const drift = -(sigma * sigma) / 2;
  const d = (Math.log(spot / strike) + drift) / scale;

  return studentTCdf(d, nu);
}

/**
 * How much a fat-tailed read disagrees with the normal one, in cents.
 *
 * Worth publishing rather than hiding: it is largest exactly where the engine
 * wants to trade, and a member who can see "the bell curve says 71 and the
 * honest read says 66" learns more from that one line than from any indicator.
 */
export function tailCorrectionCents(normalProbability, fatProbability) {
  if (!Number.isFinite(normalProbability) || !Number.isFinite(fatProbability)) return null;
  return (fatProbability - normalProbability) * 100;
}
