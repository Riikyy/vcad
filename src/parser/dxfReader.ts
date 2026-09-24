/**
 * A reader for ASCII DXF files.
 *
 * The libredwg WebAssembly build this extension ships is compiled without DXF
 * support, so DXF is parsed here instead. Output deliberately matches the shape
 * libredwg produces for DWG — including angles converted from DXF's degrees into
 * radians — so the scene builder never has to care which reader ran.
 */

import { addBlock, Doc, DocEntity, DocLayer, P3 } from './doc';

const DEG = Math.PI / 180;

interface Tag {
  code: number;
  value: string;
}

/** DXF group values are typed by the numeric range their code falls in. */
function isStringCode(code: number): boolean {
  return (
    (code >= 0 && code <= 9) ||
    (code >= 100 && code <= 102) ||
    (code >= 300 && code <= 369) ||
    (code >= 390 && code <= 399) ||
    (code >= 410 && code <= 419) ||
    (code >= 430 && code <= 439) ||
    (code >= 470 && code <= 481) ||
    code === 999 ||
    (code >= 1000 && code <= 1009)
  );
}

export function isBinaryDxf(data: Uint8Array): boolean {
  const sentinel = 'AutoCAD Binary DXF';
  if (data.length < sentinel.length) return false;
  for (let i = 0; i < sentinel.length; i++) {
    if (data[i] !== sentinel.charCodeAt(i)) return false;
  }
  return true;
}

function decodeText(data: Uint8Array): string {
  // R2007 and later are UTF-8; earlier files are usually an ANSI code page.
  // Decoding as UTF-8 first and falling back to latin1 keeps both readable,
  // since a latin1 file with high bytes will fail a strict UTF-8 decode.
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(data);
  } catch {
    return new TextDecoder('latin1').decode(data);
  }
}

function tokenize(text: string): Tag[] {
  const lines = text.split(/\r\n|\r|\n/);
  const tags: Tag[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const codeStr = lines[i].trim();
    if (codeStr === '') {
      // A stray blank line would desynchronise every following pair; resync by
      // stepping one line instead of two.
      i -= 1;
      continue;
    }
    const code = Number(codeStr);
    if (!Number.isFinite(code)) {
      i -= 1;
      continue;
    }
    tags.push({ code, value: lines[i + 1] });
  }
  return tags;
}

/** Decodes the `\U+XXXX` and `%%d`-style escapes DXF uses inside text strings. */
function decodeDxfText(s: string): string {
  let out = s.replace(/\\U\+([0-9A-Fa-f]{4})/g, (_m, hex: string) =>
    String.fromCharCode(parseInt(hex, 16))
  );
  out = out
    .replace(/%%d/gi, '°')
    .replace(/%%p/gi, '±')
    .replace(/%%c/gi, '⌀')
    .replace(/%%%/g, '%');
  // %%u and %%o toggle underline/overline, which this viewer does not render.
  out = out.replace(/%%[uo]/gi, '');
  return out;
}

/** Accumulates the group tags of a single entity for typed access. */
class TagBag {
  private single = new Map<number, string>();
  private multi = new Map<number, string[]>();
  /**
   * Tags in the order they appeared. Structures whose meaning depends on
   * interleaving — LWPOLYLINE vertices, HATCH boundary paths — must read this
   * rather than the by-code maps, which collapse ordering.
   */
  readonly ordered: Tag[] = [];

  add(code: number, value: string): void {
    if (!this.single.has(code)) this.single.set(code, value);
    let list = this.multi.get(code);
    if (!list) {
      list = [];
      this.multi.set(code, list);
    }
    list.push(value);
    this.ordered.push({ code, value });
  }

  has(code: number): boolean {
    return this.single.has(code);
  }

  str(code: number, fallback = ''): string {
    const v = this.single.get(code);
    return v === undefined ? fallback : v;
  }

  num(code: number, fallback = 0): number {
    const v = this.single.get(code);
    if (v === undefined) return fallback;
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : fallback;
  }

  int(code: number, fallback = 0): number {
    return Math.trunc(this.num(code, fallback));
  }

  /** Reads an angle stored in degrees and returns radians. */
  angle(code: number, fallback = 0): number {
    return this.num(code, fallback) * DEG;
  }

