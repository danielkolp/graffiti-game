export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

export function damp(current, target, lambda, dt) {
  return lerp(current, target, 1 - Math.exp(-lambda * dt));
}

export function dampVector3(out, target, lambda, dt) {
  const t = 1 - Math.exp(-lambda * dt);
  out.lerp(target, t);
  return out;
}

export function roundToStep(value, step) {
  return Math.round(value / step) * step;
}
