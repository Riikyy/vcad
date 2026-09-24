/**
 * Parse worker.
 *
 * Decoding a DWG means initialising a ~10 MB wasm module and walking every
 * entity in the drawing. Doing that on the extension host would freeze the whole
 * VS Code window — the host is shared by every extension — so it happens here on
 * its own thread. Built as ESM because libredwg-web ships ESM only.
 */

import { parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';

import { sceneTransferables } from '../common/scene';
import { readDwg } from './dwgReader';
import { readDxf } from './dxfReader';
import { buildScene, BuildOptions } from './sceneBuilder';

export interface ParseRequest {
  id: number;
  filePath: string;
  /** Lower-cased extension without the dot, e.g. "dwg". */
  kind: string;
  wasmDir: string;
  options: BuildOptions;
}

if (!parentPort) {
  throw new Error('parseWorker must be run as a worker thread');
}

const port = parentPort;

port.on('message', (req: ParseRequest) => {
  void handle(req);
});

async function handle(req: ParseRequest): Promise<void> {
  const started = Date.now();
  try {
    const data = await readFile(req.filePath);
    const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);

    const doc =
      req.kind === 'dxf' ? readDxf(bytes) : await readDwg(bytes, req.wasmDir);

    const scene = buildScene(doc, req.options);
    scene.stats.parseMs = Date.now() - started;

    // Typed arrays are transferred rather than copied; after this the worker's
    // views are detached, which is fine because the scene is not reused here.
    port.postMessage({ id: req.id, ok: true, scene }, sceneTransferables(scene));
  } catch (err) {
    port.postMessage({
      id: req.id,
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
  }
}