  list(code: number): string[] {
    return this.multi.get(code) ?? [];
  }

  nums(code: number): number[] {
    return this.list(code).map((v) => {
      const n = Number(v.trim());
      return Number.isFinite(n) ? n : 0;
    });
  }

  point(x = 10, y = 20, z = 30): P3 {
    return { x: this.num(x), y: this.num(y), z: this.num(z) };
  }

  hasPoint(x = 10): boolean {
    return this.single.has(x);
  }

  /** Extrusion vector; defaults to +Z exactly as the DXF specification does. */
  extrusion(): P3 {
    if (!this.single.has(210)) return { x: 0, y: 0, z: 1 };
    return { x: this.num(210), y: this.num(220), z: this.num(230, 1) };
  }
}

interface RawEntity {
  type: string;
  bag: TagBag;
  /** VERTEX/ATTRIB entities gathered between an owner entity and its SEQEND. */
  children: RawEntity[];
  /** True when another entity owns this one and will draw it. */
  attached?: boolean;
}

export function readDxf(data: Uint8Array): Doc {
  if (isBinaryDxf(data)) {
    throw new Error(
      'This is a binary DXF file. Save it as ASCII DXF, or use the DWG format, ' +
        'which this extension reads directly.'
    );
  }

  const tags = tokenize(decodeText(data));
  const doc: Doc = {
    format: 'DXF',
    layers: [],
    blocks: new Map(),
    entities: [],
    header: {},
  };

  let i = 0;
  while (i < tags.length) {
    const t = tags[i];
    if (t.code === 0 && t.value.trim() === 'SECTION') {
      const nameTag = tags[i + 1];
      const section = nameTag && nameTag.code === 2 ? nameTag.value.trim() : '';
      i += 2;
      switch (section) {
        case 'HEADER':
          i = readHeader(tags, i, doc);
          break;
        case 'TABLES':
          i = readTables(tags, i, doc);
          break;
        case 'BLOCKS':
          i = readBlocks(tags, i, doc);
          break;
        case 'ENTITIES':
          i = readEntities(tags, i, doc.entities);
          break;
        default:
          i = skipSection(tags, i);
      }
      continue;
    }
    if (t.code === 0 && t.value.trim() === 'EOF') break;
    i++;
  }

  const ver = doc.header.$ACADVER;
  doc.format = typeof ver === 'string' ? `DXF ${describeVersion(ver)}` : 'DXF';

  if (!doc.layers.length) doc.layers.push({ name: '0', colorIndex: 7 });
  return doc;
}

function describeVersion(code: string): string {
  const map: Record<string, string> = {
    AC1006: 'R10',
    AC1009: 'R11/R12',
    AC1012: 'R13',
    AC1014: 'R14',
    AC1015: '2000',
    AC1018: '2004',
    AC1021: '2007',
    AC1024: '2010',
    AC1027: '2013',
    AC1032: '2018',
  };
  return map[code] ? `${map[code]} (${code})` : code;
}

function skipSection(tags: Tag[], i: number): number {
  while (i < tags.length) {
    if (tags[i].code === 0 && tags[i].value.trim() === 'ENDSEC') return i + 1;
    i++;
  }
  return i;
}

function readHeader(tags: Tag[], i: number, doc: Doc): number {
  let current: string | null = null;
  while (i < tags.length) {
    const t = tags[i];
    if (t.code === 0 && t.value.trim() === 'ENDSEC') return i + 1;
    if (t.code === 9) {
      current = t.value.trim();
      i++;
      continue;
    }
    if (current) {
      // Point-valued variables arrive as consecutive 10/20/30 groups.
      if (t.code === 10) {
        const p: P3 = { x: Number(t.value) || 0, y: 0, z: 0 };
        if (tags[i + 1]?.code === 20) p.y = Number(tags[i + 1].value) || 0;
        if (tags[i + 2]?.code === 30) p.z = Number(tags[i + 2].value) || 0;
        doc.header[current] = p;
      } else if (isStringCode(t.code)) {
        doc.header[current] = t.value;
      } else {
        const n = Number(t.value);
        doc.header[current] = Number.isFinite(n) ? n : t.value;
      }
    }
    i++;
  }
  return i;
}

