/** Custom editor that renders a DWG/DXF drawing and hosts the markup tools. */

import * as path from 'node:path';
import * as vscode from 'vscode';

import type { HostMessage, ViewerCommand, ViewerConfig, WebviewMessage } from '../common/protocol';
import { ParseClient } from '../parser/client';
import type { BuildOptions } from '../parser/sceneBuilder';
import { NotesLocation, VcadDocument } from './document';

export class VcadEditorProvider implements vscode.CustomEditorProvider<VcadDocument> {
  static readonly viewType = 'vcad.drawing';

  private readonly panels = new Map<VcadDocument, Set<vscode.WebviewPanel>>();
  /** The panel that currently has focus, so title-bar commands know their target. */
  private activePanel: vscode.WebviewPanel | null = null;

  private readonly _onDidChangeCustomDocument = new vscode.EventEmitter<
    vscode.CustomDocumentEditEvent<VcadDocument>
  >();
  readonly onDidChangeCustomDocument = this._onDidChangeCustomDocument.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly parser: ParseClient,
    private readonly log: vscode.LogOutputChannel
  ) {}

  // ------------------------------------------------------------- lifecycle

  async openCustomDocument(
    uri: vscode.Uri,
    openContext: vscode.CustomDocumentOpenContext
  ): Promise<VcadDocument> {
    const location = vscode.workspace
      .getConfiguration('vcad')
      .get<NotesLocation>('notes.location', 'sibling');

    const doc = await VcadDocument.create(uri, location, openContext.backupId);

    doc.onDidChangeContent(({ notes, external }) => {
      // Undo/redo changed the notes behind the webview's back; push the new set.
      if (external) {
        this.broadcast(doc, { type: 'setNotes', notes: { version: 1, notes } });
      }
    });

    return doc;
  }

  async resolveCustomEditor(
    document: VcadDocument,
    panel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    this.register(document, panel);

    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
                           vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    };

    // The listener is attached before the HTML is assigned so a 'ready' sent the
    // instant the script runs cannot be missed.
    //
    // This method must NOT wait for 'ready'. VS Code only mounts the webview —
    // and so only runs its script — after resolveCustomEditor has returned.
    // Awaiting the handshake here deadlocks: the editor sits on "Loading…"
    // forever because the script that would send 'ready' never starts.
    panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
      if (msg.type === 'ready') {
        this.log.info(`webview ready: ${path.basename(document.uri.fsPath)}`);
        // 'ready' also fires if VS Code reloads the webview, so this doubles as
        // the recovery path for that case.
        void this.loadDrawing(document, panel);
        return;
      }
      void this.onWebviewMessage(document, msg);
    });

    panel.webview.html = this.html(panel.webview);
    this.log.info(`editor resolved: ${document.uri.fsPath}`);
  }

  private async loadDrawing(document: VcadDocument, panel: vscode.WebviewPanel): Promise<void> {
    const fileName = path.basename(document.uri.fsPath);
    this.post(panel, { type: 'loading', fileName });

    const cfg = vscode.workspace.getConfiguration('vcad');
    const config = viewerConfig(cfg);

    const options: BuildOptions = {
      darkBackground: config.background === 'dark' ||
        (config.background === 'match-theme' && !config.themeIsLight),
      maxEntities: cfg.get<number>('render.maxEntities', 400000),
      showText: cfg.get<boolean>('render.showText', true),
      curveResolution: cfg.get<number>('render.curveResolution', 64),
    };

    if (document.uri.scheme !== 'file') {
      this.post(panel, {
        type: 'error',
        message: 'VCAD can only open drawings stored on disk.',
        detail: `Unsupported location: ${document.uri.scheme}://`,
      });
      return;
    }

    const started = Date.now();
    this.log.info(`parsing ${document.uri.fsPath}`);
    try {
      const scene = await this.parser.parse(document.uri.fsPath, options);
      const s = scene.stats;
      this.log.info(
        `parsed ${fileName} in ${Date.now() - started} ms: ${s.format}, ` +
          `${s.polylines} polylines, ${s.arcs} arcs, ${s.ellipses} ellipses, ${s.texts} texts` +
          (Object.keys(s.skipped).length ? `; not rendered: ${JSON.stringify(s.skipped)}` : '')
      );
      const delivered = await panel.webview.postMessage({
        type: 'scene',
        scene,
        notes: { version: 1, notes: [...document.notes] },
        config,
      } satisfies HostMessage);
      if (!delivered) this.log.warn(`scene for ${fileName} was not delivered (webview gone?)`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      this.log.error(`failed to open ${fileName}: ${err instanceof Error && err.stack ? err.stack : detail}`);
      this.post(panel, { type: 'error', message: `Could not open ${fileName}`, detail });
    }
  }

  private register(document: VcadDocument, panel: vscode.WebviewPanel): void {
    let set = this.panels.get(document);
    if (!set) {
      set = new Set();
      this.panels.set(document, set);
    }
    set.add(panel);

    if (panel.active) this.activePanel = panel;
    void vscode.commands.executeCommand('setContext', 'vcad.activeEditor', panel.active);

    panel.onDidChangeViewState(() => {
      if (panel.active) this.activePanel = panel;
      else if (this.activePanel === panel) this.activePanel = null;
      void vscode.commands.executeCommand('setContext', 'vcad.activeEditor', panel.active);
    });

    panel.onDidDispose(() => {
      set!.delete(panel);
      if (set!.size === 0) this.panels.delete(document);
      if (this.activePanel === panel) {
        this.activePanel = null;
        void vscode.commands.executeCommand('setContext', 'vcad.activeEditor', false);
      }
    });
  }

  // -------------------------------------------------------------- messages

  private async onWebviewMessage(document: VcadDocument, msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'edit': {
        const edit = document.applyEdit(msg.notes, msg.description);
        this._onDidChangeCustomDocument.fire({
          document,
          label: edit.label,
          undo: () => document.undo(),
          redo: () => document.redo(),
        });
        return;
      }
      case 'exportPng':
        return this.savePng(document, msg.dataUri);
      case 'info':
        void vscode.window.showInformationMessage(msg.message);
        return;
      case 'error':
        this.log.error(`webview: ${msg.message}`);
        void vscode.window.showErrorMessage(msg.message);
        return;
      case 'log':
        this.log.info(`webview: ${msg.message}`);
        return;
      case 'ready':
        return;
    }
  }

  private async savePng(document: VcadDocument, dataUri: string): Promise<void> {
    const match = /^data:image\/png;base64,(.+)$/.exec(dataUri);
    if (!match) {
      void vscode.window.showErrorMessage('VCAD: the exported image was not valid PNG data.');
      return;
    }

    const suggested = vscode.Uri.file(
      document.uri.fsPath.replace(/\.(dwg|dxf)$/i, '') + '.png'
    );
    const target = await vscode.window.showSaveDialog({
      defaultUri: suggested,
      filters: { Images: ['png'] },
      title: 'Export drawing view as PNG',
    });
    if (!target) return;

    await vscode.workspace.fs.writeFile(target, Buffer.from(match[1], 'base64'));
    const open = 'Open';
    const pick = await vscode.window.showInformationMessage(
      `Exported ${path.basename(target.fsPath)}`,
      open
    );
    if (pick === open) await vscode.commands.executeCommand('vscode.open', target);
  }

  // -------------------------------------------------------------- commands

  /** Forwards a title-bar or palette command to the focused viewer. */
  runCommand(command: ViewerCommand): void {
    if (!this.activePanel) return;
    this.post(this.activePanel, { type: 'command', command });
  }

  /** Re-parses the drawing in the focused viewer, picking up config changes. */
  async reloadActive(): Promise<void> {
    const panel = this.activePanel;
    if (!panel) return;
    for (const [doc, panels] of this.panels) {
      if (panels.has(panel)) {
        await this.loadDrawing(doc, panel);
        return;
      }
    }
  }

  /** Pushes updated settings to every open viewer without re-parsing. */
  refreshConfig(): void {
    const config = viewerConfig(vscode.workspace.getConfiguration('vcad'));
    for (const panels of this.panels.values()) {
      for (const panel of panels) this.post(panel, { type: 'config', config });
    }
  }

  // ------------------------------------------------ CustomEditorProvider API

  saveCustomDocument(
    document: VcadDocument,
    cancellation: vscode.CancellationToken
  ): Thenable<void> {
    return document.save(cancellation);
  }

  saveCustomDocumentAs(
    document: VcadDocument,
    destination: vscode.Uri,
    cancellation: vscode.CancellationToken
  ): Thenable<void> {
    return document.saveAs(destination, cancellation);
  }

  revertCustomDocument(document: VcadDocument): Thenable<void> {
    return document.revert();
  }

  backupCustomDocument(
    document: VcadDocument,
    context: vscode.CustomDocumentBackupContext
  ): Thenable<vscode.CustomDocumentBackup> {
    return document.backup(context.destination);
  }

  // --------------------------------------------------------------- helpers

  private post(panel: vscode.WebviewPanel, message: HostMessage): void {
    panel.webview.postMessage(message).then(undefined, (err) => {
      this.log.error(`postMessage(${message.type}) failed: ${err}`);
    });
  }

  private broadcast(document: VcadDocument, message: HostMessage): void {
    for (const panel of this.panels.get(document) ?? []) this.post(panel, message);
  }

  private html(webview: vscode.Webview): string {
    const asset = (...parts: string[]) =>
      webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...parts));

    const script = asset('dist', 'webview.js');
    const style = asset('media', 'viewer.css');
    const nonce = makeNonce();

    // Scripts are locked to a per-load nonce; the viewer needs no remote
    // resources, so everything else stays at 'none'.
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} blob: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link href="${style}" rel="stylesheet">
<title>VCAD</title>
</head>
<body>
<div id="root">
  <div id="toolbar" role="toolbar" aria-label="Markup tools"></div>
  <div id="stage">
    <canvas id="canvas"></canvas>
    <div id="overlay"></div>
    <div id="status" role="status"></div>
  </div>
  <aside id="layers" hidden aria-label="Layers"></aside>
</div>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function viewerConfig(cfg: vscode.WorkspaceConfiguration): ViewerConfig {
  const kind = vscode.window.activeColorTheme.kind;
  return {
    background: cfg.get('background', 'dark'),
    showText: cfg.get('render.showText', true),
    lineWidth: cfg.get('render.lineWidth', 1),
    themeIsLight:
      kind === vscode.ColorThemeKind.Light || kind === vscode.ColorThemeKind.HighContrastLight,
  };
}

function makeNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let out = '';
  for (let i = 0; i < 32; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}
