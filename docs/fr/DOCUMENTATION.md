# XAML Visual Editor (XVE) — Documentation

[🇬🇧 English](../en/DOCUMENTATION.md) · [🇵🇱 Polski](../pl/DOKUMENTACJA.md) · [🇪🇸 Español](../es/DOCUMENTACION.md) · [🇩🇪 Deutsch](../de/DOKUMENTATION.md) · **🇫🇷 Français** · [🇯🇵 日本語](../ja/DOCUMENTATION.md) · [🇨🇳 中文](../zh/DOCUMENTATION.md)

XVE est une extension Visual Studio Code qui transforme les fichiers **XAML** écrits à la main en une
surface visuelle vivante et modifiable — un arbre de structure, un aperçu rendu et un panneau de
propriétés typées — tout en gardant le fichier texte comme unique source de vérité. Sa
caractéristique déterminante est l'**enregistrement chirurgical** : une modification ne change que ce
qu'elle doit, et le reste du fichier demeure identique octet pour octet (la mise en forme, les
commentaires et l'indentation sont préservés).

![Disposition de l'éditeur](../images/layout-overview.png)

---

## Table des matières

1. [Introduction](#1-introduction)
2. [Installation et exécution](#2-installation-et-exécution)
3. [Premiers pas](#3-premiers-pas)
4. [L'interface](#4-linterface)
5. [Fonctionnalités](#5-fonctionnalités)
6. [Moteurs d'aperçu](#6-moteurs-daperçu)
7. [Ressources du projet (hôte WPF)](#7-ressources-du-projet-hôte-wpf)
8. [Gestion des erreurs](#8-gestion-des-erreurs)
9. [Référence des paramètres](#9-référence-des-paramètres)
10. [Raccourcis clavier](#10-raccourcis-clavier)
11. [Architecture](#11-architecture)
12. [Fichiers d'exemple](#12-fichiers-dexemple)
13. [Dépannage / FAQ](#13-dépannage--faq)
14. [Historique du développement](#14-historique-du-développement)

---

## 1. Introduction

XVE s'adresse aux développeurs qui écrivent WPF/XAML à la main mais veulent tout de même un aperçu
digne d'un concepteur et des retouches visuelles rapides — sans qu'un outil réécrive (et reformate)
leur balisage.

Idées clés :

- **Éditeur personnalisé pour `*.xaml`** — enregistré comme *option*, ce qui permet de basculer à tout
  moment entre l'éditeur visuel et l'éditeur de texte brut.
- **Enregistrement chirurgical** — chaque changement est appliqué comme la plus petite modification
  possible du texte d'origine. L'**annuler/rétablir** natif de VS Code fonctionne parce que toutes les
  modifications passent par le `TextDocument`.
- **Deux moteurs d'aperçu** — un **moteur de rendu web** multiplateforme et un **hôte WPF** de haute
  fidélité, réservé à Windows, qui rend avec le vrai moteur WPF.
- **Interface localisée** — 7 langues (English, Polski, Español, Deutsch, Français, 日本語, 中文).

---

## 2. Installation et exécution

### Prérequis

| Composant | Prérequis |
|-----------|-----------|
| VS Code | `^1.90.0` |
| Hôte WPF — *l'utiliser* (facultatif) | Windows x64 ou ARM64 + **[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0)** |
| Hôte WPF — *le compiler* (développement seulement) | Windows + **.NET 10 SDK** |
| Node.js (développement seulement) | ≥ 20 (les tests unitaires utilisent le type-stripping depuis Node ≥ 22/24) |

Rien à compiler après l'installation depuis la Marketplace : l'extension embarque un
`xve-wpf-host.exe` précompilé **pour x64 comme pour ARM64**, et choisit à l'exécution celui qui
correspond à votre VS Code.

Ce dont vous avez besoin, c'est du runtime **Desktop** (`Microsoft.WindowsDesktop.App`) — un
téléchargement distinct du runtime .NET ordinaire — **dans la même architecture que VS Code**. Un
VS Code ARM64 exige le runtime Desktop ARM64. S'il manque, XVE affiche une notification avec un lien
de téléchargement et bascule sur le moteur de rendu web.

L'extension fonctionne partout où VS Code fonctionne. L'**hôte WPF est facultatif** et réservé à
Windows ; sur les autres plateformes (ou quand l'hôte est indisponible), le moteur de rendu web est
utilisé.

### Exécuter depuis les sources (développement)

```bash
npm install
npm run compile        # empaquette l'extension + le webview dans dist/
npm run test:unit      # tests unitaires du noyau (Node test runner, type stripping)
npm run test:parity    # parité de rendu entre le moteur web et l'hôte WPF (Playwright)
npm run docs:images    # régénère les diagrammes et les icônes de barre dans docs/images/
```

`test:parity` rend les fixtures de `samples/parity/` avec les deux backends et compare la géométrie
obtenue ; il exige l'hôte WPF compilé (voir plus bas) et ne s'exécute donc que sous Windows.

`docs:images` rend chaque `docs/images/*.svg` en PNG, exporte les icônes de barre depuis
`@vscode/codicons` et réduit les captures à 1200 px de large sur place. Le script est idempotent — une
image déjà dans la limite est laissée intacte — vous pouvez donc déposer une capture en pleine
résolution et simplement le relancer.

Ensuite, dans VS Code, appuyez sur **`F5`** → *Run Extension*. Dans la nouvelle fenêtre Extension
Development Host, ouvrez n'importe quel fichier `.xaml` (ou lancez **« XVE: Open in XAML Visual
Editor »** depuis la palette de commandes).

### Compiler l'hôte WPF (Windows uniquement)

```bash
npm run build:host     # dotnet build wpf-host -c Release  (nécessite le .NET 10 SDK)
```

Cela produit `xve-wpf-host.exe`, que l'extension lance à la demande pour l'aperçu haute fidélité.

---

## 3. Premiers pas

1. **Ouvrez un fichier XAML.** Comme l'éditeur visuel est enregistré avec `priority: "option"`, les
   fichiers `.xaml` s'ouvrent par défaut dans l'éditeur de texte normal.
2. **Passez à l'éditeur visuel.** Cliquez sur **« XVE: Open in XAML Visual Editor »** dans la barre de
   titre de l'éditeur, ou lancez la commande `xve.openVisualEditor` depuis la palette de commandes.
3. **Revenez au texte.** L'éditeur visuel étant actif, cliquez sur **« XVE: Open XAML as Text »**
   (`xve.openTextEditor`) dans la barre de titre.

Les deux boutons de la barre de titre sont contextuels : le bouton « Visual Editor » n'apparaît que
lorsqu'un fichier `.xaml` est ouvert comme texte, et le bouton « as Text » seulement lorsque l'éditeur
visuel est actif.

(La capture au début de ce document montre un fichier `.xaml` ouvert dans l'éditeur visuel avec les
trois panneaux visibles.)

---

## 4. L'interface

L'éditeur visuel est une disposition à trois panneaux (voir le diagramme en haut) :

| Panneau | Ce qu'il montre |
|---------|-----------------|
| **Arbre de structure** (gauche) | La hiérarchie des éléments XAML. Cliquer pour sélectionner, glisser pour réordonner. Redimensionnable. |
| **Aperçu** (centre) | La surface rendue, avec barre d'outils, règles/repères, zoom et surcouche de sélection. |
| **Propriétés** (droite) | Éditeurs typés pour les attributs de l'élément sélectionné, plus *Ajouter une propriété*. Redimensionnable. |

Les deux panneaux latéraux peuvent être repliés et redimensionnés ; les largeurs des panneaux et la
position de la barre d'outils sont mémorisées par fenêtre.

### La barre d'outils de l'aperçu

La barre flotte au-dessus de l'aperçu. Elle peut être ancrée (haut/bas/gauche/droite) ou laissée
flottante, et retient sa place par fenêtre. Deux de ses boutons changent d'aspect selon l'état ; la
voici donc dans ses deux configurations habituelles.

**Vue Conception** — le bouton Conception est actif et se déploie en pastille étiquetée. Les commandes
de zoom sont visibles et le point d'état de l'hôte est vert (l'hôte WPF tourne et rend correctement) :

![Barre d'outils en vue Conception](../images/toolbar-design.png)

**Vue Modifications** — le bouton Modifications est actif et affiche le nombre de changements en
attente. Les commandes de zoom disparaissent (elles appartiennent à la surface de conception, pas au
diff), l'outil Déplacer est sélectionné, et le point est gris parce que cette fenêtre utilise le
moteur de rendu web :

![Barre d'outils en vue Modifications](../images/toolbar-changes.png)

Ces deux différences sont indépendantes l'une de l'autre : **le panneau de zoom est masqué uniquement
parce que le mode de vue est Modifications**, et **la couleur du point dépend seulement du moteur
d'aperçu et de l'état de rendu de l'hôte** — pas du mode de vue.

#### Toutes les commandes, de gauche à droite

| Icône | Commande | Type | Ce qu'elle fait |
|:-----:|----------|------|-----------------|
| ![](../images/icons/gripper.png) | **Déplacer la barre** | poignée | Faites glisser la barre ; lâchez-la près d'un bord pour l'ancrer. |
| ![](../images/icons/layout-sidebar-left.png) | **Afficher Structure** | bouton *(conditionnel)* | Rouvre le panneau Structure. Visible seulement tant que ce panneau est replié. |
| ![](../images/icons/pan.png) | **Déplacer (Pan)** | outil | Glisser fait défiler l'aperçu. Également disponible à tout moment avec le bouton central de la souris. |
| ![](../images/icons/move.png) | **Sélectionner / déplacer** | outil | Sélectionne les éléments, les déplace par glissement, les redimensionne avec les 8 poignées. |
| ![](../images/icons/list-tree.png) | **Réordonner** | outil | Faites glisser les éléments dans l'aperçu pour changer leur ordre entre frères, comme dans l'arbre. **C'est l'outil par défaut.** |
| ![](../images/icons/eye.png) | **Ouverture automatique** | bascule | Ouvre automatiquement la liste/le menu de l'élément sélectionné (ComboBox, Menu, …). **Activé par défaut.** |
| ![](../images/icons/discard.png) | **Annuler** | bouton | Annule la dernière modification (la pile d'annulation native de VS Code). |
| ![](../images/icons/redo.png) | **Rétablir** | bouton | Rétablit. |
| ![](../images/icons/trash.png) | **Supprimer** | bouton | Supprime l'élément sélectionné (comme la touche <kbd>Suppr</kbd>). |
| ![](../images/icons/edit.png) | **Conception** | bascule de vue | La surface de conception en direct. Se déploie en pastille étiquetée quand elle est active. |
| ![](../images/icons/git-compare.png) | **Modifications** | bascule de vue | Le diff par rapport au fichier enregistré. Active, elle affiche *Modifications (n)* ; inactive, seulement *n* en badge, et rien du tout s'il n'y a aucune modification. |
| ![](../images/icons/symbol-numeric.png) | **Grille** | bascule | La surcouche de grille de points. L'activer active aussi l'aimantation à la grille — il n'y a pas de bouton aimant séparé. **Désactivée par défaut.** |
| ![](../images/icons/symbol-ruler.png) | **Règles** | bascule | Règles, repères déplaçables et aimantation aux repères. **Activées par défaut.** |
| ![](../images/icons/symbol-color.png) | **Thème de l'aperçu** | menu | Les thèmes de dictionnaires de ressources trouvés dans le projet, puis le jeu standard : Classic, Classic '98, System, Light, Dark, Native. Voir la [section 6](#6-moteurs-daperçu). |
| ![](../images/icons/server-process.png) | **Moteur d'aperçu** | menu | `Auto`, `Web` et — sous Windows uniquement — `WPF host` et `WPF host — isolated`. Voir la [section 6](#6-moteurs-daperçu). |
| ![](../images/icons/play.png) | **Exécuter la fenêtre** | menu | Ouvre le XAML dans une vraie fenêtre Windows : *Snapshot* (ponctuel) ou *Live* (suit le projet). Moteur WPF, Windows uniquement. |
| ![](../images/icons/package.png) | **Ressources du projet** | boîte de dialogue | Choisissez quelles DLL de contrôles personnalisés, `App.xaml` et dictionnaires de ressources charger. Voir la [section 7](#7-ressources-du-projet-hôte-wpf). |
| ![](../images/icons/dot-ok.png) | **État de l'hôte** | indicateur + bouton | L'état de l'hôte WPF (voir le tableau ci-dessous). Cliquez pour ouvrir la console/le journal. |
| ![](../images/icons/layout-sidebar-right.png) | **Afficher Propriétés** | bouton *(conditionnel)* | Rouvre le panneau Propriétés. Visible seulement tant que ce panneau est replié. |
| ![](../images/icons/triangle-right.png) | **Redimensionner la barre** | poignée *(conditionnel)* | Faites glisser pour redimensionner la barre. Visible seulement tant qu'elle est flottante (non ancrée). |

Déplacer, Sélectionner et Réordonner s'excluent mutuellement — exactement un est toujours actif.

#### Le point d'état de l'hôte

| Point | Signification |
|:-----:|---------------|
| ![](../images/icons/dot-ok.png) | L'hôte WPF tourne et le dernier rendu a réussi. |
| ![](../images/icons/dot-idle.png) | L'hôte WPF démarre. |
| ![](../images/icons/dot-error.png) | L'hôte WPF a signalé une erreur de rendu. La console s'ouvre automatiquement. |
| ![](../images/icons/dot-inactive.png) | Pas d'hôte WPF : soit vous n'êtes pas sous Windows, soit le moteur d'aperçu est réglé sur `Web`. Ce n'est pas une erreur. |

Un **anneau bleu** autour du point signifie que des ressources du projet sont chargées. Cliquer sur le
point ouvre toujours la console/le journal, quelle que soit sa couleur. Si l'hôte est isolé, son
info-bulle le précise.

#### Le panneau de zoom

![](../images/icons/zoom-out.png) ![](../images/icons/zoom-in.png)
![](../images/icons/screen-full.png)

Le zoom **ne fait pas partie de la barre d'outils** : c'est un petit panneau distinct dans le coin
inférieur droit de l'aperçu — *dézoomer*, le pourcentage actuel (cliquer pour revenir à 100 %),
*zoomer* et *Ajuster*. Il est masqué en vue Modifications. Quand la barre est ancrée au bord inférieur
et qu'il y a de la place, le panneau de zoom s'ancre à son extrémité droite — d'où l'impression d'une
seule barre sur la capture de la vue Conception ci-dessus.

---

## 5. Fonctionnalités

### 5.1 Arbre de structure et réordonnancement

L'arbre reflète la hiérarchie XAML. Cliquez sur un nœud pour le sélectionner (l'élément correspondant
est mis en évidence dans l'aperçu). **Faites glisser un nœud** pour le réordonner : les zones de dépôt
indiquent *avant*, *dedans* ou *après* une cible, et le dépôt dans votre propre sous-arbre est
bloqué. Le déplacement est appliqué comme un `moveElement` chirurgical, en préservant l'indentation.

### 5.2 Édition visuelle — déplacer et redimensionner

Avec l'outil **Sélectionner**, cliquez sur un élément de l'aperçu pour le sélectionner. Ensuite :

- **Déplacez** par glissement. Selon la disposition du parent, le déplacement met à jour `Margin` (la
  plupart des panneaux) ou `Canvas.Left/Top` (à l'intérieur d'un `Canvas`).
- **Redimensionnez** avec les **8 poignées** (coins + bords) ; cela met à jour `Width`/`Height` (et
  `Margin` si nécessaire).
- Un **aperçu en direct** suit votre geste ; au relâchement, le changement est appliqué en une seule
  écriture chirurgicale (`setAttributes`).

![Un élément sélectionné avec ses 8 poignées de redimensionnement](../images/screen-drag-resize.png)

### 5.3 Ajouter / supprimer / copier des éléments

- **Ajoutez** un élément depuis la barre : choisissez parmi 15 types courants (Grid, StackPanel,
  Canvas, Border, TextBlock, Label, Button, TextBox, CheckBox, RadioButton, Slider, ProgressBar, Image,
  Ellipse, Rectangle). Un extrait par défaut est inséré dans le conteneur sélectionné.
- **Supprimez** l'élément sélectionné avec la touche **Suppr**.
- **Copiez / coupez / collez** un sous-arbre avec **Ctrl+C / Ctrl+X / Ctrl+V** (coller comme frère ou
  comme enfant). Le presse-papiers est le **presse-papiers du système** — l'élément est copié comme
  fragment XAML — cela fonctionne donc **entre fenêtres XVE** et dans les deux sens avec un **éditeur
  de texte**. La déduplication facultative de `x:Name` au collage (paramètre
  `xve.paste.nameDeduplication`, désactivée par défaut) renomme les noms en conflit en noms uniques
  sans toucher à l'original.

### 5.4 Panneau de propriétés

<img src="../images/screen-properties.png" align="right" width="280"
     alt="Le panneau de propriétés avec un sélecteur de couleur ouvert et un attribut modifié">

Le panneau affiche des **éditeurs typés** selon la nature de chaque propriété :

| Nature | Éditeur |
|--------|---------|
| `bool` | case à cocher |
| `enum` | liste déroulante |
| `number` | champ numérique |
| `brush` | sélecteur de couleur |
| `thickness` | quatre champs L,T,R,B |
| `string` | champ de texte |

Il couvre les propriétés courantes (Name, Width/Height, tailles Min/Max, Margin, Padding, alignement,
Background/Foreground, BorderBrush/Thickness, polices, Opacity, Visibility, IsEnabled…), les propriétés
attachées (`Grid.Row/Column`, `Canvas.Left/Top`, `DockPanel.Dock`) et celles propres au type (Text,
Content, IsChecked, Value/Minimum/Maximum, etc.).

Utilisez **« + Ajouter une propriété »** pour ajouter n'importe quelle propriété connue, et les
commandes par attribut pour en supprimer une. Les attributs **modifiés depuis le dernier
enregistrement** sont mis en évidence par une barre colorée et reçoivent un bouton de **rétablissement**
par attribut — sur la capture, `BorderBrush` a été modifié avec le sélecteur de couleur, tandis que
`VerticalAlignment` est intact.

<br clear="right">

### 5.5 Vue des modifications (diff)

Basculez la barre de **Conception** vers **Modifications** pour voir tout ce qui diffère du **fichier
enregistré** : attributs modifiés, éléments ajoutés, éléments supprimés et éléments déplacés (détectés
par une correspondance d'arbre LCS, de sorte qu'un réordonnancement n'est pas signalé comme
ajout+suppression). Chaque entrée possède un bouton de **rétablissement par bloc**, et il existe une
action **Tout rétablir**. Cliquer sur une entrée sélectionne l'élément dans l'aperçu. Les
rétablissements utilisent les mêmes opérations chirurgicales que l'édition.

![La vue Modifications avec des entrées modifiées, ajoutées et supprimées](../images/screen-changes.png)

### 5.6 Zoom et navigation

Le zoom va de **10 à 800 %**. Utilisez le panneau de zoom dans le coin inférieur droit de l'aperçu,
**Ctrl+molette** (ancré sur le curseur), ou **Ajuster** pour adapter l'aperçu à la fenêtre. Par défaut
(`xve.preview.fitOnOpen`), un document est ajusté à l'ouverture : réduit s'il est plus grand que la
vue, sinon affiché à 100 % (jamais agrandi). **Déplacez** avec l'outil Déplacer ou le bouton central
de la souris. Les règles, les repères et l'aimantation respectent le zoom courant.

### 5.7 Règles, repères et aimantation à la grille

Activez les **règles** (haut/gauche) et la surcouche de **grille** de points depuis la barre. Ajoutez
un **repère** en cliquant sur une règle ; faites-le glisser pour le déplacer, double-cliquez pour le
supprimer. Pendant le déplacement/redimensionnement, les éléments **s'aimantent** à la grille et aux
repères. Le pas de la grille et le seuil d'aimantation sont définis par `xve.canvas.gridStep` (8 px par
défaut).

### 5.8 Synchronisation de la sélection avec l'éditeur de texte

Quand un éditeur de texte est ouvert à côté, la sélection est **bidirectionnelle** :

- **Visuel → texte** (`xve.sync.selectInTextEditor`) : sélectionner un élément déplace le curseur de
  texte vers sa balise ouvrante. Ci-dessous, choisir la seconde `CheckBox` dans l'arbre de structure
  amène l'éditeur à la ligne 10.

  ![Sélectionner un élément dans l'arbre déplace le curseur de texte](../images/screen-sync1.png)

- **Texte → visuel** (`xve.sync.selectFromTextCursor`) : déplacer le curseur dans le code sélectionne
  l'élément correspondant dans l'aperçu. Ci-dessous, le curseur est sur la ligne 9 et la première
  `CheckBox` est sélectionnée dans l'aperçu, avec ses poignées.

  ![Déplacer le curseur de texte sélectionne l'élément correspondant](../images/screen-sync2.png)

Les deux sens sont activés par défaut et se règlent indépendamment. L'éditeur de texte peut être
scindé sous l'éditeur visuel ou placé à côté — les deux dispositions fonctionnent.

### 5.9 Langue de l'interface

L'interface est localisée en **7 langues**. Réglez `xve.language` (vide = suivre VS Code). Après
changement, rechargez le webview avec **Ctrl+R** pour l'appliquer.

---

## 6. Moteurs d'aperçu

![Moteurs d'aperçu](../images/preview-backends.png)

XVE dispose de deux moteurs de rendu, choisis avec **`xve.previewBackend`** :

- **`auto`** (par défaut) — hôte WPF sous Windows, moteur de rendu web partout ailleurs.
- **`web`** — le moteur de rendu web multiplateforme (sous-ensemble XAML → HTML/CSS).
- **`wpf-host`** — l'hôte WPF Windows (vrai moteur WPF, haute fidélité).

Vous pouvez aussi forcer le moteur par fenêtre depuis le sélecteur de la barre, qui propose une
quatrième entrée : *WPF host — isolated* (voir [Isolation](#isolation-xvepreviewisolation) plus bas).
Si l'hôte WPF échoue ou dépasse le délai, XVE revient automatiquement au moteur web ; s'il ne peut pas
démarrer du tout — le plus souvent parce que le **.NET 10 Desktop Runtime** n'est pas installé — vous
recevez une notification avec un lien de téléchargement.

### Styles et ressources dans le moteur de rendu web

Le moteur web est plus qu'une correspondance balise → `<div>`. Avant le rendu, XVE extrait le
sous-ensemble des ressources du document convertible en CSS et l'applique :

- **Pinceaux** — ressources `SolidColorBrush` et `ImageBrush` référencées par clé.
- **Styles** — un `Style` avec des `Setter` simples (propriétés que le moteur comprend), y compris les
  **chaînes `BasedOn`**, qui sont aplaties.
- **Styles implicites** — un `Style` sans clé avec un `TargetType` s'applique à tous les éléments de ce
  type, exactement comme dans WPF.
- **Résolution des ressources** — `{StaticResource clé}` et `{DynamicResource clé}` sont résolues
  contre les dictionnaires de ressources du document.

La priorité suit WPF : style implicite → style nommé (avec sa chaîne `BasedOn`) → attribut en ligne,
l'attribut en ligne l'emportant toujours. Tout ce qui sort de ce sous-ensemble (déclencheurs, modèles,
convertisseurs, liaisons de données) est ignoré par le moteur web — utilisez l'hôte WPF quand vous en
avez besoin fidèlement.

### Thèmes de l'aperçu

Le sélecteur de thèmes (![](../images/icons/symbol-color.png)) propose le jeu standard — **Classic**
(WPF pur), **Classic '98**, et les variantes Fluent **Light** / **Dark** / **System**, que l'hôte WPF
applique via `ThemeMode`. Les **thèmes de dictionnaires de ressources trouvés dans votre projet** sont
listés au-dessus et s'appliquent de la même façon. `Native` est une apparence GTK/Linux et n'affecte
que le moteur web (l'hôte WPF retombe sur Classic).

![Le même formulaire dans plusieurs thèmes, dont des dictionnaires du projet](../images/screen-themes.png)

### Options de l'hôte WPF

| Paramètre | Rôle |
|-----------|------|
| `xve.preview.theme` | Thème de l'aperçu : `none` (Classic), `classic98`, `system`/`light`/`dark` (Fluent), `native` (apparence GTK, web seulement). |
| `xve.preview.renderScale` | Suréchantillonnage : `auto` = device pixel ratio (net en HiDPI), ou `1`/`1.5`/`2`/`3`. |
| `xve.preview.maxResolution` | Plafond de la taille du bitmap (côté le plus long, pixels de l'appareil). `0` = illimité. |
| `xve.preview.viewportRender` | Ne rendre que la région visible — plus rapide sur les grandes conceptions. |
| `xve.preview.capBasis` | Rendu de la zone visible : mesurer `maxResolution` sur la seule zone visible (`visible`, netteté stable quelle que soit la taille de la fenêtre) ou sur toute la tranche, overscan compris (`slice`, ancien comportement). |
| `xve.preview.overscan` | Rendu de la zone visible : marge supplémentaire (unités du projet) rendue autour de la région visible comme tampon de défilement. |
| `xve.preview.debugConsole` | Affiche une console de débogage en bas de l'aperçu avec la télémétrie de rendu en direct. |
| `xve.preview.consoleOnStart` | Ancre la console pendant le démarrage de l'hôte. Désactivée, elle s'ouvre tout de même sur une erreur de rendu. |
| `xve.preview.isolation` | Si un fichier obtient son propre processus hôte et ses propres ressources (voir plus bas). |

### Résolution adaptative

Rendre une grande surface en pleine résolution HiDPI à chaque image d'un glissement coûte cher. Avec
**`xve.preview.adaptiveRes`** (**activé par défaut**), l'hôte rend à une résolution réduite
(`xve.preview.motionResolution`, 512 px sur le côté long par défaut) *pendant que vous glissez, faites
défiler ou zoomez*, puis refait un rendu unique à la pleine `maxResolution` dès que le mouvement
s'arrête. Le mouvement rapide reste fluide, et l'image au repos reste nette.

La dégradation n'est pas inconditionnelle : elle ne s'enclenche que lorsque le rendu pleine résolution
tombe sous **`xve.preview.adaptiveFpsThreshold`** images par seconde (30 par défaut). Sur une machine
rapide avec une petite conception, vous ne quittez donc jamais la pleine résolution. Mettez le seuil à
`0` pour toujours utiliser la résolution de mouvement pendant le déplacement.

### Stratégie d'aperçu en direct au glissement/redimensionnement

Pendant un glissement/redimensionnement en mode hôte WPF, le re-rendu en direct est régi par :

- `xve.preview.dragStrategy` — `overlay` (pas de re-rendu en direct), `frames` (toutes les N images) ou
  `ms` (toutes les N millisecondes, la valeur par défaut).
- `xve.preview.dragIntervalMs` (25 par défaut), `xve.preview.dragFrames` (2 par défaut).
- `xve.preview.dragCoalesce` — garder au plus un rendu en vol (rejeter les images périmées).
- `xve.preview.dragSession` — analyser une fois et muter un arbre en cache au lieu de ré-analyser.
- `xve.preview.dragOnChange` — ne rendre une nouvelle image que lorsque les attributs de l'élément
  déplacé changent réellement ; maintenir le pointeur immobile ne coûte donc rien.
- `xve.preview.debugLiveDrag` — rafraîchir aussi la télémétrie de la console à chaque image de
  glissement.

### Isolation (`xve.preview.isolation`)

L'hôte WPF peut charger les ressources du projet, qui influent sur le rendu des types personnalisés.
L'isolation détermine si un fichier partage un hôte ou obtient le sien :

- `ask` — pour un fichier d'un autre projet (ou sans projet), demander s'il faut l'isoler.
- `auto` (par défaut) — isoler ces fichiers automatiquement ; partager un hôte au sein du projet
  ouvert.
- `shared` — ne jamais isoler (un hôte pour tout).
- `isolated` — toujours isoler (un hôte distinct par fichier).

---

## 7. Ressources du projet (hôte WPF)

Pour un aperçu fidèle des **contrôles personnalisés** et des thèmes du projet, l'hôte WPF peut charger
les ressources de votre projet. XVE remonte depuis le fichier XAML à la recherche d'un `.csproj`, puis
trouve la meilleure sortie `bin/<Config>/<tfm>`, plus `App.xaml` et les dictionnaires de ressources.

- Le choix est proposé dans un **QuickPick** et mémorisé par projet ; la politique est fixée par
  **`xve.project.autoLoadResources`** (`ask` / `always` / `never`).
- L'hôte charge les **DLL** de contrôles personnalisés (via `AssemblyResolve` pour les types
  `clr-namespace`) et fusionne `App.xaml` / les dictionnaires dans `Application.Resources`.
- Utilisez le bouton **Ressources du projet** (![](../images/icons/package.png)) dans la barre de
  l'aperçu pour re-sélectionner les ressources à tout moment.

![Un contrôle personnalisé rendu par l'hôte WPF, avec le sélecteur de ressources](../images/screen-wpf-host.png)

---

## 8. Gestion des erreurs

Quand le XAML ne s'analyse pas ou ne se rend pas, XVE aide à le localiser et à le corriger :

- **Surligner les changements dans le code** (`xve.editor.highlightChanges`) — les lignes modifiées sont
  colorées dans l'éditeur de texte adjacent (reflète la bascule du panneau Modifications).
- **Surligner les erreurs dans le code** (`xve.editor.highlightErrors`) — la ligne d'erreur est colorée
  et le jeton fautif souligné. Cliquer sur l'erreur la révèle dans l'éditeur de texte.
- **Suggestions de correction automatique** — pour un type ou une propriété inconnus, XVE propose le
  nom connu le plus proche (p. ex. `Buton` → `Button`) par distance d'édition.
- **La console** — cliquez sur le point d'état de l'hôte pour l'ouvrir. Sur une erreur de rendu, elle
  s'ouvre d'elle-même, quoi que dise `xve.preview.consoleOnStart`.

![La console de l'hôte affichant une erreur de rendu](../images/screen-host-console.png)

### Quand l'hôte WPF ne peut pas démarrer

Si le binaire de l'hôte est absent, si le **.NET 10 Desktop Runtime** n'est pas installé, ou si le
processus meurt au démarrage, XVE affiche une notification expliquant lequel des trois cas s'est
produit, et bascule silencieusement sur le moteur web. La notification propose de télécharger le
runtime, ou de passer `xve.previewBackend` à `web` pour que l'hôte ne soit plus tenté du tout. Chaque
type d'échec est signalé une fois par session.

---

## 9. Référence des paramètres

Tous les paramètres vivent sous **`xve.*`**. La plupart sont à portée de fenêtre, donc différentes
fenêtres VS Code peuvent différer. Les valeurs par défaut ci-dessous correspondent à `package.json`.

| Paramètre | Type | Défaut | Description |
|-----------|------|--------|-------------|
| `xve.language` | enum | `""` | Langue de l'interface (`""`=suivre VS Code, `en`,`pl`,`es`,`de`,`fr`,`ja`,`zh`). Recharger avec Ctrl+R. |
| `xve.project.autoLoadResources` | enum | `ask` | Comment charger les ressources du projet pour l'hôte WPF : `ask` / `always` / `never`. |
| `xve.sync.selectInTextEditor` | bool | `true` | Sélectionner un élément y déplace le curseur de texte. |
| `xve.sync.selectFromTextCursor` | bool | `true` | Déplacer le curseur de texte sélectionne l'élément correspondant. |
| `xve.editor.highlightChanges` | bool | `true` | Colorer les lignes modifiées dans l'éditeur de texte. |
| `xve.editor.highlightErrors` | bool | `true` | Colorer/souligner la ligne d'erreur dans l'éditeur de texte. |
| `xve.paste.nameDeduplication` | enum | `off` | Collisions de `x:Name` au collage : `off` (coller tel quel) / `rename` / `renameAndReferences` (corrige aussi `ElementName`, `x:Reference` dans le sous-arbre collé). |
| `xve.previewBackend` | enum | `auto` | Moteur d'aperçu : `auto` / `web` / `wpf-host`. |
| `xve.preview.isolation` | enum | `auto` | Isolation de l'hôte WPF : `ask` / `auto` / `shared` / `isolated`. |
| `xve.preview.renderScale` | enum | `auto` | Suréchantillonnage : `auto` / `1` / `1.5` / `2` / `3`. |
| `xve.preview.maxResolution` | number | `1536` | Taille maximale du bitmap (côté long, px de l'appareil). `0`=illimité. |
| `xve.preview.theme` | enum | `none` | Thème de l'aperçu : `none` / `classic98` / `system` / `light` / `dark` / `native`. |
| `xve.preview.viewportRender` | bool | `true` | Ne rendre que la région visible. |
| `xve.preview.capBasis` | enum | `visible` | Rendu de la zone visible : base du plafond — `visible` / `slice`. |
| `xve.preview.overscan` | number | `100` | Rendu de la zone visible : marge (unités du projet) autour de la région visible. |
| `xve.preview.debugConsole` | bool | `false` | Console de débogage avec télémétrie de rendu en bas de l'aperçu. |
| `xve.preview.consoleOnStart` | bool | `true` | Ancrer la console pendant le démarrage de l'hôte. Désactivé = masquée au démarrage, mais affichée sur une erreur de rendu. |
| `xve.preview.debugLiveDrag` | bool | `false` | Rafraîchir aussi la télémétrie de la console à chaque image de glissement. |
| `xve.preview.dragStrategy` | enum | `ms` | Stratégie de glissement en direct : `overlay` / `frames` / `ms`. |
| `xve.preview.dragIntervalMs` | number | `25` | Pour `ms` : intervalle minimal entre re-rendus en direct (ms). |
| `xve.preview.dragFrames` | number | `2` | Pour `frames` : re-rendre toutes les N images. |
| `xve.preview.dragCoalesce` | bool | `true` | Garder au plus un rendu en vol pendant glissement/défilement. |
| `xve.preview.dragSession` | bool | `true` | Session de glissement persistante (analyser une fois, muter l'arbre en cache). |
| `xve.preview.dragOnChange` | bool | `true` | Pendant un glissement, ne rendre que si les attributs changent réellement. |
| `xve.preview.adaptiveRes` | bool | `true` | Résolution adaptative : rendre à `motionResolution` en mouvement, puis une fois à `maxResolution`. |
| `xve.preview.motionResolution` | number | `512` | Résolution (côté long, px de l'appareil) utilisée en mouvement quand la résolution adaptative est active. |
| `xve.preview.adaptiveFpsThreshold` | number | `30` | Ne descendre à `motionResolution` que si le rendu pleine résolution tombe sous ce nombre d'images/s. `0` = toujours. |
| `xve.preview.fitOnOpen` | bool | `true` | Ajuster l'aperçu à la fenêtre à l'ouverture (jamais d'agrandissement). |
| `xve.canvas.gridStep` | number | `8` | Pas de la grille et seuil d'aimantation, en pixels. |
| `xve.canvas.showGrid` | bool | `false` | Valeur initiale d'affichage de la grille de points. |
| `xve.canvas.showRulers` | bool | `true` | Valeur initiale d'affichage des règles/repères. |

### Commandes

| Commande | Titre | Quand |
|----------|-------|-------|
| `xve.openVisualEditor` | XVE: Open in XAML Visual Editor | `.xaml` ouvert comme texte |
| `xve.openTextEditor` | XVE: Open XAML as Text | `.xaml` ouvert dans l'éditeur visuel |

---

## 10. Raccourcis clavier

| Raccourci | Action |
|-----------|--------|
| **Ctrl+Z / Ctrl+Y** | Annuler / rétablir (natif VS Code, via le TextDocument) |
| **Suppr** | Supprimer l'élément sélectionné |
| **Ctrl+C / Ctrl+X / Ctrl+V** | Copier / couper / coller le sous-arbre sélectionné (presse-papiers système, XAML) |
| **Ctrl+molette** | Zoomer/dézoomer, ancré sur le curseur |
| **Bouton central / outil Déplacer** | Déplacer le canevas |
| **Ctrl+R** | Recharger le webview (p. ex. pour appliquer un changement de langue) |

XVE n'enregistre pas de raccourcis propres ; il s'appuie sur les commandes d'éditeur intégrées de
VS Code.

---

## 11. Architecture

![Architecture](../images/architecture.png)

L'extension s'exécute dans deux contextes coopérants, plus un hôte natif facultatif :

- **Extension host (Node/TS)** — `extension.ts` active l'extension et enregistre les commandes ;
  `XveEditorProvider` est le `CustomTextEditorProvider`. Les modules de `core/` font le vrai travail :
  `XamlDocument` (enregistrement chirurgical), `XamlParser` (tokeniseur positionnel), `StructuralDiff`
  / `LineDiff`, `TypeRegistry` (types et métadonnées de propriétés), `ResourceModel` (pinceaux, styles,
  `BasedOn`), `ProjectScanner` (`.csproj` → DLL et dictionnaires), `PasteNames` (déduplication de
  `x:Name`) et `Localization`. `host/WpfHost` gère le processus de l'hôte WPF et signale les échecs
  fatals au démarrage.
- **Webview (HTML/CSS/TS)** — `main.ts` pilote l'arbre, les propriétés, la barre d'outils et
  l'interface ; `renderer.ts` est le moteur de rendu web XAML→DOM ; `styleResolver.ts` applique en CSS
  les styles/ressources XAML extraits ; `style.css` est la disposition à trois panneaux. Il dialogue
  avec l'extension host via `postMessage`.
- **Hôte WPF (Windows)** — `xve-wpf-host.exe` (.NET 10) rend le XAML avec le vrai moteur WPF vers un PNG
  plus une carte de hit-test (via des `x:Uid` injectés), sur un protocole JSON-lines via stdio. Il peut
  s'exécuter partagé pour tout le projet ou isolé par fichier.

### Flux d'édition

![Flux d'édition](../images/edit-flow.png)

Chaque modification — un changement de propriété, un glissement/redimensionnement, un réordonnancement
— est convertie par `XamlDocument` en le plus petit ensemble de modifications de texte, appliquée via
un `WorkspaceEdit`, puis le document est ré-analysé et l'aperçu re-rendu. Comme le `TextDocument` est
toujours la source de vérité, annuler/rétablir est natif et les régions intactes ne changent jamais.

---

## 12. Fichiers d'exemple

Le dossier `samples/` contient des fichiers XAML à ouvrir pour explorer l'éditeur :

| Fichier | Démontre |
|---------|----------|
| [`samples/SampleGrid.xaml`](../../samples/SampleGrid.xaml) | Une mise en page de formulaire en `Grid` avec `RowDefinitions`/`ColumnDefinitions`, spans et alignement. |
| [`samples/SampleControls.xaml`](../../samples/SampleControls.xaml) | `Menu`, `ComboBox` et un `ScrollViewer` — pratique pour tester l'ouverture automatique et le défilement par zone. |
| `samples/Sample.xaml`, `Sample2.xaml` | Exemples simples de `Window` + `StackPanel`. |

Dans `SampleControls.xaml`, sélectionnez un `MenuItem` ou une `ComboBox` avec l'ouverture automatique
activée pour déployer son sous-menu/sa liste ; survolez le `ScrollViewer` et utilisez la molette pour
ne faire défiler que cette zone.

---

## 13. Dépannage / FAQ

**Le fichier `.xaml` s'ouvre en texte brut, pas dans l'éditeur visuel.**
C'est voulu — l'éditeur visuel est une *option*. Utilisez le bouton de la barre de titre ou
`xve.openVisualEditor` pour basculer.

**L'aperçu semble approximatif / les contrôles personnalisés apparaissent en espaces réservés.**
Vous êtes probablement sur le moteur web. Sous Windows, réglez `xve.previewBackend` sur `auto` ou
`wpf-host`, puis chargez les [ressources du projet](#7-ressources-du-projet-hôte-wpf) avec le bouton
**Ressources du projet**.

**Le point d'état de l'hôte reste gris et l'aperçu n'utilise jamais WPF.**
Gris signifie que l'hôte n'est pas actif — soit vous n'êtes pas sous Windows, soit `xve.previewBackend`
vaut `web`. Si vous êtes passé à `wpf-host` et que le point reste gris, cherchez la notification
d'erreur : la cause la plus fréquente est l'absence du
[.NET 10 Desktop Runtime](https://dotnet.microsoft.com/download/dotnet/10.0). Notez que le runtime
*Desktop* est un téléchargement distinct du runtime .NET ordinaire.

**Les types personnalisés ne s'affichent toujours pas dans l'hôte WPF.**
Assurez-vous que le projet est compilé (pour que les DLL existent sous `bin/...`) et que vous avez
sélectionné les bonnes ressources. Cliquez sur le point d'état de l'hôte pour lire le journal.

**L'interface est dans la mauvaise langue.**
Réglez `xve.language` et rechargez le webview avec **Ctrl+R**.

**Les grandes conceptions semblent lentes au glissement.**
Laissez `xve.preview.viewportRender` et `xve.preview.adaptiveRes` activés — ensemble, ils ne rendent
que la région visible, et à résolution réduite pendant le déplacement. Si c'est encore lourd, baissez
`xve.preview.motionResolution` (p. ex. à 384), ou augmentez `xve.preview.adaptiveFpsThreshold` pour que
le mode basse résolution s'enclenche plus tôt. Le mettre à `0` utilise toujours la résolution de
mouvement pendant le déplacement. Laissez `dragStrategy` sur `ms`.

---

## 14. Historique du développement

XVE a été construit par étapes. Un historique condensé :

- **Étape 8** — fidélité de mise en page et propriétés : coercition de taille façon WPF dans le moteur
  web, un jeu complet de propriétés courantes, un `Grid` fidèle
  (`RowDefinitions`/`ColumnDefinitions`, spans, alignement de cellule), **réordonnancement** dans
  l'arbre, et **ressources du projet** pour l'hôte WPF.
- **Étape 7** — rendu à la résolution de l'écran (`renderScale`, par défaut `auto`=device pixel ratio),
  VS Code comme source de vérité pour `xve.preview.*`, et travail de performance sur l'hôte (debounce +
  coalescing, `ThemeMode` en cache, `RenderTargetBitmap` réutilisé, préchauffage de l'hôte).
- **Étape 6** — le **zoom** (10–800 %, Ctrl+molette, Ajuster), l'**hôte WPF** (`wpf-host/`, .NET 10,
  JSON-lines), le rendu par viewport, le plafond de résolution et le panneau de paramètres.
- **Étape 4** — `LineDiff` + `StructuralDiff` et la vue **Modifications** avec rétablissement par bloc
  et Tout rétablir.
- **Étape 3** — édition visuelle (glisser/redimensionner), opérations structurelles dans
  `XamlDocument`, la barre d'ajout/suppression, et règles/repères/aimantation avec un viewport stable.
- **Avant** — l'éditeur de texte personnalisé pour `*.xaml`, `XamlDocument` + `XamlParser` positionnel,
  le moteur de rendu web, la sélection bidirectionnelle, le panneau de propriétés typées, la
  localisation (7 langues) et les tests d'aller-retour / d'enregistrement chirurgical.
