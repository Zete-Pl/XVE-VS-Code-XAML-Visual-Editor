// Model dokumentu XAML z chirurgiczną edycją.
//
// Trzyma ORYGINALNY tekst nietknięty i listę edycji (offset-based). getText() nakłada
// edycje, więc regiony nietknięte pozostają bajt-w-bajt identyczne — to jest istota
// "faithful / surgical save". Drzewo węzłów (XamlNode) ma offsety w oryginale, więc po
// edycji wciąż wskazuje poprawne miejsca (edycje aplikujemy od końca).

import { XamlParser, encodeXmlAttr } from "./XamlParser.ts";
import type { XamlNode } from "./XamlParser.ts";

interface Edit {
  start: number;
  end: number;
  text: string;
}

/** Lekki, serializowalny widok drzewa dla webview (bez referencji cyklicznych). */
export interface TreeNodeDto {
  id: number;
  tag: string;
  attributes: { name: string; value: string }[];
  children: TreeNodeDto[];
}

export class XamlDocument {
  private original: string;
  private edits: Edit[] = [];
  readonly roots: XamlNode[];
  readonly root: XamlNode | null;
  private byId = new Map<number, XamlNode>();

  constructor(text: string) {
    this.original = text;
    const { root, roots } = new XamlParser(text).parse();
    this.root = root;
    this.roots = roots;
    for (const r of roots) this.index(r);
  }

  private index(n: XamlNode) {
    this.byId.set(n.id, n);
    for (const c of n.children) this.index(c);
  }

  getNode(id: number): XamlNode | undefined {
    return this.byId.get(id);
  }

  /** Zwraca aktualny tekst po nałożeniu wszystkich edycji. */
  getText(): string {
    if (this.edits.length === 0) return this.original;
    const sorted = [...this.edits].sort((a, b) => b.start - a.start);
    let out = this.original;
    for (const e of sorted) {
      out = out.slice(0, e.start) + e.text + out.slice(e.end);
    }
    return out;
  }

  isDirty(): boolean {
    return this.edits.length > 0;
  }

  /**
   * Chirurgicznie ustawia wartość atrybutu. Jeśli atrybut istnieje — podmienia tylko
   * jego wartość wewnątrz cudzysłowów. Jeśli nie — wstawia nowy atrybut tuż za nazwą
   * znacznika. Nie rusza pozostałego tekstu.
   */
  setAttribute(nodeId: number, name: string, value: string): boolean {
    const node = this.byId.get(nodeId);
    if (!node || node.kind !== "element") return false;

    const attr = node.attributes.find((a) => a.name === name);
    if (attr) {
      this.replace(attr.valueSpan.start, attr.valueSpan.end, encodeXmlAttr(value, attr.quote));
      attr.value = value;
      return true;
    }

    const at = node.insertAttrAt ?? node.openTagSpan?.start;
    if (at === undefined) return false;
    const insertion = ` ${name}="${encodeXmlAttr(value, '"')}"`;
    this.replace(at, at, insertion);
    // dopisz do modelu (offsety w oryginale; do kolejnych edycji w obrębie tej samej sesji
    // wystarczy, że value/nazwa są poprawne — span pozostaje punktowy)
    node.attributes.push({
      name,
      value,
      quote: '"',
      fullSpan: { start: at, end: at },
      nameSpan: { start: at, end: at },
      valueSpan: { start: at, end: at },
    });
    return true;
  }

  /** Ustawia wiele atrybutów atomowo (jeden zapis) — używane przy move/resize. */
  setAttributes(nodeId: number, attrs: Record<string, string>): boolean {
    let any = false;
    for (const [name, value] of Object.entries(attrs)) {
      if (this.setAttribute(nodeId, name, value)) any = true;
    }
    return any;
  }

  /** Usuwa atrybut wraz z poprzedzającym whitespace. */
  removeAttribute(nodeId: number, name: string): boolean {
    const node = this.byId.get(nodeId);
    if (!node || node.kind !== "element") return false;
    const idx = node.attributes.findIndex((a) => a.name === name);
    if (idx < 0) return false;
    const attr = node.attributes[idx];
    this.replace(attr.fullSpan.start, attr.fullSpan.end, "");
    node.attributes.splice(idx, 1);
    return true;
  }