function readTables(tags: Tag[], i: number, doc: Doc): number {
  let inLayerTable = false;
  let bag: TagBag | null = null;
  let kind = '';

  const flush = () => {
    if (kind === 'LAYER' && bag) doc.layers.push(toLayer(bag));
    bag = null;
    kind = '';
  };

  while (i < tags.length) {
    const t = tags[i];
    if (t.code === 0) {
      const v = t.value.trim();
      if (v === 'ENDSEC') {
        flush();
        return i + 1;
      }
      flush();
      if (v === 'TABLE') {
        const nameTag = tags[i + 1];
        inLayerTable = nameTag?.code === 2 && nameTag.value.trim() === 'LAYER';
        i += 2;
        continue;
      }
      if (v === 'ENDTAB') {
        inLayerTable = false;
        i++;
        continue;
      }
      if (v === 'LAYER' && inLayerTable) {
        kind = 'LAYER';
        bag = new TagBag();
      }
      i++;
      continue;
    }
    if (bag) bag.add(t.code, t.value);
    i++;
  }
  return i;
}

function toLayer(bag: TagBag): DocLayer {
  const ci = bag.int(62, 7);
  const flags = bag.int(70, 0);
  const layer: DocLayer = {
    name: bag.str(2, '0'),
    colorIndex: Math.abs(ci),
    // AutoCAD encodes "layer off" as a negative colour index.
    off: ci < 0,
    // Bit 1 of the standard flags marks the layer frozen.
    frozen: (flags & 1) !== 0,
    lineweight: bag.has(370) ? bag.int(370) : undefined,
  };
  if (bag.has(420)) layer.color = bag.int(420);
  return layer;
}

function readBlocks(tags: Tag[], i: number, doc: Doc): number {
  while (i < tags.length) {
    const t = tags[i];
    if (t.code === 0 && t.value.trim() === 'ENDSEC') return i + 1;

    if (t.code === 0 && t.value.trim() === 'BLOCK') {
      const bag = new TagBag();
      i++;
      while (i < tags.length && tags[i].code !== 0) {
        bag.add(tags[i].code, tags[i].value);
        i++;
      }
      const entities: DocEntity[] = [];
      i = readEntities(tags, i, entities, 'ENDBLK');
      addBlock(doc, {
        name: bag.str(2) || bag.str(3),
        basePoint: bag.point(),
        entities,
      });
      continue;
    }
    i++;
  }
  return i;
}

/**
 * Reads a run of entities, stopping at `terminator` or ENDSEC.
 * POLYLINE swallows its trailing VERTEX list up to SEQEND.
 */
function readEntities(
  tags: Tag[],
  i: number,
  out: DocEntity[],
  terminator = 'ENDSEC'
): number {
  const raws: RawEntity[] = [];
  let current: RawEntity | null = null;
  let collectingInto: RawEntity | null = null;

  const finish = () => {
    if (current) raws.push(current);
    current = null;
  };

  while (i < tags.length) {
    const t = tags[i];
    if (t.code === 0) {
      const v = t.value.trim();
      if (v === terminator || v === 'ENDSEC' || v === 'EOF') {
        finish();
        // Leave ENDSEC for the caller when it is not our own terminator.
        i = v === terminator ? i + 1 : i;
        break;
      }
      if (v === 'SEQEND') {
        finish();
        collectingInto = null;
        i++;
        continue;
      }
      if ((v === 'VERTEX' || v === 'ATTRIB') && collectingInto) {
        finish();
        // Owned by the preceding POLYLINE/INSERT; `attached` keeps it from also
        // being emitted as a standalone entity below.
        current = { type: v, bag: new TagBag(), children: [], attached: true };
        collectingInto.children.push(current);
        i++;
        continue;
      }
      finish();
      current = { type: v, bag: new TagBag(), children: [] };
      // POLYLINE and INSERT own the entities that follow them until SEQEND.
      collectingInto = v === 'POLYLINE' || v === 'INSERT' ? current : null;
      i++;
      continue;
    }
    if (current) current.bag.add(t.code, t.value);
    i++;
  }

  for (const raw of raws) {
    // Children were pushed into `raws` as well; they are drawn through their
    // owner, so emitting them here would double them up.
    if (raw.attached) continue;
    const e = convert(raw);
    if (e) out.push(e);
  }
  return i;
}

