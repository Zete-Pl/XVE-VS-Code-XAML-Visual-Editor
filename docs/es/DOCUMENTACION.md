# XAML Visual Editor (XVE) — Documentación

[🇬🇧 English](../en/DOCUMENTATION.md) · [🇵🇱 Polski](../pl/DOKUMENTACJA.md) · **🇪🇸 Español** · [🇩🇪 Deutsch](../de/DOKUMENTATION.md) · [🇫🇷 Français](../fr/DOCUMENTATION.md) · [🇯🇵 日本語](../ja/DOCUMENTATION.md) · [🇨🇳 中文](../zh/DOCUMENTATION.md)

XVE es una extensión de Visual Studio Code que convierte los archivos **XAML** escritos a mano en
una superficie visual viva y editable —un árbol de estructura, una vista previa renderizada y un
panel de propiedades tipadas— manteniendo el archivo de texto como única fuente de verdad. Su
característica distintiva es el **guardado quirúrgico**: una edición cambia solo lo imprescindible,
y el resto del archivo permanece idéntico byte a byte (se conservan el formato, los comentarios y
la sangría).

![Diseño del editor](../images/layout-overview.png)

---

## Tabla de contenidos

1. [Introducción](#1-introducción)
2. [Instalación y ejecución](#2-instalación-y-ejecución)
3. [Primeros pasos](#3-primeros-pasos)
4. [La interfaz](#4-la-interfaz)
5. [Funciones](#5-funciones)
6. [Motores de vista previa](#6-motores-de-vista-previa)
7. [Recursos del proyecto (host WPF)](#7-recursos-del-proyecto-host-wpf)
8. [Gestión de errores](#8-gestión-de-errores)
9. [Referencia de ajustes](#9-referencia-de-ajustes)
10. [Atajos de teclado](#10-atajos-de-teclado)
11. [Arquitectura](#11-arquitectura)
12. [Archivos de ejemplo](#12-archivos-de-ejemplo)
13. [Solución de problemas / FAQ](#13-solución-de-problemas--faq)
14. [Historia del desarrollo](#14-historia-del-desarrollo)

---

## 1. Introducción

XVE está pensado para desarrolladores que escriben WPF/XAML a mano pero que aun así quieren una
vista previa como la de un diseñador y retoques visuales rápidos, sin que una herramienta reescriba
(ni reformatee) su marcado.

Ideas clave:

- **Editor personalizado para `*.xaml`** — registrado como *opción*, de modo que puedes alternar
  entre el editor visual y el editor de texto plano en cualquier momento.
- **Guardado quirúrgico** — cada cambio se aplica como la edición más pequeña posible sobre el texto
  original. El **deshacer/rehacer** nativo de VS Code funciona porque todas las ediciones pasan por
  el `TextDocument`.
- **Dos motores de vista previa** — un **renderizador web** multiplataforma y un **host WPF** de
  alta fidelidad, solo para Windows, que renderiza con el motor WPF real.
- **Interfaz localizada** — 7 idiomas (English, Polski, Español, Deutsch, Français, 日本語, 中文).

---

## 2. Instalación y ejecución

### Requisitos

| Componente | Requisito |
|------------|-----------|
| VS Code | `^1.90.0` |
| Host WPF — *usarlo* (opcional) | Windows x64 o ARM64 + **[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)** |
| Host WPF — *compilarlo* (solo desarrollo) | Windows + **.NET 10 SDK** |
| Node.js (solo desarrollo) | ≥ 20 (las pruebas unitarias usan type-stripping desde Node ≥ 22/24) |

No hay que compilar nada tras instalar desde el Marketplace: la extensión incluye un
`xve-wpf-host.exe` precompilado **tanto para x64 como para ARM64**, y en tiempo de ejecución elige
el que corresponde a tu VS Code.

Lo que sí necesitas es el runtime **Desktop** (`Microsoft.WindowsDesktop.App`) —una descarga
distinta del runtime de .NET normal— **en la misma arquitectura que VS Code**. Un VS Code ARM64
necesita el runtime Desktop ARM64. Si falta, XVE muestra una notificación con un enlace de descarga
y recurre al renderizador web.

La extensión funciona en todas partes donde funciona VS Code. El **host WPF es opcional** y solo
para Windows; en otras plataformas (o cuando el host no está disponible) se usa el renderizador web.

### Ejecutar desde el código fuente (desarrollo)

```bash
npm install
npm run compile        # empaqueta la extensión + webview en dist/
npm run test:unit      # pruebas unitarias del núcleo (Node test runner, type stripping)
npm run test:parity    # paridad de render entre el renderizador web y el host WPF (Playwright)
npm run docs:images    # regenera los diagramas y los iconos de la barra en docs/images/
```

`test:parity` renderiza los archivos de prueba de `samples/parity/` con ambos backends y compara la
geometría resultante; necesita el host WPF compilado (ver abajo), por lo que solo se ejecuta en
Windows.

`docs:images` renderiza cada `docs/images/*.svg` a PNG, exporta los iconos de la barra desde
`@vscode/codicons` y reduce las capturas a 1200 px de ancho in situ. Es idempotente —una imagen que
ya está dentro del límite se deja intacta— así que puedes soltar una captura a resolución completa y
simplemente volver a ejecutarlo.

Después, en VS Code pulsa **`F5`** → *Run Extension*. En la nueva ventana de Extension Development
Host, abre cualquier archivo `.xaml` (o ejecuta **«XVE: Open in XAML Visual Editor»** desde la paleta
de comandos).

### Compilar el host WPF (solo Windows)

```bash
npm run build:host     # dotnet build wpf-host -c Release  (requiere el .NET 10 SDK)
```

Esto produce `xve-wpf-host.exe`, que la extensión lanza bajo demanda para la vista previa de alta
fidelidad.

---

## 3. Primeros pasos

1. **Abre un archivo XAML.** Como el editor visual está registrado con `priority: "option"`, los
   archivos `.xaml` se abren por defecto en el editor de texto normal.
2. **Cambia al editor visual.** Haz clic en **«XVE: Open in XAML Visual Editor»** en la barra de
   título del editor, o ejecuta el comando `xve.openVisualEditor` desde la paleta de comandos.
3. **Vuelve al texto.** Con el editor visual activo, haz clic en **«XVE: Open XAML as Text»**
   (`xve.openTextEditor`) en la barra de título.

Los dos botones de la barra de título son sensibles al contexto: el botón «Visual Editor» aparece
solo cuando un archivo `.xaml` está abierto como texto, y el botón «as Text» solo cuando el editor
visual está activo.

(La captura al principio de este documento muestra un archivo `.xaml` abierto en el editor visual
con los tres paneles visibles.)

---

## 4. La interfaz

El editor visual tiene una disposición de tres paneles (véase el diagrama de arriba):

| Panel | Qué muestra |
|-------|-------------|
| **Árbol de estructura** (izquierda) | La jerarquía de elementos XAML. Clic para seleccionar, arrastrar para reordenar. Redimensionable. |
| **Vista previa** (centro) | La superficie renderizada, con barra de herramientas, reglas/guías, zoom y superposición de selección. |
| **Propiedades** (derecha) | Editores tipados para los atributos del elemento seleccionado, más *Añadir propiedad*. Redimensionable. |

Ambos paneles laterales se pueden contraer y redimensionar; los anchos de los paneles y la posición
de la barra de herramientas se recuerdan por ventana.

### La barra de herramientas de la vista previa

La barra flota sobre la vista previa. Se puede acoplar (arriba/abajo/izquierda/derecha) o dejar
flotante, y recuerda su sitio por ventana. Dos de sus botones cambian de aspecto según el estado,
así que aquí está en sus dos configuraciones habituales.

**Vista Diseño** — el botón Diseño está activo y se expande en una píldora con etiqueta. Los
controles de zoom están visibles y el punto de estado del host es verde (el host WPF está en marcha
y renderiza correctamente):

![Barra de herramientas en la vista Diseño](../images/toolbar-design.png)

**Vista Cambios** — el botón Cambios está activo y muestra el número de cambios pendientes. Los
controles de zoom desaparecen (pertenecen a la superficie de diseño, no al diff), la herramienta
Desplazar está seleccionada y el punto es gris porque esta ventana usa el renderizador web:

![Barra de herramientas en la vista Cambios](../images/toolbar-changes.png)

Estas dos diferencias son independientes entre sí: **el panel de zoom se oculta únicamente porque el
modo de vista es Cambios**, y **el color del punto depende solo del motor de vista previa y del
estado de render del host**, no del modo de vista.

#### Todos los controles, de izquierda a derecha

| Icono | Control | Tipo | Qué hace |
|:-----:|---------|------|----------|
| ![](../images/icons/gripper.png) | **Mover la barra** | asa de arrastre | Arrastra la barra; suéltala cerca de un borde para acoplarla. |
| ![](../images/icons/layout-sidebar-left.png) | **Mostrar Estructura** | botón *(condicional)* | Vuelve a abrir el panel Estructura. Solo aparece mientras ese panel está contraído. |
| ![](../images/icons/pan.png) | **Desplazar (Pan)** | herramienta | Arrastra para desplazar la vista previa. También disponible en cualquier momento con el botón central del ratón. |
| ![](../images/icons/move.png) | **Seleccionar / mover** | herramienta | Selecciona elementos, arrástralos para moverlos, redimensiona con los 8 tiradores. |
| ![](../images/icons/list-tree.png) | **Reordenar** | herramienta | Arrastra elementos en la vista previa para cambiar su orden entre hermanos, como en el árbol. **Es la herramienta por defecto.** |
| ![](../images/icons/eye.png) | **Auto-desplegar** | conmutador | Abre automáticamente la lista/menú del elemento seleccionado (ComboBox, Menu, …). **Activado por defecto.** |
| ![](../images/icons/discard.png) | **Deshacer** | botón | Deshace la última edición (la pila de deshacer nativa de VS Code). |
| ![](../images/icons/redo.png) | **Rehacer** | botón | Rehace. |
| ![](../images/icons/trash.png) | **Eliminar** | botón | Elimina el elemento seleccionado (igual que la tecla <kbd>Supr</kbd>). |
| ![](../images/icons/edit.png) | **Diseño** | conmutador de vista | La superficie de diseño en vivo. Se expande en una píldora con etiqueta cuando está activo. |
| ![](../images/icons/git-compare.png) | **Cambios** | conmutador de vista | El diff contra el archivo guardado. Cuando está activo muestra *Cambios (n)*; cuando está inactivo muestra solo *n* como distintivo, y nada en absoluto si no hay cambios. |
| ![](../images/icons/symbol-numeric.png) | **Cuadrícula** | conmutador | La superposición de cuadrícula de puntos. Activarla habilita también el ajuste a la cuadrícula: no hay un botón de imán aparte. **Desactivada por defecto.** |
| ![](../images/icons/symbol-ruler.png) | **Reglas** | conmutador | Reglas, guías arrastrables y ajuste a las guías. **Activadas por defecto.** |
| ![](../images/icons/symbol-color.png) | **Tema de la vista previa** | menú | Los temas de diccionarios de recursos encontrados en el proyecto y, debajo, el conjunto estándar: Classic, Classic '98, System, Light, Dark, Native. Véase la [sección 6](#6-motores-de-vista-previa). |
| ![](../images/icons/server-process.png) | **Motor de vista previa** | menú | `Auto`, `Web` y —solo en Windows— `WPF host` y `WPF host — isolated`. Véase la [sección 6](#6-motores-de-vista-previa). |
| ![](../images/icons/play.png) | **Ejecutar ventana** | menú | Abre el XAML en una ventana real de Windows: *Snapshot* (una vez) o *Live* (sigue al proyecto). Motor WPF, solo en Windows. |
| ![](../images/icons/package.png) | **Recursos del proyecto** | diálogo | Elige qué DLL de controles personalizados, `App.xaml` y diccionarios de recursos cargar. Véase la [sección 7](#7-recursos-del-proyecto-host-wpf). |
| ![](../images/icons/dot-ok.png) | **Estado del host** | indicador + botón | El estado del host WPF (véase la tabla de abajo). Haz clic para abrir la consola/registro. |
| ![](../images/icons/layout-sidebar-right.png) | **Mostrar Propiedades** | botón *(condicional)* | Vuelve a abrir el panel Propiedades. Solo aparece mientras ese panel está contraído. |
| ![](../images/icons/triangle-right.png) | **Redimensionar la barra** | asa de arrastre *(condicional)* | Arrastra para redimensionar la barra. Solo aparece mientras la barra está flotante (no acoplada). |

Desplazar, Seleccionar y Reordenar son mutuamente excluyentes: siempre hay exactamente una activa.

#### El punto de estado del host

| Punto | Significado |
|:-----:|-------------|
| ![](../images/icons/dot-ok.png) | El host WPF está en marcha y el último render tuvo éxito. |
| ![](../images/icons/dot-idle.png) | El host WPF está arrancando. |
| ![](../images/icons/dot-error.png) | El host WPF informó de un error de render. La consola se abre automáticamente. |
| ![](../images/icons/dot-inactive.png) | Sin host WPF: o no estás en Windows, o el motor de vista previa está en `Web`. No es un error. |

Un **anillo azul** alrededor del punto significa que hay recursos del proyecto cargados. Hacer clic
en el punto siempre abre la consola/registro, sea cual sea su color. Si el host está aislado, su
información emergente lo indica.

#### El panel de zoom

![](../images/icons/zoom-out.png) ![](../images/icons/zoom-in.png)
![](../images/icons/screen-full.png)

El zoom **no forma parte de la barra de herramientas**: es un pequeño panel aparte en la esquina
inferior derecha de la vista previa: *alejar*, el porcentaje actual (clic para volver al 100 %),
*acercar* y *Ajustar*. Está oculto en la vista Cambios. Cuando la barra está acoplada al borde
inferior y hay espacio, el panel de zoom se acopla al extremo derecho de la barra, y por eso en la
captura de la vista Diseño parecen una sola barra.

---

## 5. Funciones

### 5.1 Árbol de estructura y reordenación

El árbol refleja la jerarquía XAML. Haz clic en un nodo para seleccionarlo (el elemento
correspondiente se resalta en la vista previa). **Arrastra un nodo** para reordenarlo: las zonas de
destino indican *antes*, *dentro* o *después* del objetivo, y soltar dentro de tu propio subárbol
está bloqueado. El movimiento se aplica como un `moveElement` quirúrgico, preservando la sangría.

### 5.2 Edición visual — mover y redimensionar

Con la herramienta **Seleccionar**, haz clic en un elemento de la vista previa para seleccionarlo.
Entonces:

- **Mueve** arrastrando. Según el diseño del padre, el movimiento actualiza `Margin` (la mayoría de
  los paneles) o `Canvas.Left/Top` (dentro de un `Canvas`).
- **Redimensiona** con los **8 tiradores** (esquinas + bordes); esto actualiza `Width`/`Height` (y
  `Margin` cuando hace falta).
- Una **vista previa en vivo** sigue tu gesto; al soltar, el cambio se aplica como una única
  escritura quirúrgica (`setAttributes`).

![Un elemento seleccionado con sus 8 tiradores de redimensionado](../images/screen-drag-resize.png)

### 5.3 Añadir / eliminar / copiar elementos

- **Añade** un elemento desde la barra: elige entre 15 tipos comunes (Grid, StackPanel, Canvas,
  Border, TextBlock, Label, Button, TextBox, CheckBox, RadioButton, Slider, ProgressBar, Image,
  Ellipse, Rectangle). Se inserta un fragmento por defecto en el contenedor seleccionado.
- **Elimina** el elemento seleccionado con la tecla **Supr**.
- **Copia / corta / pega** un subárbol con **Ctrl+C / Ctrl+X / Ctrl+V** (pegar como hermano o como
  hijo). El portapapeles es el **portapapeles del sistema** —el elemento se copia como fragmento
  XAML—, así que funciona **entre ventanas de XVE** y en ambos sentidos con un **editor de texto**.
  La deduplicación opcional de `x:Name` al pegar (ajuste `xve.paste.nameDeduplication`, desactivada
  por defecto) renombra los nombres en conflicto a otros únicos sin tocar el original.

### 5.4 Panel de propiedades

<img src="../images/screen-properties.png" align="right" width="280"
     alt="El panel de propiedades con un selector de color abierto y un atributo modificado">

El panel muestra **editores tipados** según la clase de cada propiedad:

| Clase | Editor |
|-------|--------|
| `bool` | casilla de verificación |
| `enum` | lista desplegable |
| `number` | campo numérico |
| `brush` | selector de color |
| `thickness` | cuatro campos L,T,R,B |
| `string` | campo de texto |

Cubre propiedades comunes (Name, Width/Height, tamaños Min/Max, Margin, Padding, alineación,
Background/Foreground, BorderBrush/Thickness, fuentes, Opacity, Visibility, IsEnabled…), propiedades
adjuntas (`Grid.Row/Column`, `Canvas.Left/Top`, `DockPanel.Dock`) y otras específicas del tipo (Text,
Content, IsChecked, Value/Minimum/Maximum, etc.).

Usa **«+ Añadir propiedad»** para agregar cualquier propiedad conocida, y los controles por atributo
para eliminar una. Los atributos **modificados desde el último guardado** se resaltan con una barra
de color y reciben un botón de **revertir** por atributo: en la captura, `BorderBrush` se ha editado
con el selector de color, mientras que `VerticalAlignment` sigue intacto.

<br clear="right">

### 5.5 Vista de cambios (diff)

Cambia la barra de **Diseño** a **Cambios** para ver todo lo que difiere del **archivo guardado**:
atributos modificados, elementos añadidos, elementos eliminados y elementos movidos (detectados con
una coincidencia de árbol LCS, de modo que una reordenación no se reporta como añadir+eliminar). Cada
entrada tiene un botón de **revertir por bloque**, y existe una acción **Revertir todo**. Al hacer
clic en una entrada se selecciona el elemento en la vista previa. Las reversiones usan las mismas
operaciones quirúrgicas que la edición.

![La vista Cambios con entradas modificadas, añadidas y eliminadas](../images/screen-changes.png)

### 5.6 Zoom y navegación

El zoom va de **10 a 800 %**. Usa el panel de zoom en la esquina inferior derecha de la vista previa,
**Ctrl+rueda** (anclado en el cursor) o **Ajustar** para encajar la vista previa en la ventana. Por
defecto (`xve.preview.fitOnOpen`) el documento se ajusta al abrirlo: se reduce si es mayor que la
vista, y si no se muestra al 100 % (nunca se amplía). **Desplaza** con la herramienta Desplazar o con
el botón central del ratón. Las reglas, las guías y el ajuste respetan el zoom actual.

### 5.7 Reglas, guías y ajuste a la cuadrícula

Activa las **reglas** (arriba/izquierda) y la superposición de **cuadrícula** de puntos desde la
barra. Añade una **guía** haciendo clic en una regla; arrástrala para moverla, doble clic para
eliminarla. Durante el movimiento/redimensionado, los elementos se **ajustan** a la cuadrícula y a las
guías. El paso de la cuadrícula y el umbral de ajuste se establecen con `xve.canvas.gridStep`
(8 px por defecto).

### 5.8 Sincronización de la selección con el editor de texto

Cuando hay un editor de texto abierto al lado, la selección es **bidireccional**:

- **Visual → texto** (`xve.sync.selectInTextEditor`): seleccionar un elemento mueve el cursor de texto
  a su etiqueta de apertura. Abajo, elegir el segundo `CheckBox` en el árbol de estructura lleva al
  editor a la línea 10.

  ![Seleccionar un elemento en el árbol mueve el cursor de texto](../images/screen-sync1.png)

- **Texto → visual** (`xve.sync.selectFromTextCursor`): mover el cursor en el código selecciona el
  elemento correspondiente en la vista previa. Abajo, el cursor está en la línea 9 y el primer
  `CheckBox` aparece seleccionado en la vista previa, con sus tiradores.

  ![Mover el cursor de texto selecciona el elemento correspondiente](../images/screen-sync2.png)

Ambas direcciones están activadas por defecto y se pueden alternar de forma independiente. El editor
de texto puede dividirse debajo del editor visual o colocarse al lado: ambas disposiciones funcionan.

### 5.9 Idioma de la interfaz

La interfaz está localizada en **7 idiomas**. Establece `xve.language` (vacío = seguir a VS Code).
Tras cambiarlo, recarga el webview con **Ctrl+R** para aplicarlo.

---

## 6. Motores de vista previa

![Motores de vista previa](../images/preview-backends.png)

XVE tiene dos motores de renderizado, seleccionables con **`xve.previewBackend`**:

- **`auto`** (por defecto) — host WPF en Windows, renderizador web en todo lo demás.
- **`web`** — el renderizador web multiplataforma (subconjunto de XAML → HTML/CSS).
- **`wpf-host`** — el host WPF de Windows (motor WPF real, alta fidelidad).

También puedes forzar el motor por ventana desde el selector de motor de la barra, que ofrece una
cuarta entrada, *WPF host — isolated* (véase [Aislamiento](#aislamiento-xvepreviewisolation) más
abajo). Si el host WPF falla o agota el tiempo de espera, XVE recurre automáticamente al renderizador
web; si no puede arrancar en absoluto —lo más frecuente es que falte el **.NET 10 Desktop Runtime**—
recibes una notificación con un enlace de descarga.

### Estilos y recursos en el renderizador web

El renderizador web es algo más que una traducción de etiqueta a `<div>`. Antes de renderizar, XVE
extrae el subconjunto de recursos del documento que se puede mapear a CSS y lo aplica:

- **Pinceles** — recursos `SolidColorBrush` e `ImageBrush` referenciados por clave.
- **Estilos** — un `Style` con `Setter` simples (propiedades que el renderizador entiende), incluidas
  las **cadenas `BasedOn`**, que se aplanan.
- **Estilos implícitos** — un `Style` sin clave con `TargetType` se aplica a todos los elementos de
  ese tipo, exactamente como en WPF.
- **Resolución de recursos** — `{StaticResource clave}` y `{DynamicResource clave}` se resuelven
  contra los diccionarios de recursos del documento.

La precedencia sigue a WPF: estilo implícito → estilo con nombre (con su cadena `BasedOn`) → atributo
en línea, ganando siempre el atributo en línea. Todo lo que quede fuera de este subconjunto
(triggers, plantillas, convertidores, enlaces a datos) lo ignora el renderizador web; usa el host WPF
cuando lo necesites fielmente.

### Temas de la vista previa

El selector de temas (![](../images/icons/symbol-color.png)) ofrece el conjunto estándar —**Classic**
(WPF puro), **Classic '98** y las variantes Fluent **Light** / **Dark** / **System**, que el host WPF
aplica mediante `ThemeMode`. Los **temas de diccionarios de recursos encontrados en tu proyecto** se
listan por encima y se aplican igual. `Native` es una apariencia GTK/Linux y solo afecta al
renderizador web (el host WPF vuelve a Classic).

![El mismo formulario en varios temas, incluidos diccionarios del proyecto](../images/screen-themes.png)

### Opciones del host WPF

| Ajuste | Propósito |
|--------|-----------|
| `xve.preview.theme` | Tema de la vista previa: `none` (Classic), `classic98`, `system`/`light`/`dark` (Fluent), `native` (apariencia GTK, solo web). |
| `xve.preview.renderScale` | Supermuestreo: `auto` = device pixel ratio (nítido en HiDPI), o `1`/`1.5`/`2`/`3`. |
| `xve.preview.maxResolution` | Límite del tamaño de bitmap (lado mayor, píxeles de dispositivo). `0` = sin límite. |
| `xve.preview.viewportRender` | Renderizar solo la región visible: más rápido en diseños grandes. |
| `xve.preview.capBasis` | Render del área visible: medir `maxResolution` solo contra el área visible (`visible`, nitidez estable con cualquier tamaño de ventana) o contra el trozo completo con overscan (`slice`, comportamiento antiguo). |
| `xve.preview.overscan` | Render del área visible: margen extra (unidades del proyecto) renderizado alrededor de la región visible como colchón de desplazamiento. |
| `xve.preview.debugConsole` | Muestra una consola de depuración al pie de la vista previa con telemetría de render en vivo. |
| `xve.preview.consoleOnStart` | Acopla la consola mientras el host arranca. Si está desactivado, aun así se abre sola ante un error de render. |
| `xve.preview.isolation` | Si un archivo obtiene su propio proceso host y sus propios recursos (véase abajo). |

### Resolución adaptativa

Renderizar una superficie grande a resolución HiDPI completa en cada fotograma de un arrastre es
caro. Con **`xve.preview.adaptiveRes`** (**activado por defecto**) el host renderiza a una resolución
reducida (`xve.preview.motionResolution`, 512 px de lado mayor por defecto) *mientras arrastras,
desplazas o haces zoom*, y vuelve a renderizar una vez a `maxResolution` completo en cuanto el
movimiento se detiene. El movimiento rápido se mantiene fluido y la imagen en reposo, nítida.

La degradación no es incondicional: solo entra en juego cuando el render a resolución completa baja
de **`xve.preview.adaptiveFpsThreshold`** fotogramas por segundo (30 por defecto). En una máquina
rápida con un diseño pequeño, por tanto, nunca abandonas la resolución completa. Pon el umbral a `0`
para usar siempre la resolución de movimiento al moverte.

### Estrategia de vista previa en vivo al arrastrar/redimensionar

Al arrastrar/redimensionar en modo host WPF, el re-render en vivo se rige por:

- `xve.preview.dragStrategy` — `overlay` (sin re-render en vivo), `frames` (cada N fotogramas) o `ms`
  (cada N milisegundos, el valor por defecto).
- `xve.preview.dragIntervalMs` (25 por defecto), `xve.preview.dragFrames` (2 por defecto).
- `xve.preview.dragCoalesce` — mantener como mucho un render en vuelo (descartar fotogramas obsoletos).
- `xve.preview.dragSession` — parsear una vez y mutar un árbol en caché en lugar de reparsear.
- `xve.preview.dragOnChange` — renderizar un nuevo fotograma solo cuando los atributos del elemento
  arrastrado cambian de verdad, de modo que mantener el puntero quieto no cuesta nada.
- `xve.preview.debugLiveDrag` — refrescar también la telemetría de la consola en cada fotograma de
  arrastre.

### Aislamiento (`xve.preview.isolation`)

El host WPF puede cargar recursos del proyecto, que afectan a cómo se renderizan los tipos
personalizados. El aislamiento controla si un archivo comparte host o recibe el suyo propio:

- `ask` — para un archivo de otro proyecto (o sin proyecto), preguntar si se aísla.
- `auto` (por defecto) — aislar esos archivos automáticamente; compartir un host dentro del proyecto
  abierto.
- `shared` — no aislar nunca (un host para todo).
- `isolated` — aislar siempre (un host separado por archivo).

---

## 7. Recursos del proyecto (host WPF)

Para una vista previa fiel de **controles personalizados** y temas del proyecto, el host WPF puede
cargar los recursos de tu proyecto. XVE busca hacia arriba desde el archivo XAML un `.csproj`, luego
localiza la mejor salida `bin/<Config>/<tfm>`, más `App.xaml` y los diccionarios de recursos.

- La elección se ofrece en un **QuickPick** y se recuerda por proyecto; la política se establece con
  **`xve.project.autoLoadResources`** (`ask` / `always` / `never`).
- El host carga las **DLL** de controles personalizados (vía `AssemblyResolve` para los tipos
  `clr-namespace`) y fusiona `App.xaml` / los diccionarios en `Application.Resources`.
- Usa el botón **Recursos del proyecto** (![](../images/icons/package.png)) en la barra de la vista
  previa para volver a elegir los recursos en cualquier momento.

![Un control personalizado renderizado por el host WPF, con el selector de recursos](../images/screen-wpf-host.png)

---

## 8. Gestión de errores

Cuando el XAML no se parsea o no se renderiza, XVE te ayuda a localizarlo y corregirlo:

- **Resaltar cambios en el código** (`xve.editor.highlightChanges`) — las líneas modificadas se
  colorean en el editor de texto contiguo (refleja el conmutador del panel Cambios).
- **Resaltar errores en el código** (`xve.editor.highlightErrors`) — la línea del error se colorea y
  se subraya el token problemático. Al hacer clic en el error se muestra en el editor de texto.
- **Sugerencias de corrección automática** — para un tipo o propiedad desconocidos, XVE sugiere el
  nombre conocido más cercano (p. ej. `Buton` → `Button`) usando distancia de edición.
- **La consola** — haz clic en el punto de estado del host para abrirla. Ante un error de render se
  abre sola, diga lo que diga `xve.preview.consoleOnStart`.

![La consola del host mostrando un error de render](../images/screen-host-console.png)

### Cuando el host WPF no puede arrancar

Si falta el binario del host, o no está instalado el **.NET 10 Desktop Runtime**, o el proceso muere
al arrancar, XVE muestra una notificación explicando cuál de los tres casos ocurrió, y recurre en
silencio al renderizador web. La notificación ofrece descargar el runtime, o cambiar
`xve.previewBackend` a `web` para que deje de intentarse el host. Cada tipo de fallo se informa una
vez por sesión.

---

## 9. Referencia de ajustes

Todos los ajustes viven bajo **`xve.*`**. La mayoría tiene ámbito de ventana, así que distintas
ventanas de VS Code pueden diferir. Los valores por defecto de abajo coinciden con `package.json`.

| Ajuste | Tipo | Por defecto | Descripción |
|--------|------|-------------|-------------|
| `xve.language` | enum | `""` | Idioma de la interfaz (`""`=seguir a VS Code, `en`,`pl`,`es`,`de`,`fr`,`ja`,`zh`). Recarga con Ctrl+R. |
| `xve.project.autoLoadResources` | enum | `ask` | Cómo cargar los recursos del proyecto para el host WPF: `ask` / `always` / `never`. |
| `xve.sync.selectInTextEditor` | bool | `true` | Seleccionar un elemento mueve el cursor de texto hasta él. |
| `xve.sync.selectFromTextCursor` | bool | `true` | Mover el cursor de texto selecciona el elemento correspondiente. |
| `xve.editor.highlightChanges` | bool | `true` | Colorear las líneas modificadas en el editor de texto. |
| `xve.editor.highlightErrors` | bool | `true` | Colorear/subrayar la línea del error en el editor de texto. |
| `xve.paste.nameDeduplication` | enum | `off` | Colisiones de `x:Name` al pegar: `off` (pegar tal cual) / `rename` / `renameAndReferences` (corrige además `ElementName`, `x:Reference` dentro del subárbol pegado). |
| `xve.previewBackend` | enum | `auto` | Motor de vista previa: `auto` / `web` / `wpf-host`. |
| `xve.preview.isolation` | enum | `auto` | Aislamiento del host WPF: `ask` / `auto` / `shared` / `isolated`. |
| `xve.preview.renderScale` | enum | `auto` | Supermuestreo: `auto` / `1` / `1.5` / `2` / `3`. |
| `xve.preview.maxResolution` | number | `1536` | Tamaño máximo del bitmap (lado mayor, px de dispositivo). `0`=sin límite. |
| `xve.preview.theme` | enum | `none` | Tema de la vista previa: `none` / `classic98` / `system` / `light` / `dark` / `native`. |
| `xve.preview.viewportRender` | bool | `true` | Renderizar solo la región visible. |
| `xve.preview.capBasis` | enum | `visible` | Render del área visible: base del límite — `visible` / `slice`. |
| `xve.preview.overscan` | number | `100` | Render del área visible: margen (unidades del proyecto) alrededor de la región visible. |
| `xve.preview.debugConsole` | bool | `false` | Consola de depuración con telemetría de render al pie de la vista previa. |
| `xve.preview.consoleOnStart` | bool | `true` | Acoplar la consola mientras el host arranca. Desactivado = oculta al arrancar, pero se muestra ante un error de render. |
| `xve.preview.debugLiveDrag` | bool | `false` | Refrescar también la telemetría de la consola en cada fotograma de arrastre. |
| `xve.preview.dragStrategy` | enum | `ms` | Estrategia de arrastre en vivo: `overlay` / `frames` / `ms`. |
| `xve.preview.dragIntervalMs` | number | `25` | Para `ms`: intervalo mínimo entre re-renders en vivo (ms). |
| `xve.preview.dragFrames` | number | `2` | Para `frames`: re-renderizar cada N fotogramas. |
| `xve.preview.dragCoalesce` | bool | `true` | Mantener como mucho un render en vuelo durante arrastre/desplazamiento. |
| `xve.preview.dragSession` | bool | `true` | Sesión de arrastre persistente (parsear una vez, mutar el árbol en caché). |
| `xve.preview.dragOnChange` | bool | `true` | Durante un arrastre, renderizar solo cuando los atributos del elemento cambian de verdad. |
| `xve.preview.adaptiveRes` | bool | `true` | Resolución adaptativa: renderizar a `motionResolution` al moverse, luego una vez a `maxResolution` completo. |
| `xve.preview.motionResolution` | number | `512` | Resolución (lado mayor, px de dispositivo) usada al moverse cuando la resolución adaptativa está activa. |
| `xve.preview.adaptiveFpsThreshold` | number | `30` | Bajar a `motionResolution` solo cuando el render a resolución completa cae por debajo de estos FPS. `0` = siempre. |
| `xve.preview.fitOnOpen` | bool | `true` | Ajustar la vista previa a la ventana al abrir (nunca ampliar). |
| `xve.canvas.gridStep` | number | `8` | Paso de la cuadrícula y umbral de ajuste, en píxeles. |
| `xve.canvas.showGrid` | bool | `false` | Valor inicial para mostrar la cuadrícula de puntos. |
| `xve.canvas.showRulers` | bool | `true` | Valor inicial para mostrar reglas/guías. |

### Comandos

| Comando | Título | Cuándo |
|---------|--------|--------|
| `xve.openVisualEditor` | XVE: Open in XAML Visual Editor | `.xaml` abierto como texto |
| `xve.openTextEditor` | XVE: Open XAML as Text | `.xaml` abierto en el editor visual |

---

## 10. Atajos de teclado

| Atajo | Acción |
|-------|--------|
| **Ctrl+Z / Ctrl+Y** | Deshacer / rehacer (nativo de VS Code, vía el TextDocument) |
| **Supr** | Eliminar el elemento seleccionado |
| **Ctrl+C / Ctrl+X / Ctrl+V** | Copiar / cortar / pegar el subárbol seleccionado (portapapeles del sistema, XAML) |
| **Ctrl+rueda** | Acercar/alejar, anclado en el cursor |
| **Botón central / herramienta Desplazar** | Desplazar el lienzo |
| **Ctrl+R** | Recargar el webview (p. ej. para aplicar un cambio de idioma) |

XVE no registra atajos propios; se apoya en los comandos de editor integrados de VS Code.

---

## 11. Arquitectura

![Arquitectura](../images/architecture.png)

La extensión corre en dos contextos que cooperan, más un host nativo opcional:

- **Extension host (Node/TS)** — `extension.ts` activa la extensión y registra los comandos;
  `XveEditorProvider` es el `CustomTextEditorProvider`. Los módulos de `core/` hacen el trabajo real:
  `XamlDocument` (guardado quirúrgico), `XamlParser` (tokenizador posicional), `StructuralDiff` /
  `LineDiff`, `TypeRegistry` (tipos y metadatos de propiedades), `ResourceModel` (pinceles, estilos,
  `BasedOn`), `ProjectScanner` (`.csproj` → DLL y diccionarios), `PasteNames` (deduplicación de
  `x:Name`) y `Localization`. `host/WpfHost` gestiona el proceso del host WPF e informa de los fallos
  fatales de arranque.
- **Webview (HTML/CSS/TS)** — `main.ts` mueve el árbol, las propiedades, la barra y la interfaz;
  `renderer.ts` es el renderizador web XAML→DOM; `styleResolver.ts` aplica como CSS los estilos y
  recursos XAML extraídos; `style.css` es la disposición de tres paneles. Habla con el extension host
  mediante `postMessage`.
- **Host WPF (Windows)** — `xve-wpf-host.exe` (.NET 10) renderiza XAML con el motor WPF real a un PNG
  más un mapa de hit-test (mediante `x:Uid` inyectados), sobre un protocolo JSON-lines por stdio.
  Puede ejecutarse compartido en todo el proyecto o aislado por archivo.

### Flujo de edición

![Flujo de edición](../images/edit-flow.png)

Cada edición —un cambio de propiedad, un arrastre/redimensionado, una reordenación— se convierte en
el conjunto más pequeño de ediciones de texto por parte de `XamlDocument`, se aplica vía un
`WorkspaceEdit`, y luego el documento se reparsea y la vista previa se vuelve a renderizar. Como el
`TextDocument` es siempre la fuente de verdad, deshacer/rehacer es nativo y las regiones intactas
nunca cambian.

---

## 12. Archivos de ejemplo

La carpeta `samples/` contiene archivos XAML que puedes abrir para explorar el editor:

| Archivo | Demuestra |
|---------|-----------|
| [`samples/SampleGrid.xaml`](../../samples/SampleGrid.xaml) | Un formulario con `Grid`, `RowDefinitions`/`ColumnDefinitions`, spans y alineación. |
| [`samples/SampleControls.xaml`](../../samples/SampleControls.xaml) | `Menu`, `ComboBox` y un `ScrollViewer` — buenos para probar el auto-desplegado de listas y el desplazamiento por áreas. |
| `samples/Sample.xaml`, `Sample2.xaml` | Ejemplos básicos de `Window` + `StackPanel`. |

En `SampleControls.xaml`, selecciona un `MenuItem` o un `ComboBox` con el auto-desplegado activado
para expandir su submenú/lista; pon el ratón sobre el `ScrollViewer` y usa la rueda para desplazar
solo esa zona.

---

## 13. Solución de problemas / FAQ

**El archivo `.xaml` se abre como texto plano, no en el editor visual.**
Es intencionado: el editor visual es una *opción*. Usa el botón de la barra de título o
`xve.openVisualEditor` para cambiar.

**La vista previa se ve aproximada / los controles personalizados salen como marcadores de posición.**
Probablemente estés en el renderizador web. En Windows, pon `xve.previewBackend` en `auto` o
`wpf-host`, y luego carga los [recursos del proyecto](#7-recursos-del-proyecto-host-wpf) con el botón
**Recursos del proyecto**.

**El punto de estado del host sigue gris y la vista previa nunca usa WPF.**
Gris significa que el host no está activo: o no estás en Windows, o `xve.previewBackend` es `web`. Si
lo cambiaste a `wpf-host` y sigue gris, busca la notificación de error: la causa más habitual es que
falte el [.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0). Recuerda que el
runtime *Desktop* es una descarga distinta del runtime de .NET normal.

**Los tipos personalizados siguen sin renderizarse en el host WPF.**
Asegúrate de que el proyecto está compilado (para que las DLL existan bajo `bin/...`) y de que
seleccionaste los recursos correctos. Haz clic en el punto de estado del host para leer el registro.

**La interfaz está en el idioma equivocado.**
Establece `xve.language` y recarga el webview con **Ctrl+R**.

**Los diseños grandes van lentos al arrastrar.**
Mantén activados `xve.preview.viewportRender` y `xve.preview.adaptiveRes`: juntos renderizan solo la
región visible, y a resolución reducida mientras te mueves. Si aun así pesa, baja
`xve.preview.motionResolution` (p. ej. a 384), o sube `xve.preview.adaptiveFpsThreshold` para que el
modo de baja resolución entre antes. Ponerlo a `0` usa siempre la resolución de movimiento al
moverse. Deja `dragStrategy` en `ms`.

---

## 14. Historia del desarrollo

XVE se construyó por etapas. Una historia condensada:

- **Etapa 8** — fidelidad de layout y propiedades: coerción de tamaños al estilo WPF en el
  renderizador web, un conjunto completo de propiedades comunes, un `Grid` fiel
  (`RowDefinitions`/`ColumnDefinitions`, spans, alineación de celda), **reordenación** en el árbol y
  **recursos del proyecto** para el host WPF.
- **Etapa 7** — render a la resolución de pantalla (`renderScale`, por defecto `auto`=device pixel
  ratio), VS Code como fuente de verdad para `xve.preview.*`, y trabajo de rendimiento del host
  (debounce + coalescing, `ThemeMode` en caché, `RenderTargetBitmap` reutilizado, precalentamiento del
  host).
- **Etapa 6** — **zoom** (10–800 %, Ctrl+rueda, Ajustar), el **host WPF** (`wpf-host/`, .NET 10,
  JSON-lines), render por viewport, el límite de resolución y el panel de ajustes.
- **Etapa 4** — `LineDiff` + `StructuralDiff` y la vista **Cambios** con revertir por bloque y
  Revertir todo.
- **Etapa 3** — edición visual (arrastrar/redimensionar), operaciones estructurales en `XamlDocument`,
  la barra de añadir/eliminar, y reglas/guías/ajuste con un viewport estable.
- **Antes** — el editor de texto personalizado para `*.xaml`, `XamlDocument` + `XamlParser`
  posicional, el renderizador web, la selección bidireccional, el panel de propiedades tipadas, la
  localización (7 idiomas) y las pruebas de round-trip / guardado quirúrgico.