  // ---------- operacje strukturalne ----------

  /** Zwraca surowy XAML elementu (wycinek oryginału). */
  getElementSource(nodeId: number): string | null {
    const n = this.byId.get(nodeId);
    if (!n || n.kind !== "element") return null;
    return this.original.slice(n.span.start, n.span.end);
  }

  /** Wcięcie (whitespace od początku linii) danego węzła. */
  private indentOf(n: XamlNode): string {
    let i = n.span.start;
    while (i > 0 && (this.original[i - 1] === " " || this.original[i - 1] === "\t")) i--;
    return this.original.slice(i, n.span.start);
  }

  /** Usuwa element wraz z jego wcięciem i poprzedzającym znakiem nowej linii. */
  removeElement(nodeId: number): boolean {
    const n = this.byId.get(nodeId);
    if (!n || n.kind !== "element") return false;
    let s = n.span.start;
    while (s > 0 && (this.original[s - 1] === " " || this.original[s - 1] === "\t")) s--;
    if (s > 0 && this.original[s - 1] === "\n") {
      s--;
      if (s > 0 && this.original[s - 1] === "\r") s--;
    }
    this.replace(s, n.span.end, "");
    return true;
  }

  /**
   * Wstawia surowy XAML jako dziecko `parentId`. Gdy podano `beforeId` — przed tym
   * rodzeństwem, w przeciwnym razie na końcu (przed znacznikiem zamykającym).
   */
  insertChild(parentId: number, xml: string, beforeId: number | null = null): boolean {
    const p = this.byId.get(parentId);
    if (!p || p.kind !== "element" || p.selfClosing || !p.openTagSpan) return false;
    const elementChildren = p.children.filter((c) => c.kind === "element");

    if (beforeId != null) {
      const b = this.byId.get(beforeId);
      if (!b) return false;
      const indent = this.indentOf(b);
      const at = b.span.start - indent.length;
      this.replace(at, at, indent + xml + "\n");
      return true;
    }

    if (elementChildren.length) {
      const last = elementChildren[elementChildren.length - 1];
      const indent = this.indentOf(last);
      this.replace(last.span.end, last.span.end, "\n" + indent + xml);
    } else {
      // brak elementów-dzieci: jeśli ciało jest puste/whitespace, znormalizuj je
      const tag = p.tag ?? "";
      const closeStart = p.span.end - (tag.length + 3); // pozycja "</tag>"
      const inner = this.original.slice(p.openTagSpan.end, closeStart);
      const childIndent = this.indentOf(p) + "\t";
      if (inner.trim() === "" && closeStart >= p.openTagSpan.end) {
        this.replace(p.openTagSpan.end, closeStart, "\n" + childIndent + xml + "\n" + this.indentOf(p));
      } else {
        this.replace(p.openTagSpan.end, p.openTagSpan.end, "\n" + childIndent + xml);
      }
    }
    return true;
  }

  /** Przenosi element pod nowego rodzica (delete + insert). */
  moveElement(nodeId: number, newParentId: number, beforeId: number | null = null): boolean {
    const xml = this.getElementSource(nodeId);
    if (xml == null) return false;
    if (!this.removeElement(nodeId)) return false;
    return this.insertChild(newParentId, xml, beforeId);
  }

  private replace(start: number, end: number, text: string) {
    // usuń wcześniejsze edycje pokrywające dokładnie ten region (ponowna edycja atrybutu)
    this.edits = this.edits.filter((e) => !(e.start === start && e.end === end));
    this.edits.push({ start, end, text });
  }

  /** Drzewo do webview: tylko elementy (text/comment pomijamy w widoku struktury). */
  toTree(): TreeNodeDto | null {
    if (!this.root) return null;
    const map = (n: XamlNode): TreeNodeDto => ({
      id: n.id,
      tag: n.tag ?? "?",
      attributes: n.attributes.map((a) => ({ name: a.name, value: a.value })),
      children: n.children.filter((c) => c.kind === "element").map(map),
    });
    return map(this.root);
  }
}