function common(bag: TagBag): DocEntity {
  const e: DocEntity = {
    type: '',
    layer: bag.str(8, '0'),
    colorIndex: bag.has(62) ? bag.int(62) : undefined,
    lineType: bag.has(6) ? bag.str(6) : undefined,
    lineweight: bag.has(370) ? bag.int(370) : undefined,
    extrusionDirection: bag.extrusion(),
  };
  if (bag.has(420)) e.color = bag.int(420);
  // Group 60 is a visibility flag: 0 visible, 1 invisible.
  if (bag.has(60)) e.isVisible = bag.int(60) === 0;
  return e;
}

// eslint-disable-next-line complexity
function convert(raw: RawEntity): DocEntity | null {
  const { bag, type } = raw;
  const e = common(bag);
  e.type = type;

  switch (type) {
    case 'LINE':
      e.startPoint = bag.point();
      e.endPoint = bag.point(11, 21, 31);
      return e;

    case 'CIRCLE':
      e.center = bag.point();
      e.radius = bag.num(40);
      return e;

    case 'ARC':
      e.center = bag.point();
      e.radius = bag.num(40);
      e.startAngle = bag.angle(50);
      e.endAngle = bag.angle(51);
      return e;

    case 'ELLIPSE':
      e.center = bag.point();
      e.majorAxisEndPoint = bag.point(11, 21, 31);
      e.axisRatio = bag.num(40, 1);
      // Group 41/42 are true parameters in radians, not degrees.
      e.startAngle = bag.num(41, 0);
      e.endAngle = bag.num(42, Math.PI * 2);
      return e;

    case 'POINT':
      e.position = bag.point();
      return e;

    case 'LWPOLYLINE': {
      // Bulges are sparse — a straight vertex omits group 42 entirely — so the
      // vertex list has to be walked in tag order to keep bulges on the right
      // vertices.
      const verts: { x: number; y: number; bulge: number }[] = [];
      for (const tag of bag.ordered) {
        const v = Number(tag.value);
        const n = Number.isFinite(v) ? v : 0;
        if (tag.code === 10) verts.push({ x: n, y: 0, bulge: 0 });
        else if (tag.code === 20 && verts.length) verts[verts.length - 1].y = n;
        else if (tag.code === 42 && verts.length) verts[verts.length - 1].bulge = n;
      }
      e.vertices = verts;
      e.flag = bag.int(70);
      e.elevation = bag.num(38);
      return e;
    }

    case 'POLYLINE': {
      const flag = bag.int(70);
      const is3d = (flag & 8) !== 0 || (flag & 16) !== 0;
      const verts = raw.children
        .filter((c) => c.type === 'VERTEX')
        .map((c) => ({
          x: c.bag.num(10),
          y: c.bag.num(20),
          z: c.bag.num(30),
          bulge: c.bag.num(42),
          flag: c.bag.int(70),
        }));
      e.type = is3d ? 'POLYLINE3D' : 'POLYLINE2D';
      e.vertices = verts;
      e.flag = flag;
      e.elevation = bag.num(30);
      return e;
    }

    case 'SPLINE': {
      const xs = bag.nums(10);
      const ys = bag.nums(20);
      const cps = xs.map((x, k) => ({ x, y: ys[k] ?? 0, z: 0 }));
      const fxs = bag.nums(11);
      const fys = bag.nums(21);
      e.controlPoints = cps;
      e.fitPoints = fxs.map((x, k) => ({ x, y: fys[k] ?? 0, z: 0 }));
      e.knots = bag.nums(40);
      const weights = bag.nums(41);
      e.weights = weights.length === cps.length ? weights : undefined;
      e.degree = bag.int(71, 3);
      e.flag = bag.int(70);
      return e;
    }

    case 'SOLID':
    case 'TRACE':
      e.corner1 = bag.point(10, 20, 30);
      e.corner2 = bag.point(11, 21, 31);
      e.corner3 = bag.point(12, 22, 32);
      e.corner4 = bag.hasPoint(13) ? bag.point(13, 23, 33) : bag.point(12, 22, 32);
      return e;

    case '3DFACE':
      e.corner1 = bag.point(10, 20, 30);
      e.corner2 = bag.point(11, 21, 31);
      e.corner3 = bag.point(12, 22, 32);
      e.corner4 = bag.hasPoint(13) ? bag.point(13, 23, 33) : bag.point(12, 22, 32);
      e.flag = bag.int(70);
      return e;

    case 'TEXT':
    case 'ATTRIB': {
      const text = {
        text: decodeDxfText(bag.str(1)),
        startPoint: bag.point(),
        endPoint: bag.hasPoint(11) ? bag.point(11, 21, 31) : undefined,
        textHeight: bag.num(40, 1),
        rotation: bag.angle(50),
        xScale: bag.num(41, 1),
        obliqueAngle: bag.angle(51),
        halign: bag.int(72),
        valign: bag.int(73),
        extrusionDirection: bag.extrusion(),
      };
      if (type === 'ATTRIB') {
        e.text = text;
        e.tag = bag.str(2);
        e.flags = bag.int(70);
      } else {
        Object.assign(e, text);
      }
      return e;
    }

    case 'MTEXT':
      e.insertionPoint = bag.point();
      e.textHeight = bag.num(40, 1);
      e.rectWidth = bag.num(41);
      e.attachmentPoint = bag.int(71, 1);
      e.drawingDirection = bag.int(72, 1);
      // Long MTEXT is split across repeated group 3 chunks ending with group 1.
      e.text = decodeDxfText(bag.list(3).join('') + bag.str(1));
      e.rotation = bag.angle(50);
      e.lineSpacing = bag.num(44, 1);
      if (bag.hasPoint(11)) e.direction = bag.point(11, 21, 31);
      return e;

    case 'INSERT':
      e.name = bag.str(2);
      e.insertionPoint = bag.point();
      e.xScale = bag.num(41, 1);
      e.yScale = bag.num(42, 1);
      e.zScale = bag.num(43, 1);
      e.rotation = bag.angle(50);
      e.columnCount = bag.int(70, 1);
      e.rowCount = bag.int(71, 1);
      e.columnSpacing = bag.num(44);
      e.rowSpacing = bag.num(45);
      e.attribs = raw.children
        .filter((c) => c.type === 'ATTRIB')
        .map((c) => convert(c))
        .filter((x): x is DocEntity => x !== null);
      return e;

    case 'DIMENSION':
      // Group 2 names the anonymous block holding the drawn representation.
      e.name = bag.str(2);
      e.definitionPoint = bag.point();
      e.textPoint = bag.point(11, 21, 31);
      e.dimensionType = bag.int(70);
      return e;

    case 'LEADER': {
      const xs = bag.nums(10);
      const ys = bag.nums(20);
      const zs = bag.nums(30);
      e.vertices = xs.map((x, k) => ({ x, y: ys[k] ?? 0, z: zs[k] ?? 0 }));
      e.isSpline = bag.int(72) === 1;
      return e;
    }

    case 'XLINE':
    case 'RAY':
      e.firstPoint = bag.point();
      e.unitDirectionVector = bag.point(11, 21, 31);
      return e;

    case 'HATCH':
      e.patternName = bag.str(2);
      e.solidFill = bag.int(70);
      e.boundaryPaths = readHatchPaths(bag);
      return e;

    case 'VIEWPORT':
    case 'ATTDEF':
    case 'SEQEND':
      return null;

    default:
      // Unknown types still flow through so the builder can report them.
      return e;
  }
}

