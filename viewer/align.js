import * as THREE from "./vendor/three.module.js";

// Similarity (scale / rotation / translation) alignment of one mesh onto another without
// correspondences: PCA-based initial guesses (all 24 axis permutations/flips plus the
// identity) refined by trimmed ICP with Horn's closed-form similarity solve.

const SAMPLE_COUNT = 4000;
const COARSE_SAMPLE_COUNT = 800;
const COARSE_ITERATIONS = 12;
const REFINE_ITERATIONS = 40;
const REFINE_CANDIDATES = 4;
const TRIM_FRACTION = 0.85;

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Area-weighted surface samples of every mesh under root, in world space.
export function sampleSurfacePoints(root, count = SAMPLE_COUNT, seed = 1) {
  root.updateMatrixWorld(true);
  const meshes = [];
  let totalArea = 0;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  root.traverse((object) => {
    const position = object.isMesh ? object.geometry?.attributes?.position : null;
    if (!position) {
      return;
    }
    const world = new Float32Array(position.count * 3);
    for (let i = 0; i < position.count; i += 1) {
      a.fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld);
      world[i * 3] = a.x;
      world[i * 3 + 1] = a.y;
      world[i * 3 + 2] = a.z;
    }
    const index = object.geometry.index;
    const triangleCount = index ? index.count / 3 : position.count / 3;
    const triangles = new Uint32Array(triangleCount * 3);
    const cumulative = new Float64Array(triangleCount);
    let area = 0;
    for (let f = 0; f < triangleCount; f += 1) {
      for (let k = 0; k < 3; k += 1) {
        triangles[f * 3 + k] = index ? index.getX(f * 3 + k) : f * 3 + k;
      }
      a.fromArray(world, triangles[f * 3] * 3);
      b.fromArray(world, triangles[f * 3 + 1] * 3).sub(a);
      c.fromArray(world, triangles[f * 3 + 2] * 3).sub(a);
      area += 0.5 * b.cross(c).length();
      cumulative[f] = area;
    }
    if (area > 0) {
      meshes.push({ world, triangles, cumulative, area });
      totalArea += area;
    }
  });

  if (totalArea <= 0) {
    throw new Error("Model has no surface to sample for alignment.");
  }

  const random = mulberry32(seed);
  const points = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    let pick = random() * totalArea;
    let mesh = meshes[meshes.length - 1];
    for (const candidate of meshes) {
      if (pick < candidate.area) {
        mesh = candidate;
        break;
      }
      pick -= candidate.area;
    }
    let lo = 0;
    let hi = mesh.cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (mesh.cumulative[mid] < pick) lo = mid + 1;
      else hi = mid;
    }
    let u = random();
    let v = random();
    if (u + v > 1) {
      u = 1 - u;
      v = 1 - v;
    }
    const i0 = mesh.triangles[lo * 3] * 3;
    const i1 = mesh.triangles[lo * 3 + 1] * 3;
    const i2 = mesh.triangles[lo * 3 + 2] * 3;
    for (let k = 0; k < 3; k += 1) {
      const p0 = mesh.world[i0 + k];
      points[i * 3 + k] = p0 + u * (mesh.world[i1 + k] - p0) + v * (mesh.world[i2 + k] - p0);
    }
  }
  return points;
}

// Implicit kd-tree: idx is reordered so each range's median splits on axis depth % 3.
function buildKdTree(points) {
  const n = points.length / 3;
  const idx = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) idx[i] = i;
  const build = (lo, hi, depth) => {
    if (hi - lo <= 1) return;
    const axis = depth % 3;
    idx.subarray(lo, hi).sort((p, q) => points[p * 3 + axis] - points[q * 3 + axis]);
    const mid = (lo + hi) >> 1;
    build(lo, mid, depth + 1);
    build(mid + 1, hi, depth + 1);
  };
  build(0, n, 0);
  return { points, idx, n };
}

