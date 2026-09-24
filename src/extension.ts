import * as path from 'node:path';
import * as vscode from 'vscode';

import { VcadEditorProvider } from './editor/provider';
import { ParseClient } from './parser/client';

export function activate(context: vscode.ExtensionContext): void {
  const distDir = path.join(context.extensionPath, 'dist');
  // libredwg-web loads its .wasm as a sibling of its glue code, so the worker is
  // handed the package's own wasm directory rather than a copy.
  const wasmDir = path.join(
    context.extensionPath,
    'node_modules',
    '@mlightcad',
    'libredwg-web',
    'wasm'
  );

  // View > Output > VCAD. Every step of opening a drawing is logged here, so a
  // drawing that never appears can be diagnosed instead of failing silently.
  const log = vscode.window.createOutputChannel('VCAD', { log: true });
  context.subscriptions.push(log);
  log.info(`activated from ${context.extensionPath}`);

  const parser = new ParseClient(distDir, wasmDir, log);
  context.subscriptions.push({ dispose: () => parser.dispose() });

  const provider = new VcadEditorProvider(context, parser, log);

  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VcadEditorProvider.viewType, provider, {
      webviewOptions: {
        // Re-parsing a large drawing on every tab switch is far more expensive
        // than keeping the webview alive.
        retainContextWhenHidden: true,
      },
      supportsMultipleEditorsPerDocument: false,
    })
  );

  const forward = (command: Parameters<VcadEditorProvider['runCommand']>[0]) =>
    vscode.commands.registerCommand(`vcad.${command}`, () => provider.runCommand(command));

  context.subscriptions.push(
    forward('zoomExtents'),
    forward('zoomIn'),
    forward('zoomOut'),
    forward('toggleLayers'),
    forward('toggleNotes'),
    forward('clearNotes'),
    forward('exportPng'),
    vscode.commands.registerCommand('vcad.reload', () => provider.reloadActive())
  );

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration('vcad')) return;
      // Colours, extents and text are baked into the parsed scene, so those
      // settings need a re-parse; the rest can be pushed to the live viewer.
      const needsReparse =
        e.affectsConfiguration('vcad.background') ||
        e.affectsConfiguration('vcad.render.maxEntities') ||
        e.affectsConfiguration('vcad.render.curveResolution') ||
        e.affectsConfiguration('vcad.render.showText');
      if (needsReparse) void provider.reloadActive();
      else provider.refreshConfig();
    }),
    vscode.window.onDidChangeActiveColorTheme(() => provider.refreshConfig())
  );
}

export function deactivate(): void {
  // Disposal is handled through context.subscriptions.
}
