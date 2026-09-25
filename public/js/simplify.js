// Douglas–Peucker on flat [x0, y0, x1, y1, …] arrays, iterative so that lines
// with tens of thousands of points cannot overflow the stack.

/** Returns a Uint8Array flag per point: 1 = keep. Endpoints are always kept. */
export function simplifyMask(pts, eps) {
  const n = pts.length >> 1;
  const keep = new Uint8Array(n);
  if (n === 0) return keep;
  keep[0] = 1;
  keep[n - 1] = 1;
  if (n < 3) return keep;
  const eps2 = eps * eps;
  const stack = [0, n - 1];
  while (stack.length) {
    const j = stack.pop();
    const i = stack.pop();
    const ax = pts[2 * i], ay = pts[2 * i + 1];
    const dx = pts[2 * j] - ax, dy = pts[2 * j + 1] - ay;
    const len2 = dx * dx + dy * dy;
    let best = -1, bestD = eps2;
    for (let k = i + 1; k < j; k++) {
      const px = pts[2 * k] - ax, py = pts[2 * k + 1] - ay;
      let d;
      if (len2 === 0) {
        d = px * px + py * py;
      } else {
        // Distance to the segment, not the infinite line: closed loops have
        // coinciding endpoints, and U-turns would otherwise be flattened.
        const t = Math.max(0, Math.min(1, (px * dx + py * dy) / len2));
        const ex = px - t * dx, ey = py - t * dy;
        d = ex * ex + ey * ey;
      }
      if (d > bestD) { bestD = d; best = k; }
    }
    if (best >= 0) {
      keep[best] = 1;
      if (best - i > 1) stack.push(i, best);
      if (j - best > 1) stack.push(best, j);
    }
  }
  return keep;
}

export function simplify(pts, eps, Type = pts.constructor) {
  const keep = simplifyMask(pts, eps);
  let m = 0;
  for (let i = 0; i < keep.length; i++) m += keep[i];
  const out = new Type(2 * m);
  for (let i = 0, o = 0; i < keep.length; i++) {
    if (!keep[i]) continue;
    out[o++] = pts[2 * i];
    out[o++] = pts[2 * i + 1];
  }
  return out;
}