function nearestSquaredDistance(tree, x, y, z) {
  const { points, idx } = tree;
  let best = Infinity;
  let bestIndex = -1;
  const query = [x, y, z];
  const search = (lo, hi, depth) => {
    if (lo >= hi) return;
    const mid = (lo + hi) >> 1;
    const p = idx[mid] * 3;
    const dx = points[p] - x;
    const dy = points[p + 1] - y;
    const dz = points[p + 2] - z;
    const d2 = dx * dx + dy * dy + dz * dz;
    if (d2 < best) {
      best = d2;
      bestIndex = idx[mid];
    }
    const axis = depth % 3;
    const diff = query[axis] - points[p + axis];
    if (diff < 0) {
      search(lo, mid, depth + 1);
      if (diff * diff < best) search(mid + 1, hi, depth + 1);
    } else {
      search(mid + 1, hi, depth + 1);
      if (diff * diff < best) search(lo, mid, depth + 1);
    }
  };
  search(0, tree.n, 0);
  return { d2: best, index: bestIndex };
}

// Cyclic Jacobi eigen-decomposition of a symmetric n x n matrix (row-major array).
// Returns eigenvalues and eigenvectors (columns of vectors, row-major), unsorted.
function symmetricEigen(matrix, n) {
  const m = matrix.slice();
  const vectors = new Array(n * n).fill(0);
  for (let i = 0; i < n; i += 1) vectors[i * n + i] = 1;
  for (let sweep = 0; sweep < 50; sweep += 1) {
    let off = 0;
    for (let p = 0; p < n; p += 1) for (let q = p + 1; q < n; q += 1) off += m[p * n + q] ** 2;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p += 1) {
      for (let q = p + 1; q < n; q += 1) {
        const apq = m[p * n + q];
        if (Math.abs(apq) < 1e-30) continue;
        const theta = (m[q * n + q] - m[p * n + p]) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const cos = 1 / Math.sqrt(t * t + 1);
        const sin = t * cos;
        for (let k = 0; k < n; k += 1) {
          const mkp = m[k * n + p];
          const mkq = m[k * n + q];
          m[k * n + p] = cos * mkp - sin * mkq;
          m[k * n + q] = sin * mkp + cos * mkq;
        }
        for (let k = 0; k < n; k += 1) {
          const mpk = m[p * n + k];
          const mqk = m[q * n + k];
          m[p * n + k] = cos * mpk - sin * mqk;
          m[q * n + k] = sin * mpk + cos * mqk;
        }
        for (let k = 0; k < n; k += 1) {
          const vkp = vectors[k * n + p];
          const vkq = vectors[k * n + q];
          vectors[k * n + p] = cos * vkp - sin * vkq;
          vectors[k * n + q] = sin * vkp + cos * vkq;
        }
      }
    }
  }
  const values = [];
  for (let i = 0; i < n; i += 1) values.push(m[i * n + i]);
  return { values, vectors };
}

// Similarity transform as { s, R: Matrix3, t: Vector3 } with y = s * R * x + t.
function makeSimilarity(s, R, t) {
  return { s, R: R.clone(), t: t.clone() };
}

function similarityToMatrix4({ s, R, t }) {
  const e = R.elements;
  return new THREE.Matrix4().set(
    s * e[0], s * e[3], s * e[6], t.x,
    s * e[1], s * e[4], s * e[7], t.y,
    s * e[2], s * e[5], s * e[8], t.z,
    0, 0, 0, 1
  );
}

function transformPoints(points, transform, out) {
  const e = transform.R.elements;
  const { s, t } = transform;
  for (let i = 0; i < points.length; i += 3) {
    const x = points[i];
    const y = points[i + 1];
    const z = points[i + 2];
    out[i] = s * (e[0] * x + e[3] * y + e[6] * z) + t.x;
    out[i + 1] = s * (e[1] * x + e[4] * y + e[7] * z) + t.y;
    out[i + 2] = s * (e[2] * x + e[5] * y + e[8] * z) + t.z;
  }
  return out;
}

