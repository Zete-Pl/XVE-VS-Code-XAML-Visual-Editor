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
