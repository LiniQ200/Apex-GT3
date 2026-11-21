import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import type { GetManualChunk } from 'rollup';
import { defineConfig } from 'vite';
const host = {
  host: '0.0.0.0',
  port: Number(process.env.PORT) || 5173,
  strictPort: Boolean(process.env.PORT),
  allowedHosts: true as const,
};

// Only group registrations reached by the live garage/Drive shader imports.
// Babylon also imports a few shaders statically from the engine: moving those
// into a language pack would eagerly load BOTH packs and can cycle ShaderStore.
const shader = /\/@babylonjs\/core\/Shaders(WGSL)?\/(?:ShadersInclude\/)?([^/]+)\.js$/;
const garageShaders = new Set('background default pbr rgbdDecode shadowMap shadowMapFragmentSoftTransparentShadow'.split(' '));
const shaderChunk: GetManualChunk = (id, { getModuleInfo }) => {
  const match = shader.exec(id);
  if (!match) return;
  let garage = false, drive = false;
  const pending = [id], seen = new Set<string>();
  while (pending.length) {
    const next = pending.pop()!;
    if (seen.has(next)) continue;
    seen.add(next);
    const parent = shader.exec(next);
    if (!parent) return; // The static import chain reaches a non-shader module.
    const info = getModuleInfo(next)!;
    if (info.dynamicImporters.length) {
      const family = parent[2].split('.')[0];
      garage ||= garageShaders.has(family);
      drive ||= family === 'lightProxy';
    }
    pending.push(...info.importers);
  }
  if (garage || drive) return `${garage ? 'garage' : 'drive'}-shaders-${match[1] ? 'wgsl' : 'glsl'}`;
};

// Fetch bytes in parallel, without changing module execution order. The track
// and physics imports are only hinted when Drive actually asks for the road.
const preload = new Map<string, string[]>();
export default defineConfig({
  base: process.env.VITE_BASE || './',
  server: host,
  preview: host,
  build: {
    target: 'es2022', chunkSizeWarningLimit: 5000, copyPublicDir: false,
    rollupOptions: { output: { onlyExplicitManualChunks: true, manualChunks: shaderChunk } },
    modulePreload: {
      resolveDependencies(file, deps, { hostType }) {
        return [...new Set([...deps, ...(preload.get(hostType === 'html' ? 'garage' : file) ?? [])])];
      },
    },
  },
  plugins: [{
    name: 'package-3d-release',
    generateBundle: {
      order: 'pre',
      handler(_, bundle) {
        const chunks = Object.values(bundle).filter(c => c.type === 'chunk');
        const files = (...suffixes: string[]) => chunks.filter(c => c.moduleIds.some(id => suffixes.some(s => id.endsWith(s)))).map(c => c.fileName);
        preload.clear();
        preload.set('garage', files('/src/engine/studioView.ts'));
        for (const road of files('/src/track/road.ts')) preload.set(road, files('/src/track/index.ts', '/jolt-physics.wasm-compat.js'));
      },
    },
    configurePreviewServer({ config, middlewares }) {
      const dir = resolve(config.root, config.build.outDir, 'downloads/encoded');
      middlewares.use((req, res, next) => {
        const path = req.url?.split('?')[0];
        if (path && /^\/assets\/(?:[\w-]+\/)*[\w.-]+\.(?:js|glb|wasm|ttf)$/.test(path) && existsSync(dir + path + '.br')) {
          res.appendHeader('Vary', 'Accept-Encoding');
          const br = req.headers['accept-encoding']?.split(',').map(s => s.trim()).find(s => /^br(?:\s*;|$)/i.test(s));
          if ((req.method === 'GET' || req.method === 'HEAD') && !req.headers.range && br && !/;\s*q\s*=\s*0(?:\.0*)?\s*$/i.test(br)) {
            // Vite's static server handles .br MIME, encoding, ETag and HEAD.
            req.url = '/downloads/encoded' + path + '.br';
          }
        }
        next();
      });
    },
    writeBundle({ dir }, bundle) {
      execFileSync(process.execPath, ['scripts/pack-game.mjs', dir!, ...Object.keys(bundle)], { stdio: 'inherit' });
    },
  }],
});
