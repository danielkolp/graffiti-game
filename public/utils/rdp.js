function perpendicularDistance(point, start, end) {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  if (dx === 0 && dy === 0) {
    const px = point.x - start.x;
    const py = point.y - start.y;
    return Math.sqrt((px * px) + (py * py));
  }

  const t = ((point.x - start.x) * dx + (point.y - start.y) * dy) / ((dx * dx) + (dy * dy));
  const clampedT = Math.max(0, Math.min(1, t));
  const projX = start.x + (clampedT * dx);
  const projY = start.y + (clampedT * dy);
  const distX = point.x - projX;
  const distY = point.y - projY;
  return Math.sqrt((distX * distX) + (distY * distY));
}

export function simplifyStrokeRDP(points, epsilon) {
  if (!points || points.length <= 2) {
    return points ? points.slice() : [];
  }

  let index = -1;
  let maxDistance = 0;

  for (let i = 1; i < points.length - 1; i += 1) {
    const distance = perpendicularDistance(points[i], points[0], points[points.length - 1]);
    if (distance > maxDistance) {
      index = i;
      maxDistance = distance;
    }
  }

  if (maxDistance > epsilon && index !== -1) {
    const firstHalf = simplifyStrokeRDP(points.slice(0, index + 1), epsilon);
    const secondHalf = simplifyStrokeRDP(points.slice(index), epsilon);
    return firstHalf.slice(0, firstHalf.length - 1).concat(secondHalf);
  }

  return [points[0], points[points.length - 1]];
}

export function resamplePoints(points, maxPoints) {
  if (!points || points.length <= maxPoints) {
    return points ? points.slice() : [];
  }

  const result = [];
  const step = (points.length - 1) / (maxPoints - 1);

  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.round(i * step);
    result.push(points[idx]);
  }

  return result;
}

export function minDistanceToPolyline(point, polyline) {
  if (!polyline || polyline.length === 0) {
    return Number.POSITIVE_INFINITY;
  }

  if (polyline.length === 1) {
    const dx = point.x - polyline[0].x;
    const dy = point.y - polyline[0].y;
    return Math.sqrt((dx * dx) + (dy * dy));
  }

  let minDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < polyline.length - 1; i += 1) {
    const distance = perpendicularDistance(point, polyline[i], polyline[i + 1]);
    if (distance < minDistance) {
      minDistance = distance;
    }
  }

  return minDistance;
}
