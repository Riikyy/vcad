/** Messages exchanged between the extension host and the webview. */

import type { Note, NotesFile } from './annotations';
import type { Scene } from './scene';

export interface ViewerConfig {
  background: 'dark' | 'light' | 'match-theme';
  showText: boolean;
  lineWidth: number;
  /** True when the VS Code colour theme is a light one. */
  themeIsLight: boolean;
}

/** Host -> webview. */
export type HostMessage =
  | { type: 'loading'; fileName: string }
  | { type: 'scene'; scene: Scene; notes: NotesFile; config: ViewerConfig }
  | { type: 'error'; message: string; detail?: string }
  | { type: 'config'; config: ViewerConfig }
  /** Full replacement of the note set, used for undo/redo and external edits. */
  | { type: 'setNotes'; notes: NotesFile }
  | { type: 'command'; command: ViewerCommand };

export type ViewerCommand =
  | 'zoomExtents'
  | 'zoomIn'
  | 'zoomOut'
  | 'toggleLayers'
  | 'toggleNotes'
  | 'clearNotes'
  | 'exportPng';

/** Webview -> host. */
export type WebviewMessage =
  | { type: 'ready' }
  /** The user changed the markup; `notes` is the complete new set. */
  | { type: 'edit'; notes: Note[]; description: string }
  | { type: 'exportPng'; dataUri: string }
  | { type: 'info'; message: string }
  /** Diagnostic line for the VCAD output channel; never shown as a popup. */
  | { type: 'log'; message: string }
  | { type: 'error'; message: string };