// Horn's closed-form similarity from paired points (src[i] -> dst[i]) over selected indices.
function solveSimilarity(src, dst, pairs) {
  const count = pairs.length;
  const ms = new THREE.Vector3();
  const md = new THREE.Vector3();
  for (const [i, j] of pairs) {
    ms.x += src[i * 3]; ms.y += src[i * 3 + 1]; ms.z += src[i * 3 + 2];
    md.x += dst[j * 3]; md.y += dst[j * 3 + 1]; md.z += dst[j * 3 + 2];
  }
  ms.divideScalar(count);
  md.divideScalar(count);

  const S = new Array(9).fill(0);
  let srcVariance = 0;
  for (const [i, j] of pairs) {
    const x = [src[i * 3] - ms.x, src[i * 3 + 1] - ms.y, src[i * 3 + 2] - ms.z];
    const y = [dst[j * 3] - md.x, dst[j * 3 + 1] - md.y, dst[j * 3 + 2] - md.z];
    for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) S[r * 3 + c] += x[r] * y[c];
    srcVariance += x[0] * x[0] + x[1] * x[1] + x[2] * x[2];
  }
  const [sxx, sxy, sxz, syx, syy, syz, szx, szy, szz] = S;
  const N = [
    sxx + syy + szz, syz - szy, szx - sxz, sxy - syx,
    syz - szy, sxx - syy - szz, sxy + syx, szx + sxz,
    szx - sxz, sxy + syx, -sxx + syy - szz, syz + szy,
    sxy - syx, szx + sxz, syz + szy, -sxx - syy + szz,
  ];
  const { values, vectors } = symmetricEigen(N, 4);
  let best = 0;
  for (let k = 1; k < 4; k += 1) if (values[k] > values[best]) best = k;
  const quaternion = new THREE.Quaternion(vectors[4 + best], vectors[8 + best], vectors[12 + best], vectors[best]).normalize();
  const R = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(quaternion));

  const rotated = ms.clone();
  let cross = 0;
  const e = R.elements;
  for (const [i, j] of pairs) {
    const x = src[i * 3] - ms.x;
    const y = src[i * 3 + 1] - ms.y;
    const z = src[i * 3 + 2] - ms.z;
    cross += (dst[j * 3] - md.x) * (e[0] * x + e[3] * y + e[6] * z);
    cross += (dst[j * 3 + 1] - md.y) * (e[1] * x + e[4] * y + e[7] * z);
    cross += (dst[j * 3 + 2] - md.z) * (e[2] * x + e[5] * y + e[8] * z);
  }
  const s = srcVariance > 0 ? Math.max(cross / srcVariance, 1e-6) : 1;
  rotated.applyMatrix3(R).multiplyScalar(s);
  return makeSimilarity(s, R, md.clone().sub(rotated));
}

// Trimmed ICP: each iteration matches every source point to its nearest target point,
// keeps the closest TRIM_FRACTION of pairs and re-solves the similarity.
function trimmedIcp(src, targetTree, initial, iterations) {
  let transform = initial;
  const moved = new Float32Array(src.length);
  const count = src.length / 3;
  const keep = Math.max(3, Math.floor(count * TRIM_FRACTION));
  let error = Infinity;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    transformPoints(src, transform, moved);
    const matches = new Array(count);
    for (let i = 0; i < count; i += 1) {
      const { d2, index } = nearestSquaredDistance(targetTree, moved[i * 3], moved[i * 3 + 1], moved[i * 3 + 2]);
      matches[i] = [i, index, d2];
    }
    matches.sort((p, q) => p[2] - q[2]);
    const kept = matches.slice(0, keep);
    const nextError = Math.sqrt(kept.reduce((sum, m) => sum + m[2], 0) / keep);
    transform = solveSimilarity(src, targetTree.points, kept);
    if (Math.abs(error - nextError) < 1e-7 * (1 + nextError)) {
      error = nextError;
      break;
    }
    error = nextError;
  }
  return { transform, error };
}

function trimmedOneWay(points, tree) {
  const count = points.length / 3;
  const distances = new Float64Array(count);
  for (let i = 0; i < count; i += 1) {
    distances[i] = nearestSquaredDistance(tree, points[i * 3], points[i * 3 + 1], points[i * 3 + 2]).d2;
  }
  distances.sort();
  const keep = Math.max(1, Math.floor(count * TRIM_FRACTION));
  let sum = 0;
  for (let i = 0; i < keep; i += 1) sum += distances[i];
  return Math.sqrt(sum / keep);
}

