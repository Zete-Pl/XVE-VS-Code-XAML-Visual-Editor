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

/** Jeden segment uporządkowanej treści inline: literał tekstowy lub element inline (np. <LineBreak/>). */
export type InlinePart = { text: string } | { node: TreeNodeDto };

/** Lekki, serializowalny widok drzewa dla webview (bez referencji cyklicznych). */
export interface TreeNodeDto {
  id: number;
  tag: string;
  attributes: { name: string; value: string }[];
  /** bezpośrednia treść tekstowa (np. <ComboBoxItem>800×600</ComboBoxItem>) — pomijana gdy pusta */
  text?: string;
  /** Uporządkowana treść inline — tylko dla mieszanej zawartości (tekst + elementy inline, np.
      `Tekst<LineBreak/>dalej`), gdzie kolejność ma znaczenie i `text`/`children` ją gubią. */
  inlines?: InlinePart[];
  children: TreeNodeDto[];
}

export class XamlDocument {
  private original: string;
  private edits: Edit[] = [];
  /** offset (w oryginale) początku ostatnio wstawionego `xml` — patrz insertChildReturningId */
  private lastInsertAt: number | null = null;
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

  /**
   * Zwraca id najgłębszego elementu, którego span obejmuje dany offset (znak w tekście),
   * albo null. Używane do synchronizacji: kursor w edytorze tekstu → zaznaczenie w XVE.
   */
  nodeIdAtOffset(offset: number): number | null {
    let best: XamlNode | null = null;
    const visit = (n: XamlNode): void => {
      if (n.kind !== "element") return;
      if (offset < n.span.start || offset > n.span.end) return;
      best = n; // głębsze dziecko nadpisze rodzica w trakcie schodzenia
      for (const c of n.children) visit(c);
    };
    for (const r of this.roots) visit(r);
    return best ? (best as XamlNode).id : null;
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
    if (!p || p.kind !== "element" || !p.openTagSpan) return false;
    // self-closing rodzic (<X/>) → rozwiń do <X>…</X> i wstaw jako jedyne dziecko (np. MenuItem-liść → submenu)
    if (p.selfClosing) {
      const tag = p.tag ?? "";
      let i = p.span.end - 2; // znak tuż przed końcowym '>'
      while (i > p.span.start && (this.original[i] === " " || this.original[i] === "\t")) i--;
      if (this.original[i] !== "/") return false;
      const indent = this.indentOf(p);
      const prefix = ">\n" + indent + "\t";
      this.lastInsertAt = i + prefix.length; // offset, od którego zaczyna się wstawiony `xml`
      this.replace(i, p.span.end, prefix + xml + "\n" + indent + "</" + tag + ">");
      return true;
    }
    const elementChildren = p.children.filter((c) => c.kind === "element");

    if (beforeId != null) {
      const b = this.byId.get(beforeId);
      if (!b) return false;
      const indent = this.indentOf(b);
      const at = b.span.start - indent.length;
      this.lastInsertAt = at + indent.length;
      this.replace(at, at, indent + xml + "\n");
      return true;
    }

    if (elementChildren.length) {
      const last = elementChildren[elementChildren.length - 1];
      const indent = this.indentOf(last);
      this.lastInsertAt = last.span.end + 1 + indent.length; // po "\n" + indent
      this.replace(last.span.end, last.span.end, "\n" + indent + xml);
    } else {
      // brak elementów-dzieci: jeśli ciało jest puste/whitespace, znormalizuj je
      const tag = p.tag ?? "";
      const closeStart = p.span.end - (tag.length + 3); // pozycja "</tag>"
      const inner = this.original.slice(p.openTagSpan.end, closeStart);
      const childIndent = this.indentOf(p) + "\t";
      this.lastInsertAt = p.openTagSpan.end + 1 + childIndent.length; // po "\n" + childIndent
      if (inner.trim() === "" && closeStart >= p.openTagSpan.end) {
        this.replace(p.openTagSpan.end, closeStart, "\n" + childIndent + xml + "\n" + this.indentOf(p));
      } else {
        this.replace(p.openTagSpan.end, p.openTagSpan.end, "\n" + childIndent + xml);
      }
    }
    return true;
  }

  /**
   * Jak {@link insertChild}, ale zwraca id wstawionego elementu (po reparse) — by webview mógł
   * go zaznaczyć po wklejeniu. Zakłada brak wcześniejszych edycji w tej instancji (paste = jeden
   * edyt na świeżej kopii dokumentu), więc offset wstawienia w oryginale = offset w wyniku.
   */
  insertChildReturningId(parentId: number, xml: string, beforeId: number | null = null): number | null {
    this.lastInsertAt = null;
    if (!this.insertChild(parentId, xml, beforeId)) return null;
    if (this.lastInsertAt == null) return null;
    return new XamlDocument(this.getText()).nodeIdAtOffset(this.lastInsertAt);
  }

  /** Przenosi element pod nowego rodzica (delete + insert). */
  moveElement(nodeId: number, newParentId: number, beforeId: number | null = null): boolean {
    const xml = this.getElementSource(nodeId);
    if (xml == null) return false;
    if (!this.removeElement(nodeId)) return false;
    return this.insertChild(newParentId, xml, beforeId);
  }

