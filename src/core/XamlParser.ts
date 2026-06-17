// Lekki, pozycyjny tokenizer XAML/XML.
//
// Cel: zachować ŹRÓDŁO bajt-w-bajt (whitespace, komentarze, kolejność atrybutów,
// styl cudzysłowów) i pozwolić na chirurgiczną edycję pojedynczych atrybutów —
// fundament "surgical save" znanego z aplikacji WPF (XVE).
//
// To nie jest pełny walidator XML — to parser tolerancyjny, który mapuje tekst na
// drzewo węzłów z offsetami w oryginalnym buforze.

export interface SourceSpan {
  /** offset początku (włącznie) w oryginalnym tekście */
  start: number;
  /** offset końca (wyłącznie) w oryginalnym tekście */
  end: number;
}

export interface XamlAttribute {
  /** np. "Width" albo "Canvas.Left" albo "x:Class" */
  name: string;
  /** wartość bez cudzysłowów, z odkodowanymi encjami XML */
  value: string;
  /** użyty znak cudzysłowu: '"' lub '\'' */
  quote: string;
  /** span całego atrybutu razem z poprzedzającym whitespace: ` Width="100"` */
  fullSpan: SourceSpan;
  /** span samej nazwy */
  nameSpan: SourceSpan;
  /** span wartości WEWNĄTRZ cudzysłowów (to edytujemy chirurgicznie) */
  valueSpan: SourceSpan;
}

export type NodeKind = "element" | "text" | "comment" | "cdata" | "pi" | "doctype";

export interface XamlNode {
  kind: NodeKind;
  /** transient id nadawany przy parsowaniu — stabilny w obrębie jednego parse */
  id: number;
  /** dla element: nazwa znacznika (z prefiksem, np. "x:Code") */
  tag?: string;
  attributes: XamlAttribute[];
  children: XamlNode[];
  parent?: XamlNode;
  /** czy znacznik jest samozamykający `<Foo/>` */
  selfClosing: boolean;
  /** span całego węzła (od `<` do `>` zamykającego / końca tekstu) */
  span: SourceSpan;
  /** span otwierającego znacznika `<Foo ...>` — dla element */
  openTagSpan?: SourceSpan;
  /** offset tuż za nazwą znacznika otwierającego (miejsce wstawiania nowych atrybutów) */
  insertAttrAt?: number;
  /** dla text/comment/cdata: surowa zawartość */
  raw?: string;
}

const NAME_CHARS = /[A-Za-z0-9_.:-]/;

export class XamlParser {
  private text: string;
  private pos = 0;
  private idSeq = 0;

  constructor(text: string) {
    this.text = text;
  }

  parse(): { root: XamlNode | null; roots: XamlNode[] } {
    const roots: XamlNode[] = [];
    while (this.pos < this.text.length) {
      const node = this.parseNode(undefined);
      if (!node) break;
      roots.push(node);
    }
    const root = roots.find((n) => n.kind === "element") ?? null;
    return { root, roots };
  }

  private parseNode(parent: XamlNode | undefined): XamlNode | null {
    if (this.pos >= this.text.length) return null;

    if (this.text[this.pos] === "<") {
      const two = this.text.substr(this.pos, 2);
      const four = this.text.substr(this.pos, 4);
      if (this.text.substr(this.pos, 4) === "<!--") return this.parseComment(parent);
      if (this.text.substr(this.pos, 9) === "<![CDATA[") return this.parseCData(parent);
      if (four === "<!DO" || four === "<!do") return this.parseDoctype(parent);
      if (two === "<?") return this.parsePI(parent);
      if (two === "</") return null; // znacznik zamykający — obsługiwany przez rodzica
      return this.parseElement(parent);
    }
    return this.parseText(parent);
  }

  private node(kind: NodeKind, start: number): XamlNode {
    return {
      kind,
      id: this.idSeq++,
      attributes: [],
      children: [],
      selfClosing: false,
      span: { start, end: start },
    };
  }

  private parseText(parent: XamlNode | undefined): XamlNode {
    const start = this.pos;
    while (this.pos < this.text.length && this.text[this.pos] !== "<") this.pos++;
    const n = this.node("text", start);
    n.parent = parent;
    n.span.end = this.pos;
    n.raw = this.text.slice(start, this.pos);
    return n;
  }

  private parseUntil(parent: XamlNode | undefined, kind: NodeKind, close: string): XamlNode {
    const start = this.pos;
    const idx = this.text.indexOf(close, this.pos);
    this.pos = idx < 0 ? this.text.length : idx + close.length;
    const n = this.node(kind, start);
    n.parent = parent;
    n.span.end = this.pos;
    n.raw = this.text.slice(start, this.pos);
    return n;
  }

