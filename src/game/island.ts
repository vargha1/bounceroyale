/**
 * Procedural island generator.
 *
 * Produces a list of hex-tile positions that form an irregular island shape.
 * The island is deterministic given a seed — the host generates it and sends
 * the seed + size to guests, who regenerate the exact same island.
 *
 * Algorithm:
 *   - Lay out a hex grid (flat-top orientation) within a bounding circle.
 *   - For each grid cell, compute "island-ness" = noise(x,z) × radial_falloff.
 *   - If island-ness > threshold, the tile exists.
 *   - Height is derived from a second noise channel + radial lift so the
 *     centre is slightly higher than the edges (gentle hill).
 *
 * Colouring is done in the engine (based on height) so this module only
 * deals with geometry.
 */

export type IslandSize = 'small' | 'medium' | 'large';

export interface IslandTile {
  x: number;
  y: number;
  z: number;
  id: string;
}

export interface IslandConfig {
  size: IslandSize;
  seed: number;
}

const SIZE_PARAMS: Record<IslandSize, { gridRadius: number; tileRadius: number; noiseScale: number; threshold: number }> = {
  small: { gridRadius: 7, tileRadius: 0.6, noiseScale: 0.35, threshold: 0.30 },
  medium: { gridRadius: 10, tileRadius: 0.6, noiseScale: 0.30, threshold: 0.32 },
  large: { gridRadius: 13, tileRadius: 0.6, noiseScale: 0.25, threshold: 0.33 },
};

// ---- Deterministic hash-based value noise ----

function hash2(ix: number, iz: number, seed: number): number {
  let h = (ix * 374761393 + iz * 668265263 + seed * 1013904223) | 0;
  h = (h ^ (h >> 13)) * 1274126177 | 0;
  return ((h ^ (h >> 16)) >>> 0) / 4294967295;
}

function smoothNoise(x: number, z: number, seed: number): number {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const a = hash2(ix, iz, seed);
  const b = hash2(ix + 1, iz, seed);
  const c = hash2(ix, iz + 1, seed);
  const d = hash2(ix + 1, iz + 1, seed);
  const ux = fx * fx * (3 - 2 * fx);
  const uz = fz * fz * (3 - 2 * fz);
  return a * (1 - ux) * (1 - uz) + b * ux * (1 - uz) + c * (1 - ux) * uz + d * ux * uz;
}

function fbm(x: number, z: number, seed: number, octaves = 4): number {
  let total = 0;
  let amplitude = 1;
  let frequency = 1;
  let max = 0;
  for (let i = 0; i < octaves; i++) {
    total += smoothNoise(x * frequency, z * frequency, seed + i * 17) * amplitude;
    max += amplitude;
    amplitude *= 0.5;
    frequency *= 2;
  }
  return total / max;
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Generate a list of tiles forming an island.
 *
 * @param size  Island size preset.
 * @param seed  Deterministic seed (any number).
 * @returns     Array of tiles with world positions and stable IDs.
 */
export function generateIsland(size: IslandSize = 'medium', seed: number = Date.now()): IslandTile[] {
  const params = SIZE_PARAMS[size];
  const { gridRadius, tileRadius, noiseScale, threshold } = params;
  const tiles: IslandTile[] = [];

  // Flat-top hex grid spacing
  const colSpacing = 1.5 * tileRadius;
  const rowSpacing = Math.sqrt(3) * tileRadius;
  const worldRadius = gridRadius * colSpacing;

  // Use the seed to offset the noise sampling so different seeds give
  // different coastline shapes.
  const noiseOffsetX = (seed % 1000) * 0.7;
  const noiseOffsetZ = ((seed * 1.7) % 1000) * 0.7;

  for (let col = -gridRadius; col <= gridRadius; col++) {
    for (let row = -gridRadius; row <= gridRadius; row++) {
      const x = col * colSpacing;
      // Offset every other column by half a row to form a proper hex grid.
      const zOffset = (Math.abs(col) % 2) * (rowSpacing / 2);
      const z = row * rowSpacing + zOffset;

      const dist = Math.sqrt(x * x + z * z);
      if (dist > worldRadius * 1.05) continue;

      // ---- Coastline shape ----
      // Combine low-frequency noise with a radial falloff so the island is
      // roughly circular but has an irregular edge.
      const coastline = fbm((x + noiseOffsetX) * noiseScale, (z + noiseOffsetZ) * noiseScale, seed, 4);
      const falloff = 1 - smoothstep(worldRadius * 0.25, worldRadius * 0.95, dist);
      const islandness = coastline * 0.55 + falloff * 0.45;

      if (islandness < threshold) continue;

      // ---- Height map ----
      // Centre tiles are higher (gentle hill), edges are lower (beach level).
      const heightNoise = fbm((x + noiseOffsetX) * 0.4, (z + noiseOffsetZ) * 0.4, seed + 999, 3);
      const radialLift = (1 - smoothstep(0, worldRadius * 0.8, dist)) * 1.8;
      const y = 0.2 + heightNoise * 0.8 + radialLift;

      // Stable ID based on grid coordinates — same across all peers.
      const id = `t-${col}-${row}`;

      tiles.push({ x, y, z, id });
    }
  }

  return tiles;
}

/** Pick a reasonable spawn point near the centre of the island. */
export function getIslandSpawn(tiles: IslandTile[]): { x: number; y: number; z: number } {
  if (tiles.length === 0) return { x: 0, y: 5, z: 0 };
  // Find the tile closest to (0, 0) and spawn above it.
  let best = tiles[0];
  let bestDist = Infinity;
  for (const t of tiles) {
    const d = t.x * t.x + t.z * t.z;
    if (d < bestDist) {
      bestDist = d;
      best = t;
    }
  }
  return { x: best.x, y: best.y + 4, z: best.z };
}