  /**
   * Jak {@link moveElement}, ale zwraca NOWE id przeniesionego elementu (po reparse). Ids są
   * pozycyjne (kolejność dokumentu), więc przeniesienie zmienia numer — dzięki temu webview może
   * odtworzyć zaznaczenie na właściwym elemencie. null = nie udało się przenieść / odnaleźć.
   */
  moveElementReturningId(
    nodeId: number,
    newParentId: number,
    beforeId: number | null = null
  ): number | null {
    const xml = this.getElementSource(nodeId);
    if (xml == null) return null;
    if (!this.removeElement(nodeId)) return null;
    // Marker zamiast indexOf(xml): przy duplikatach (np. dwa identyczne <Button Content="OK"/>)
    // indexOf trafiał w PIERWSZY bliźniak, nie w przeniesiony. Unikalny, tymczasowy atrybut
    // kotwiczy wyszukiwanie na faktycznie wstawionym elemencie. Działamy na kopii jednorazowej
    // (patrz XveEditorProvider: prawdziwa edycja to osobne moveElement bez markera), więc marker
    // nigdy nie trafia do zapisu. Dodanie atrybutu nie zmienia liczby/kolejności elementów →
    // pozycyjne id policzone tutaj = id w prawdziwym dokumencie.
    const mark = "_xveSel" + Math.random().toString(36).slice(2);
    const marked = xml.replace(/^(<[A-Za-z0-9_.:-]+)/, `$1 ${mark}="1"`);
    if (marked === xml) return null; // nie udało się zakotwiczyć markera
    if (!this.insertChild(newParentId, marked, beforeId)) return null;
    const newText = this.getText();
    const at = newText.indexOf(mark); // marker jest unikalny → jednoznaczny offset
    if (at < 0) return null;
    return new XamlDocument(newText).nodeIdAtOffset(at);
  }

  private replace(start: number, end: number, text: string) {
    // usuń wcześniejsze edycje pokrywające dokładnie ten region (ponowna edycja atrybutu)
    this.edits = this.edits.filter((e) => !(e.start === start && e.end === end));
    this.edits.push({ start, end, text });
  }

  /**
   * Produkuje XAML dla hosta WPF: wstrzykuje `x:Uid="u<id>"` w każdy element (mapowanie
   * prostokątów hit-test → id) i usuwa `x:Class` z korzenia. UWAGA: mutuje TEN dokument —
   * wywołuj na instancji jednorazowej (np. `new XamlDocument(text).toHostXaml()`).
   */
  toHostXaml(): string {
    const inject = (n: XamlNode) => {
      if (n.kind === "element") {
        if (!n.attributes.some((a) => a.name === "x:Uid")) this.setAttribute(n.id, "x:Uid", "u" + n.id);
        for (const c of n.children) inject(c);
      }
    };
    if (this.root) {
      // x:Class na korzeniu zamieniamy na x:Uid JEDNYM edytem (replace). Osobny insert(x:Uid)
      // + remove(x:Class) dałby dwie edycje w tym samym miejscu (whitespace po nazwie znacznika);
      // nakładające się edycje psują getText() — korupcja XML (np. `<WindowMainWindow"...`).
      const xClass = this.root.attributes.find((a) => a.name === "x:Class");
      if (xClass) {
        this.replace(xClass.fullSpan.start, xClass.fullSpan.end, ` x:Uid="u${this.root.id}"`);
        xClass.name = "x:Uid"; // model: by inject() nie dodał drugiego x:Uid na korzeniu
        xClass.value = "u" + this.root.id;
      }
      inject(this.root);
    }
    return this.getText();
  }

  /** Drzewo do webview: tylko elementy (text/comment pomijamy w widoku struktury). */
  toTree(): TreeNodeDto | null {
    if (!this.root) return null;
    const map = (n: XamlNode): TreeNodeDto => {
      const text = n.children
        .filter((c) => c.kind === "text")
        .map((c) => c.raw ?? "")
        .join("")
        .trim();
      const dto: TreeNodeDto = {
        id: n.id,
        tag: n.tag ?? "?",
        attributes: n.attributes.map((a) => ({ name: a.name, value: a.value })),
        children: n.children.filter((c) => c.kind === "element").map(map),
      };
      if (text) dto.text = text;
      // Mieszana treść inline (tekst + elementy inline, np. TextBlock z <LineBreak/>): zachowaj
      // KOLEJNOŚĆ w `inlines` — `text` (sklejony) i `children` osobno gubią pozycję tekstu.
      if (text && dto.children.length) {
        dto.inlines = n.children
          .filter((c) => c.kind === "element" || (c.kind === "text" && (c.raw ?? "").trim() !== ""))
          .map((c) =>
            c.kind === "text" ? { text: (c.raw ?? "").replace(/\s+/g, " ") } : { node: map(c) }
          );
      }
      return dto;
    };
    return map(this.root);
  }
}
