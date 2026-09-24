/**
 * Extension-host side of the parse worker.
 *
 * One worker is kept alive for the whole session so the wasm module is
 * initialised once rather than per drawing. Requests are queued and answered by
 * id, a worker that dies fails its in-flight requests with a real error, and a
 * request that never answers times out instead of leaving the editor spinning.
 */

import { Worker } from 'node:worker_threads';
import * as path from 'node:path';

import type { Scene } from '../common/scene';
import type { BuildOptions } from './sceneBuilder';

/** Minimal logger shape, satisfied by vscode.LogOutputChannel. */
export interface Logger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** Generous: first use includes wasm start-up, and large drawings are slow. */
const PARSE_TIMEOUT_MS = 180_000;

interface Pending {
  resolve: (scene: Scene) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface WorkerReply {
  id: number;
  ok: boolean;
  scene?: Scene;
  message?: string;
  stack?: string;
}

export class ParseClient {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private disposed = false;

  /**
   * @param distDir directory holding the built worker bundle
   * @param wasmDir directory holding libredwg-web's .wasm and glue code
   */
  constructor(
    private distDir: string,
    private wasmDir: string,
    private log: Logger
  ) {}

  async parse(filePath: string, options: BuildOptions): Promise<Scene> {
    if (this.disposed) throw new Error('VCAD parser has been disposed');
    const worker = this.ensureWorker();
    const id = this.nextId++;
    const kind = path.extname(filePath).slice(1).toLowerCase();

    return new Promise<Scene>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(
          new Error(
            `Parsing did not finish within ${PARSE_TIMEOUT_MS / 1000} s. ` +
              'The drawing may be too large; try lowering vcad.render.maxEntities.'
          )
        );
        // A worker stuck mid-parse cannot be interrupted, only replaced.
        this.restartWorker('timed out');
      }, PARSE_TIMEOUT_MS);

      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ id, filePath, kind, wasmDir: this.wasmDir, options });
    });
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;

    const workerPath = path.join(this.distDir, 'parseWorker.mjs');
    this.log.info(`starting parse worker ${workerPath}`);
    // stderr is piped so libredwg's native diagnostics reach the output channel
    // instead of vanishing.
    const worker = new Worker(workerPath, { stderr: true });

    worker.stderr.setEncoding('utf8');
    worker.stderr.on('data', (chunk: string) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) this.log.info(`[libredwg] ${line}`);
    });

    worker.on('online', () => this.log.info('parse worker online'));

    worker.on('message', (reply: WorkerReply) => {
      const entry = this.pending.get(reply.id);
      if (!entry) return;
      this.pending.delete(reply.id);
      clearTimeout(entry.timer);
      if (reply.ok && reply.scene) {
        entry.resolve(reply.scene);
      } else {
        if (reply.stack) this.log.error(reply.stack);
        entry.reject(new Error(reply.message || 'Unknown parser failure'));
      }
    });

    worker.on('error', (err) => {
      this.log.error(`parse worker error: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      this.failAll(err instanceof Error ? err : new Error(String(err)));
      // The worker is unusable after an error; the next parse spawns a fresh one.
      if (this.worker === worker) this.worker = null;
    });

    worker.on('exit', (code) => {
      if (code !== 0) {
        this.log.warn(`parse worker exited with code ${code}`);
        this.failAll(new Error(`VCAD parser worker stopped unexpectedly (exit code ${code})`));
      }
      if (this.worker === worker) this.worker = null;
    });

    this.worker = worker;
    return worker;
  }

  private restartWorker(reason: string): void {
    this.log.warn(`restarting parse worker: ${reason}`);
    const old = this.worker;
    this.worker = null;
    void old?.terminate();
  }

  private failAll(err: Error): void {
    for (const { reject, timer } of this.pending.values()) {
      clearTimeout(timer);
      reject(err);
    }
    this.pending.clear();
  }

  dispose(): void {
    this.disposed = true;
    this.failAll(new Error('VCAD parser has been disposed'));
    void this.worker?.terminate();
    this.worker = null;
  }
}
