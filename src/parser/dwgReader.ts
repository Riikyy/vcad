/**
 * Reads DWG files via libredwg compiled to WebAssembly.
 *
 * Only ever imported from the parse worker: the module is ESM-only and pulls in
 * a ~10 MB .wasm, neither of which belongs on the extension host's startup path.
 */

import { addBlock, Doc, DocEntity, DocLayer } from './doc';

// Loading the wasm module costs hundreds of milliseconds, so it is created once
// per worker and reused across every drawing that worker handles.
let libPromise: Promise<LibreDwgLike> | null = null;

interface LibreDwgLike {
  dwg_read_data(content: ArrayBuffer | string, fileType: number): number | undefined;
  convert(ptr: number): DwgDatabaseLike;
  dwg_free(ptr: number): void;
  dwg_get_version_type(ptr: number): { hdr?: string; description?: string } | undefined;
}

interface DwgDatabaseLike {
  entities: DocEntity[];
  header: Record<string, unknown>;
  tables: {
    LAYER: { entries: RawLayer[] };
    BLOCK_RECORD: { entries: RawBlock[] };
  };
}

interface RawLayer {
  name: string;
  colorIndex?: number;
  color?: number;
  off?: boolean;
  frozen?: boolean;
  lineweight?: number;
}

interface RawBlock {
  name: string;
  basePoint?: { x: number; y: number; z?: number };
  entities?: DocEntity[];
}

/**
 * The slice of libredwg-web's surface this reader uses.
 *
 * The package's own type entry re-exports through its emscripten glue, which
 * does not survive `moduleResolution: node16` cleanly, so the import is typed
 * structurally here instead of depending on that declaration chain.
 */
interface LibreDwgModule {
  LibreDwg: { create(wasmDir?: string): Promise<LibreDwgLike> };
}

async function getLib(wasmDir: string): Promise<LibreDwgLike> {
  if (!libPromise) {
    libPromise = (async () => {
      const mod = (await import('@mlightcad/libredwg-web')) as unknown as LibreDwgModule;
      // `create` takes a directory prefix it concatenates the wasm filename onto,
      // so the trailing separator is required.
      const dir = wasmDir.endsWith('/') || wasmDir.endsWith('\\') ? wasmDir : wasmDir + '/';
      return mod.LibreDwg.create(dir);
    })().catch((err) => {
      // Never cache a failed load; the next attempt should be able to retry.
      libPromise = null;
      throw err;
    });
  }
  return libPromise;
}

/** libredwg's file-type discriminator. DXF support is not compiled into this build. */
const FILE_TYPE_DWG = 0;

export async function readDwg(data: Uint8Array, wasmDir: string): Promise<Doc> {
  const lib = await getLib(wasmDir);

  // The wasm reader needs a standalone ArrayBuffer, not a view into a pooled one.
  const buffer = data.buffer.slice(
    data.byteOffset,
    data.byteOffset + data.byteLength
  ) as ArrayBuffer;

  const ptr = lib.dwg_read_data(buffer, FILE_TYPE_DWG);
  if (!ptr) {
    throw new Error(
      'libredwg could not decode this DWG file. It may be corrupt, encrypted, ' +
        'or saved in a format this build does not support.'
    );
  }

  try {
    const db = lib.convert(ptr);
    const version = lib.dwg_get_version_type(ptr);
    const format = version?.description
      ? `${version.description}${version.hdr ? ` (${version.hdr})` : ''}`
      : 'DWG';

    const doc: Doc = {
      format,
      layers: (db.tables?.LAYER?.entries ?? []).map(toLayer),
      blocks: new Map(),
      entities: db.entities ?? [],
      header: db.header ?? {},
    };

    for (const b of db.tables?.BLOCK_RECORD?.entries ?? []) {
      addBlock(doc, {
        name: b.name,
        basePoint: b.basePoint,
        entities: b.entities ?? [],
      });
    }

    return doc;
  } finally {
    // The converted database is a plain JS structure with no further dependency
    // on wasm memory, so the native side can always be released here.
    lib.dwg_free(ptr);
  }
}

function toLayer(l: RawLayer): DocLayer {
  return {
    name: l.name,
    colorIndex: l.colorIndex,
    color: l.color,
    off: l.off,
    frozen: l.frozen,
    lineweight: l.lineweight,
  };
}