interface DxfHatchVertex {
  x: number;
  y: number;
  bulge: number;
}

interface DxfHatchEdge {
  type: number;
  start?: { x: number; y: number };
  end?: { x: number; y: number };
  center?: { x: number; y: number };
  radius?: number;
  startAngle?: number;
  endAngle?: number;
  isCCW?: boolean;
  lengthOfMinorAxis?: number;
  degree?: number;
  knots?: number[];
  controlPoints?: { x: number; y: number; weight?: number }[];
}

interface DxfHatchPath {
  boundaryPathTypeFlag: number;
  isClosed?: boolean;
  vertices?: DxfHatchVertex[];
  edges?: DxfHatchEdge[];
  numberOfVertices?: number;
  numberOfEdges?: number;
}

/**
 * Parses HATCH boundary paths.
 *
 * The boundary data is a nested, order-dependent structure: group 92 opens a
 * path, and its type flag decides whether the following groups describe a
 * polyline (bit 2 set) or a list of typed edges. Group 97 closes the path with
 * the source-object handles, which are not geometry.
 */
function readHatchPaths(bag: TagBag): DxfHatchPath[] {
  const paths: DxfHatchPath[] = [];
  let path: DxfHatchPath | null = null;
  let edge: DxfHatchEdge | null = null;
  let isPolyline = false;
  /** Set once group 97 is seen, to ignore trailing handle groups. */
  let inSource = false;

  const num = (t: Tag) => {
    const v = Number(t.value);
    return Number.isFinite(v) ? v : 0;
  };

  for (const t of bag.ordered) {
    // Group 75 (hatch style) marks the end of the boundary data.
    if (t.code === 75) break;

    if (t.code === 92) {
      path = { boundaryPathTypeFlag: num(t) };
      isPolyline = (path.boundaryPathTypeFlag & 2) !== 0;
      if (isPolyline) path.vertices = [];
      else path.edges = [];
      edge = null;
      inSource = false;
      paths.push(path);
      continue;
    }
    if (!path) continue;
    if (t.code === 97) {
      inSource = true;
      continue;
    }
    if (inSource) continue;

    if (isPolyline) {
      switch (t.code) {
        case 72:
          // hasBulge flag; bulges themselves arrive per-vertex as group 42.
          break;
        case 73:
          path.isClosed = num(t) !== 0;
          break;
        case 93:
          path.numberOfVertices = num(t);
          break;
        case 10:
          path.vertices!.push({ x: num(t), y: 0, bulge: 0 });
          break;
        case 20:
          if (path.vertices!.length) path.vertices![path.vertices!.length - 1].y = num(t);
          break;
        case 42:
          if (path.vertices!.length) path.vertices![path.vertices!.length - 1].bulge = num(t);
          break;
        default:
          break;
      }
      continue;
    }

    // Edge-defined boundary.
    if (t.code === 93) {
      path.numberOfEdges = num(t);
      continue;
    }
    if (t.code === 72) {
      edge = { type: num(t) };
      path.edges!.push(edge);
      continue;
    }
    if (!edge) continue;

    switch (edge.type) {
      case 1: // Line: 10/20 start, 11/21 end
        if (t.code === 10) edge.start = { x: num(t), y: 0 };
        else if (t.code === 20 && edge.start) edge.start.y = num(t);
        else if (t.code === 11) edge.end = { x: num(t), y: 0 };
        else if (t.code === 21 && edge.end) edge.end.y = num(t);
        break;
      case 2: // Circular arc: 10/20 centre, 40 radius, 50/51 angles (degrees), 73 CCW
        if (t.code === 10) edge.center = { x: num(t), y: 0 };
        else if (t.code === 20 && edge.center) edge.center.y = num(t);
        else if (t.code === 40) edge.radius = num(t);
        else if (t.code === 50) edge.startAngle = num(t) * DEG;
        else if (t.code === 51) edge.endAngle = num(t) * DEG;
        else if (t.code === 73) edge.isCCW = num(t) !== 0;
        break;
      case 3: // Elliptic arc: 11/21 is the major axis vector, 40 the axis ratio
        if (t.code === 10) edge.center = { x: num(t), y: 0 };
        else if (t.code === 20 && edge.center) edge.center.y = num(t);
        else if (t.code === 11) edge.end = { x: num(t), y: 0 };
        else if (t.code === 21 && edge.end) edge.end.y = num(t);
        else if (t.code === 40) edge.lengthOfMinorAxis = num(t);
        else if (t.code === 50) edge.startAngle = num(t) * DEG;
        else if (t.code === 51) edge.endAngle = num(t) * DEG;
        else if (t.code === 73) edge.isCCW = num(t) !== 0;
        break;
      case 4: // Spline
        if (t.code === 94) edge.degree = num(t);
        else if (t.code === 40) (edge.knots ??= []).push(num(t));
        else if (t.code === 10) (edge.controlPoints ??= []).push({ x: num(t), y: 0 });
        else if (t.code === 20 && edge.controlPoints?.length) {
          edge.controlPoints[edge.controlPoints.length - 1].y = num(t);
        } else if (t.code === 42 && edge.controlPoints?.length) {
          edge.controlPoints[edge.controlPoints.length - 1].weight = num(t);
        }
        break;
      default:
        break;
    }
  }

  return paths;
}
