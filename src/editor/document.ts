/**
 * The document behind a VCAD editor tab.
 *
 * The drawing itself is never written to. What this document owns — and what
 * Ctrl+S, undo, redo and hot exit all act on — is the markup, stored in a
 * sidecar JSON file next to the drawing.
 */

import * as path from 'node:path';
import * as vscode from 'vscode';

import { emptyNotes, Note, NotesFile, parseNotes } from '../common/annotations';

export type NotesLocation = 'sibling' | 'subfolder';

/** One undoable change, stored as before/after snapshots. */
interface NoteEdit {
  label: string;
  before: Note[];
  after: Note[];
}

export class VcadDocument implements vscode.CustomDocument {
  private _notes: Note[] = [];
  private _savedNotes: string;
  private edits: NoteEdit[] = [];
  private editIndex = 0;

  private readonly _onDidChangeContent = new vscode.EventEmitter<{
    notes: Note[];
    /** True when the change came from undo/redo and the webview must resync. */
    external: boolean;
  }>();
  readonly onDidChangeContent = this._onDidChangeContent.event;

  private readonly _onDidChangeDirty = new vscode.EventEmitter<void>();
  readonly onDidChangeDirty = this._onDidChangeDirty.event;

  private constructor(
    readonly uri: vscode.Uri,
    readonly notesUri: vscode.Uri,
    initial: NotesFile
  ) {
    this._notes = initial.notes;
    this._savedNotes = this.serialize();
  }

  static async create(
    uri: vscode.Uri,
    location: NotesLocation,
    backupId: string | undefined
  ): Promise<VcadDocument> {
    const notesUri = notesUriFor(uri, location);
    // A backup takes precedence: it is the unsaved state VS Code preserved
    // across a restart, and reading the sidecar instead would discard it.
    const source = backupId ? vscode.Uri.parse(backupId) : notesUri;
    const notes = await readNotes(source);
    return new VcadDocument(uri, notesUri, notes);
  }

  get notes(): readonly Note[] {
    return this._notes;
  }

  get isDirty(): boolean {
    return this.serialize() !== this._savedNotes;
  }

  get canUndo(): boolean {
    return this.editIndex > 0;
  }

  get canRedo(): boolean {
    return this.editIndex < this.edits.length;
  }

  /** Records a change made in the webview and returns the edit for VS Code. */
  applyEdit(next: Note[], label: string): NoteEdit {
    const edit: NoteEdit = { label, before: this._notes, after: next };
    // A new edit invalidates any redo branch.
    this.edits.length = this.editIndex;
    this.edits.push(edit);
    this.editIndex = this.edits.length;
    this._notes = next;
    this._onDidChangeDirty.fire();
    this._onDidChangeContent.fire({ notes: next, external: false });
    return edit;
  }

  undo(): void {
    if (!this.canUndo) return;
    this.editIndex--;
    this._notes = this.edits[this.editIndex].before;
    this._onDidChangeDirty.fire();
    this._onDidChangeContent.fire({ notes: this._notes, external: true });
  }

  redo(): void {
    if (!this.canRedo) return;
    this._notes = this.edits[this.editIndex].after;
    this.editIndex++;
    this._onDidChangeDirty.fire();
    this._onDidChangeContent.fire({ notes: this._notes, external: true });
  }

  async save(cancellation?: vscode.CancellationToken): Promise<void> {
    await this.saveAs(this.notesUri, cancellation);
    this._savedNotes = this.serialize();
    this._onDidChangeDirty.fire();
  }

  async saveAs(target: vscode.Uri, cancellation?: vscode.CancellationToken): Promise<void> {
    const body = this.serialize();
    if (cancellation?.isCancellationRequested) return;

    if (this._notes.length === 0) {
      // Deleting every note should leave the folder clean rather than leaving an
      // empty sidecar behind. Only do this for our own target, never a "save as".
      if (target.toString() === this.notesUri.toString()) {
        try {
          await vscode.workspace.fs.delete(target);
        } catch {
          // Nothing to delete; that is the desired end state anyway.
        }
        return;
      }
    }

    await ensureParentDir(target);
    await vscode.workspace.fs.writeFile(target, Buffer.from(body, 'utf8'));
  }

  async revert(): Promise<void> {
    const loaded = await readNotes(this.notesUri);
    this._notes = loaded.notes;
    this.edits = [];
    this.editIndex = 0;
    this._savedNotes = this.serialize();
    this._onDidChangeDirty.fire();
    this._onDidChangeContent.fire({ notes: this._notes, external: true });
  }

  async backup(destination: vscode.Uri): Promise<vscode.CustomDocumentBackup> {
    await ensureParentDir(destination);
    await vscode.workspace.fs.writeFile(destination, Buffer.from(this.serialize(), 'utf8'));
    return {
      id: destination.toString(),
      delete: async () => {
        try {
          await vscode.workspace.fs.delete(destination);
        } catch {
          // The backup is best-effort; a failed cleanup must not surface.
        }
      },
    };
  }

  private serialize(): string {
    const file: NotesFile = {
      version: 1,
      drawing: path.basename(this.uri.fsPath),
      notes: this._notes,
    };
    return JSON.stringify(file, null, 2) + '\n';
  }

  dispose(): void {
    this._onDidChangeContent.dispose();
    this._onDidChangeDirty.dispose();
  }
}

export function notesUriFor(drawing: vscode.Uri, location: NotesLocation): vscode.Uri {
  const dir = path.dirname(drawing.fsPath);
  const base = path.basename(drawing.fsPath);
  const file = `${base}.vcadnotes.json`;
  return vscode.Uri.file(
    location === 'subfolder' ? path.join(dir, '.vcad', file) : path.join(dir, file)
  );
}

async function readNotes(uri: vscode.Uri): Promise<NotesFile> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    return parseNotes(JSON.parse(Buffer.from(bytes).toString('utf8')));
  } catch {
    // Missing or unparseable: start from a clean slate rather than blocking the
    // drawing from opening. The existing file is left untouched until a save.
    return emptyNotes();
  }
}

async function ensureParentDir(target: vscode.Uri): Promise<void> {
  const dir = vscode.Uri.file(path.dirname(target.fsPath));
  try {
    await vscode.workspace.fs.createDirectory(dir);
  } catch {
    // Already exists, which is the common case.
  }
}