// Symmetric trimmed chamfer: catches fits that only cover part of the target.
function symmetricError(src, targetTree, transform) {
  const moved = transformPoints(src, transform, new Float32Array(src.length));
  return 0.5 * (trimmedOneWay(moved, targetTree) + trimmedOneWay(targetTree.points, buildKdTree(moved)));
}

function principalFrame(points) {
  const count = points.length / 3;
  const center = new THREE.Vector3();
  for (let i = 0; i < points.length; i += 3) {
    center.x += points[i]; center.y += points[i + 1]; center.z += points[i + 2];
  }
  center.divideScalar(count);
  const cov = new Array(9).fill(0);
  for (let i = 0; i < points.length; i += 3) {
    const d = [points[i] - center.x, points[i + 1] - center.y, points[i + 2] - center.z];
    for (let r = 0; r < 3; r += 1) for (let c = 0; c < 3; c += 1) cov[r * 3 + c] += d[r] * d[c];
  }
  for (let k = 0; k < 9; k += 1) cov[k] /= count;
  const { values, vectors } = symmetricEigen(cov, 3);
  const order = [0, 1, 2].sort((p, q) => values[q] - values[p]);
  const axes = new THREE.Matrix3();
  const ae = axes.elements;
  order.forEach((source, column) => {
    for (let row = 0; row < 3; row += 1) ae[column * 3 + row] = vectors[row * 3 + source];
  });
  if (axes.determinant() < 0) {
    for (let row = 0; row < 3; row += 1) ae[6 + row] *= -1;
  }
  const radius = Math.sqrt(Math.max(values[0] + values[1] + values[2], 1e-20));
  return { center, axes, radius };
}

// The 24 proper rotations that map coordinate axes onto signed coordinate axes.
function axisRotations() {
  const permutations = [[0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0]];
  const rotations = [];
  for (const permutation of permutations) {
    for (let signs = 0; signs < 8; signs += 1) {
      const m = new THREE.Matrix3();
      const e = m.elements.fill(0);
      permutation.forEach((row, column) => {
        e[column * 3 + row] = signs & (1 << column) ? -1 : 1;
      });
      if (m.determinant() > 0) rotations.push(m);
    }
  }
  return rotations;
}

function subsample(points, count) {
  const total = points.length / 3;
  if (total <= count) return points;
  const out = new Float32Array(count * 3);
  for (let i = 0; i < count; i += 1) {
    const j = Math.floor((i * total) / count);
    out.set(points.subarray(j * 3, j * 3 + 3), i * 3);
  }
  return out;
}

// Returns { matrix: Matrix4 mapping source world -> target world, error, relativeError }.
export function alignPointSets(sourcePoints, targetPoints) {
  const targetTree = buildKdTree(targetPoints);
  const sourceFrame = principalFrame(sourcePoints);
  const targetFrame = principalFrame(targetPoints);
  const scale = targetFrame.radius / sourceFrame.radius;

  const fromFrame = (R) => makeSimilarity(scale, R, targetFrame.center.clone().sub(sourceFrame.center.clone().applyMatrix3(R).multiplyScalar(scale)));
  const sourceAxesT = sourceFrame.axes.clone().transpose();
  const candidates = [
    makeSimilarity(1, new THREE.Matrix3(), new THREE.Vector3()),
    fromFrame(new THREE.Matrix3()),
    ...axisRotations().map((G) => fromFrame(targetFrame.axes.clone().multiply(G).multiply(sourceAxesT))),
  ];

  const coarseSource = subsample(sourcePoints, COARSE_SAMPLE_COUNT);
  const coarse = candidates
    .map((candidate) => trimmedIcp(coarseSource, targetTree, candidate, COARSE_ITERATIONS))
    .sort((p, q) => p.error - q.error)
    .slice(0, REFINE_CANDIDATES);

  let best = null;
  for (const { transform } of coarse) {
    const refined = trimmedIcp(sourcePoints, targetTree, transform, REFINE_ITERATIONS);
    const error = symmetricError(sourcePoints, targetTree, refined.transform);
    if (!best || error < best.error) {
      best = { transform: refined.transform, error };
    }
  }
  return {
    matrix: similarityToMatrix4(best.transform),
    scale: best.transform.s,
    error: best.error,
    relativeError: best.error / targetFrame.radius,
  };
}
