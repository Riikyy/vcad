/**
 * The intermediate drawing model.
 *
 * Both readers — libredwg for DWG and the hand-written reader for DXF — produce
 * this shape, so the scene builder is written once. Field names deliberately
 * mirror libredwg-web's `Dwg*` interfaces, which makes the DWG path a near
 * identity mapping and keeps the DXF reader honest about DXF group semantics.
 *
 * Everything is optional and loosely typed on purpose: these values come from
 * third-party files that routinely omit "required" fields.
 */

export interface P3 {
  x: number;
  y: number;
  z?: number;
}

export interface DocEntity {
  type: string;
  layer?: string;
  colorIndex?: number;
  color?: number;
  lineweight?: number;
  lineType?: string;
  isVisible?: boolean;
  extrusionDirection?: P3;
  [key: string]: unknown;
}

export interface DocLayer {
  name: string;
  colorIndex?: number;
  color?: number;
  off?: boolean;
  frozen?: boolean;
  lineweight?: number;
}

export interface DocBlock {
  name: string;
  basePoint?: P3;
  entities: DocEntity[];
}

export interface Doc {
  /** Human-readable format label for the status bar. */
  format: string;
  layers: DocLayer[];
  /** Keyed by upper-cased block name, since DWG and DXF disagree on casing. */
  blocks: Map<string, DocBlock>;
  /** Model-space entities. */
  entities: DocEntity[];
  header: Record<string, unknown>;
}

/** Looks a block up case-insensitively. */
export function findBlock(doc: Doc, name: string | undefined): DocBlock | undefined {
  if (!name) return undefined;
  return doc.blocks.get(name.toUpperCase());
}

export function addBlock(doc: Doc, block: DocBlock): void {
  doc.blocks.set(block.name.toUpperCase(), block);
}
