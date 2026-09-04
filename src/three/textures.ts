import * as THREE from 'three';

/**
 * Procedural textures.
 *
 * Generated on a canvas at runtime rather than shipped as image files. Three
 * reasons: no binary assets in the repository, nothing to fetch (our CSP blocks
 * third-party images anyway), and the tiling is defined in millimetres so a
 * brick reads at the right size whatever the wall.
 *
 * These are deliberately restrained — subtle grain and joint lines, not
 * photographic. At schematic stage a legible surface beats a convincing one,
 * and a quiet material palette keeps the model readable.
 */

const cache = new Map<string, THREE.Texture>();

function canvas(size = 512): { element: HTMLCanvasElement; ctx: CanvasRenderingContext2D } | null {
  if (typeof document === 'undefined') return null;
  const element = document.createElement('canvas');
  element.width = size;
  element.height = size;
  const ctx = element.getContext('2d');
  return ctx ? { element, ctx } : null;
}

function finish(element: HTMLCanvasElement): THREE.Texture {
  const texture = new THREE.CanvasTexture(element);
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  texture.needsUpdate = true;
  return texture;
}

function noise(ctx: CanvasRenderingContext2D, size: number, amount: number, alpha: number): void {
  const image = ctx.getImageData(0, 0, size, size);
  const { data } = image;
  for (let i = 0; i < data.length; i += 4) {
    const delta = (Math.random() - 0.5) * amount;
    data[i] = clamp((data[i] ?? 0) + delta);
    data[i + 1] = clamp((data[i + 1] ?? 0) + delta);
    data[i + 2] = clamp((data[i + 2] ?? 0) + delta);
    data[i + 3] = Math.round(255 * alpha);
  }
  ctx.putImageData(image, 0, 0);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(255, value));
}

function buildPlaster(): THREE.Texture | null {
  const target = canvas(256);
  if (!target) return null;
  const { ctx, element } = target;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 256, 256);
  noise(ctx, 256, 26, 1);
  return finish(element);
}

function buildConcrete(): THREE.Texture | null {
  const target = canvas(512);
  if (!target) return null;
  const { ctx, element } = target;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 512, 512);
  noise(ctx, 512, 34, 1);
  // Board marks: horizontal shutter lines every 150 px.
  ctx.strokeStyle = 'rgba(0,0,0,0.10)';
  ctx.lineWidth = 2;
  for (let y = 0; y < 512; y += 150) {
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(512, y);
    ctx.stroke();
  }
  return finish(element);
}

function buildBrick(): THREE.Texture | null {
  const target = canvas(512);
  if (!target) return null;
  const { ctx, element } = target;
  const courseHeight = 512 / 8;
  const brickWidth = 512 / 4;

  ctx.fillStyle = '#c9c4bd';
  ctx.fillRect(0, 0, 512, 512);

  for (let row = 0; row < 8; row += 1) {
    const offset = row % 2 === 0 ? 0 : brickWidth / 2;
    for (let column = -1; column < 5; column += 1) {
      const x = column * brickWidth + offset;
      const y = row * courseHeight;
      const shade = 236 + Math.floor(Math.random() * 20) - 10;
      ctx.fillStyle = `rgb(${shade}, ${shade - 4}, ${shade - 8})`;
      ctx.fillRect(x + 3, y + 3, brickWidth - 6, courseHeight - 6);
    }
  }
  noise(ctx, 512, 12, 1);
  return finish(element);
}

function buildTimber(): THREE.Texture | null {
  const target = canvas(512);
  if (!target) return null;
  const { ctx, element } = target;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 512, 512);

  // Grain: many thin vertical strokes of varying opacity.
  for (let i = 0; i < 260; i += 1) {
    const x = Math.random() * 512;
    ctx.strokeStyle = `rgba(0,0,0,${0.02 + Math.random() * 0.06})`;
    ctx.lineWidth = 0.5 + Math.random() * 2;
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.bezierCurveTo(x + 8, 170, x - 8, 340, x, 512);
    ctx.stroke();
  }
  // Board joints every 128 px.
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 2;
  for (let x = 0; x <= 512; x += 128) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 512);
    ctx.stroke();
  }
  return finish(element);
}

function buildSeam(): THREE.Texture | null {
  const target = canvas(256);
  if (!target) return null;
  const { ctx, element } = target;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 256, 256);
  ctx.strokeStyle = 'rgba(0,0,0,0.28)';
  ctx.lineWidth = 3;
  for (let x = 0; x <= 256; x += 64) {
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, 256);
    ctx.stroke();
  }
  noise(ctx, 256, 8, 1);
  return finish(element);
}

const BUILDERS: Record<string, () => THREE.Texture | null> = {
  plaster: buildPlaster,
  concrete: buildConcrete,
  brick: buildBrick,
  timber: buildTimber,
  seam: buildSeam,
};

/** Returns a cached procedural texture, or null if the name is unknown. */
export function getProceduralTexture(name: string | null): THREE.Texture | null {
  if (!name) return null;
  const cached = cache.get(name);
  if (cached) return cached;
  const builder = BUILDERS[name];
  if (!builder) return null;
  const texture = builder();
  if (texture) cache.set(name, texture);
  return texture;
}

export function disposeTextureCache(): void {
  for (const texture of cache.values()) texture.dispose();
  cache.clear();
}

export const PROCEDURAL_TEXTURE_NAMES = Object.keys(BUILDERS);