  private parseComment(p: XamlNode | undefined) {
    return this.parseUntil(p, "comment", "-->");
  }
  private parseCData(p: XamlNode | undefined) {
    return this.parseUntil(p, "cdata", "]]>");
  }
  private parsePI(p: XamlNode | undefined) {
    return this.parseUntil(p, "pi", "?>");
  }
  private parseDoctype(p: XamlNode | undefined) {
    return this.parseUntil(p, "doctype", ">");
  }

  private parseElement(parent: XamlNode | undefined): XamlNode {
    const start = this.pos;
    this.pos++; // skip '<'
    const tagStart = this.pos;
    while (this.pos < this.text.length && NAME_CHARS.test(this.text[this.pos])) this.pos++;
    const tag = this.text.slice(tagStart, this.pos);
    const n = this.node("element", start);
    n.parent = parent;
    n.tag = tag;
    n.insertAttrAt = this.pos;

    // atrybuty
    for (;;) {
      const wsStart = this.pos;
      while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
      const c = this.text[this.pos];
      if (c === undefined || c === ">" || c === "/") {
        this.pos = wsStart; // oddaj whitespace przed '>' do open-tag span
        break;
      }
      const attr = this.parseAttribute(wsStart);
      if (!attr) {
        // nie udało się sparsować atrybutu — przejdź dalej by uniknąć pętli
        this.pos = wsStart + 1;
        continue;
      }
      n.attributes.push(attr);
    }

    // domknięcie znacznika otwierającego
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
    if (this.text.substr(this.pos, 2) === "/>") {
      this.pos += 2;
      n.selfClosing = true;
      n.span.end = this.pos;
      n.openTagSpan = { start, end: this.pos };
      return n;
    }
    if (this.text[this.pos] === ">") this.pos++;
    n.openTagSpan = { start, end: this.pos };

    // dzieci aż do </tag>
    for (;;) {
      if (this.pos >= this.text.length) break;
      if (this.text.substr(this.pos, 2) === "</") {
        const closeStart = this.pos;
        this.pos += 2;
        const closeNameStart = this.pos;
        while (this.pos < this.text.length && NAME_CHARS.test(this.text[this.pos])) this.pos++;
        const closeName = this.text.slice(closeNameStart, this.pos);
        while (this.pos < this.text.length && this.text[this.pos] !== ">") this.pos++;
        if (this.text[this.pos] === ">") this.pos++;
        if (closeName === tag) {
          n.span.end = this.pos;
          return n;
        }
        // niedopasowany znacznik zamykający — potraktuj jako koniec
        this.pos = closeStart;
        break;
      }
      const child = this.parseNode(n);
      if (!child) break;
      n.children.push(child);
    }
    n.span.end = this.pos;
    return n;
  }

  private parseAttribute(fullStart: number): XamlAttribute | null {
    const nameStart = this.pos;
    while (this.pos < this.text.length && NAME_CHARS.test(this.text[this.pos])) this.pos++;
    const nameEnd = this.pos;
    if (nameEnd === nameStart) return null;
    const name = this.text.slice(nameStart, nameEnd);
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
    if (this.text[this.pos] !== "=") {
      // atrybut bez wartości — rzadkie w XAML; zapisz pustą wartość
      return {
        name,
        value: "",
        quote: '"',
        fullSpan: { start: fullStart, end: this.pos },
        nameSpan: { start: nameStart, end: nameEnd },
        valueSpan: { start: this.pos, end: this.pos },
      };
    }
    this.pos++; // '='
    while (this.pos < this.text.length && /\s/.test(this.text[this.pos])) this.pos++;
    const quote = this.text[this.pos];
    if (quote !== '"' && quote !== "'") return null;
    this.pos++;
    const valStart = this.pos;
    while (this.pos < this.text.length && this.text[this.pos] !== quote) this.pos++;
    const valEnd = this.pos;
    if (this.text[this.pos] === quote) this.pos++;
    return {
      name,
      value: decodeXml(this.text.slice(valStart, valEnd)),
      quote,
      fullSpan: { start: fullStart, end: this.pos },
      nameSpan: { start: nameStart, end: nameEnd },
      valueSpan: { start: valStart, end: valEnd },
    };
  }
}

export function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&amp;/g, "&");
}

/** Koduje wartość atrybutu do zapisu w cudzysłowie `quote`. */
export function encodeXmlAttr(s: string, quote: string): string {
  let out = s.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  if (quote === '"') out = out.replace(/"/g, "&quot;");
  else out = out.replace(/'/g, "&apos;");
  return out;
}
