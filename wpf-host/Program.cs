// xve-wpf-host — proces pomocniczy (Windows). Renderuje XAML prawdziwym silnikiem WPF
// do PNG i zwraca mapę hit-test (prostokąty elementów wg x:Uid). Komunikacja: JSON-lines
// przez stdio. Jedno żądanie na linię stdin → jedna odpowiedź na linię stdout.
//
// Komendy:
//  render     {xaml,width,height}            → pełny render (parse od zera)
//  dragStart  {xaml,width,height}            → parsuje RAZ i CACHE'UJE żywe drzewo + mapę uid
//  dragUpdate {uid,attrs:{...}}              → ustawia property na elemencie z cache, re-render
//  dragEnd    {}                             → czyści cache
// Odpowiedź: {"id":..,"ok":true,"png":"<base64>","width":W,"height":H,"rects":[...]} | {ok:false,error}

using System.Globalization;
using System.IO;
using System.Reflection;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Documents;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Effects;
using System.Windows.Media.Imaging;
using System.Xml.Linq;

internal static class Program
{
    private static readonly XNamespace XamlNs = "http://schemas.microsoft.com/winfx/2006/xaml";
    private static readonly XNamespace PresentationNs = "http://schemas.microsoft.com/winfx/2006/xaml/presentation";
    private static Dictionary<string, Type>? _typeIndex;

    // zasoby projektu (custom kontrolki + style/słowniki) — ładowane na żądanie z extension.
    private static readonly List<Assembly> _projectAssemblies = new();
    private static readonly List<string> _probeDirs = new();
    private static readonly List<ResourceDictionary> _projectDicts = new();
    private static string _projectKey = "";
    // wynik ostatniego ładowania zasobów (dane strukturalne; etykiety lokalizuje strona TS)
    private static readonly List<string> _projectAsmNames = new();
    private static readonly List<DictRes> _projectDictResults = new();
    private static bool _assemblyResolveHooked;
    // katalog edytowanego pliku — baza dla względnych URI (Icon, Image Source, słowniki)
    private static Uri? _baseUri;
    // mapa clr-namespace → nazwa biblioteki (do kwalifikacji xmlns bez ;assembly=)
    private static Dictionary<string, string>? _nsToAsm;

    // limit rozdzielczości bitmapy (px po dłuższym boku); <=0 = bez limitu (pełna ostrość)
    private static int _cap = 2560;

    // render tylko widocznego obszaru (viewbox w jednostkach projektu) + skala zoom
    private static bool _hasVb;
    private static double _vbX, _vbY, _vbW, _vbH;
    // rozmiar SAMEGO widocznego obszaru (bez overscanu), w jednostkach projektu — podstawa limitu
    // rozdzielczości gdy _capBasis == "visible" (overscan nie zjada wtedy budżetu cap).
    private static double _vbVisW, _vbVisH;
    // podstawa limitu rozdzielczości w trybie viewbox: "visible" (tylko widoczny obszar) | "slice"
    // (cały render z overscanem). "slice" = dawne zachowanie.
    private static string _capBasis = "visible";
    private static double _zoom = 1;

    // auto-podgląd menu/list (funkcja 2): uid wybranego elementu + flaga włączenia
    private static bool _autoReveal;
    private static string? _revealUid;
    // pamięć aktywnych zakładek TabControl: uid wybranych TabItem — stosowana przy każdym renderze
    // (niezależnie od auto-podglądu), by widok zakładki trwał przy zaznaczaniu elementów spoza TabControl.
    private static string[] _tabUids = System.Array.Empty<string>();
    // jednorazowe „przewiń ScrollViewery, by wybrany element był widoczny" (przy zmianie zaznaczenia)
    private static bool _revealScroll;
    private static readonly List<ScrollInfo> _revealScrolled = new();
    // przewinięcie ScrollViewer (funkcja 3): uid → (offset poziomy, pionowy) w jednostkach projektu
    private static readonly Dictionary<string, (double H, double V)> _scrolls = new();
    // Syntetyczne uid dla ScrollViewerów „fake paneli" (lista/menu nakładki) — webview kieruje na nie kółko
    // i utrwala offset w `_scrolls`. Baza musi pokrywać się z FAKE_SCROLL_BASE w webview (main.ts).
    private const int FakeScrollBase = 900_000_000;
    // Element fake-listy do odsłonięcia przy zmianie zaznaczenia (ustawiany przy budowie nakładki,
    // przewijany dopiero PO finalnym layoucie — inaczej BringIntoView na nieułożonym panelu daje 0).
    private static FrameworkElement? _fakeRevealTarget;

    // supersampling: render w gęstości px urządzenia (devicePixelRatio / ustawienie renderScale).
    // 1 = px logiczne; 2 = 2× (ostro na ekranach HiDPI). Webview wyświetla obraz w rozmiarze
    // logicznym, więc przeglądarka downsampluje → ostry podgląd.
    private static double _scale = 1;

    // motyw podglądu: none (klasyczny) | system | light | dark (Fluent przez ThemeMode)
    private static string _theme = "none";
    // ostatnio zastosowany ThemeMode — ustawiamy tylko przy zmianie (re-ewaluacja zasobów jest droga)
    private static string? _appliedTheme;
    // załadowany słownik Classic'98
    private static ResourceDictionary? _classicDict;
    // motyw projektu: słownik ResourceDictionary z zasobów pliku podstawiony jako aktywny motyw
    // (theme = "resource:<ścieżka>"). Trzymany osobno, by móc go zdjąć przy zmianie motywu.
    private static ResourceDictionary? _projectThemeDict;
    // reużywana bitmapa renderu (mniej alokacji/GC przy szybkich klatkach drag/scroll)
    private static RenderTargetBitmap? _rtb;

    // cache trwałej sesji przeciągania (jeden proces → pola statyczne)
    private static FrameworkElement? _dragRoot;
    private static Dictionary<string, FrameworkElement>? _dragMap;
    private static int _dragW, _dragH;
    private static string? _dragRootUid;

    // otwarte okna „na żywo" (play z aktualizacją): winId → okno + dane do złożenia tytułu.
    // Gdy okno jest na żywo, każda zmiana dokumentu w VS Code dosyła updateWindow, który podmienia treść.
    private sealed class LiveWindow
    {
        public Window Win = null!;
        public string BaseTitle = ""; // „Tytuł - plik" (bez nawiasu [..])
        public string LiveLabel = "live";
    }
    private static readonly Dictionary<string, LiveWindow> _liveWindows = new();

    [STAThread]
    private static void Main()
    {
        // We/wy w UTF-8 — extension wysyła XAML jako UTF-8 (polskie znaki, glify ikon Segoe).
        // Bez tego Console domyślnie używa strony kodowej OEM → mojibake (np. „Podgląd"→„Podgl–ůd").
        Console.OutputEncoding = Encoding.UTF8;
        try { Console.InputEncoding = Encoding.UTF8; } catch { /* przy przekierowanym stdin bywa niedostępne */ }

        var app = new Application();
        app.ShutdownMode = ShutdownMode.OnExplicitShutdown;

        // Uruchamiamy wątek do odczytu stdin w tle
        var readThread = new System.Threading.Thread(ReadStdinLoop);
        readThread.IsBackground = true;
        readThread.Start();

        app.Run();
    }

    private static void ReadStdinLoop()
    {
        // StreamReader z jawnym UTF-8 — pewniejsze niż Console.ReadLine() przy przekierowanym stdin.
        using var stdin = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        string? line;
        while ((line = stdin.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            string currentLine = line;
            try
            {
                if (Application.Current != null)
                {
                    Application.Current.Dispatcher.Invoke(() =>
                    {
                        ProcessLine(currentLine);
                    });
                }
            }
            catch
            {
                // Błąd dispatchera lub zamknięcie aplikacji
                break;
            }
        }

        // Zamknięcie stdin -> wyłączenie procesu
        if (Application.Current != null)
        {
            try
            {
                Application.Current.Dispatcher.Invoke(() =>
                {
                    Application.Current.Shutdown();
                });
            }
            catch { }
        }
    }

    private static void ProcessLine(string line)
    {
        object response;
        int id = 0;
        try
        {
            using var docReq = JsonDocument.Parse(line);
            var root = docReq.RootElement;
            id = root.TryGetProperty("id", out var idEl) ? idEl.GetInt32() : 0;
            if (root.TryGetProperty("cap", out var capEl)) _cap = capEl.GetInt32();
            _zoom = root.TryGetProperty("zoom", out var zEl) ? zEl.GetDouble() : 1;
            _scale = root.TryGetProperty("scale", out var scEl) ? scEl.GetDouble() : 1;
            if (root.TryGetProperty("viewbox", out var vbEl) && vbEl.ValueKind == JsonValueKind.Object)
            {
                _hasVb = true;
                _vbX = vbEl.GetProperty("x").GetDouble();
                _vbY = vbEl.GetProperty("y").GetDouble();
                _vbW = vbEl.GetProperty("w").GetDouble();
                _vbH = vbEl.GetProperty("h").GetDouble();
                // widoczny obszar bez overscanu (fallback: cały wycinek = dawne zachowanie)
                _vbVisW = vbEl.TryGetProperty("visW", out var vwEl) ? vwEl.GetDouble() : _vbW;
                _vbVisH = vbEl.TryGetProperty("visH", out var vhEl) ? vhEl.GetDouble() : _vbH;
            }
            else _hasVb = false;
            _capBasis = root.TryGetProperty("capBasis", out var cbEl) ? (cbEl.GetString() ?? "visible") : "visible";
            // auto-podgląd (funkcja 2): włączenie + uid wybranego elementu
            _autoReveal = root.TryGetProperty("autoReveal", out var arEl) && arEl.ValueKind == JsonValueKind.True;
            _revealUid = root.TryGetProperty("reveal", out var rvEl) ? rvEl.GetString() : null;
            _revealScroll = root.TryGetProperty("revealScroll", out var rsEl) && rsEl.ValueKind == JsonValueKind.True;
            // pamięć aktywnych zakładek (uid TabItem) — host trzyma do następnego „tabs"
            if (root.TryGetProperty("tabs", out var tbEl) && tbEl.ValueKind == JsonValueKind.Array)
                _tabUids = tbEl.EnumerateArray().Select(e => e.GetString()).Where(s => !string.IsNullOrEmpty(s)).Select(s => s!).ToArray();
            // przewinięcia ScrollViewer (funkcja 3): mapa uid → {h,v}
            _scrolls.Clear();
            if (root.TryGetProperty("scrolls", out var scEl2) && scEl2.ValueKind == JsonValueKind.Object)
                foreach (var p in scEl2.EnumerateObject())
                    if (p.Value.ValueKind == JsonValueKind.Object)
                        _scrolls[p.Name] = (
                            p.Value.TryGetProperty("h", out var hEl) ? hEl.GetDouble() : 0,
                            p.Value.TryGetProperty("v", out var vvEl) ? vvEl.GetDouble() : 0);
            if (root.TryGetProperty("theme", out var thEl)) _theme = thEl.GetString() ?? "none";
            // kultura UI dla lokalizacji ({Loc}/ResourceManager) — wybór języka z okienka zasobów
            string? cultureReq = root.TryGetProperty("culture", out var cuEl) ? cuEl.GetString() ?? "" : null;
            bool cultureReflect = root.TryGetProperty("cultureReflect", out var crEl) && crEl.ValueKind == JsonValueKind.True;
            if (cultureReq != null) ApplyCulture(cultureReq);
            // katalog pliku — baza dla względnych URI (Icon="Assets/..", Image Source, słowniki)
            if (root.TryGetProperty("baseDir", out var bdEl))
            {
                string bd = bdEl.GetString() ?? "";
                if (string.IsNullOrEmpty(bd)) _baseUri = null;
                else
                {
                    if (!bd.EndsWith('/') && !bd.EndsWith('\\')) bd += Path.DirectorySeparatorChar;
                    try { _baseUri = new Uri(bd, UriKind.Absolute); } catch { _baseUri = null; }
                }
            }
            // zasoby projektu (DLL custom kontrolek + style/słowniki) — apply-if-changed wg "key"
            if (root.TryGetProperty("project", out var projEl) && projEl.ValueKind == JsonValueKind.Object)
                ApplyProject(projEl);
            // opcjonalnie: wymuś kulturę przez refleksję na singletonach lokalizacji w DLL projektu
            // (np. DuPli TranslationSource.Instance.CurrentCulture, które inaczej trzyma się OS UI culture)
            if (cultureReflect && cultureReq != null) ReflectSetCulture(cultureReq);
            var cmd = root.TryGetProperty("cmd", out var c) ? c.GetString() : null;
            switch (cmd)
            {
                case "render":
                    response = RenderResult(id, BuildSurface(Xaml(root), W(root), H(root), reveal: true));
                    break;
                case "dragStart":
                {
                    // forDrag: utrzymaj fake-listę, gdy przeciągany jest element ZE środka listy (nie właściciel).
                    var s = BuildSurface(Xaml(root), W(root), H(root), reveal: true, forDrag: true);
                    _dragRoot = s.root;
                    _dragW = s.pxW;
                    _dragH = s.pxH;
                    _dragRootUid = s.rootUid;
                    // mapę uid budujemy z REALNEGO drzewa (gdy opakowane w Grid z fake-panelem) — dragUpdate
                    // ma trafiać w prawdziwe elementy, a fake-lista zostaje statyczną nakładką.
                    _dragMap = BuildUidMap(RevealInnerRoot(s.root));
                    response = RenderResult(id, s);
                    break;
                }
                case "dragUpdate":
                    response = DragUpdate(id, root.GetProperty("uid").GetString() ?? "", root.GetProperty("attrs"));
                    break;
                case "dragEnd":
                    _dragRoot = null;
                    _dragMap = null;
                    _dragRootUid = null;
                    response = new Resp { id = id, ok = true };
                    break;
                case "ping":
                    response = new Resp { id = id, ok = true };
                    break;
                case "loadProject":
                    // ApplyProject wywołane wyżej (jeśli był „project"); zwróć podsumowanie do statusu/logu
                    response = new Resp { id = id, ok = true, resAsm = _projectAsmNames, resDict = _projectDictResults, locTarget = _locTargetName };
                    break;
                case "showWindow":
                {
                    string filename = root.TryGetProperty("filename", out var fnEl) ? fnEl.GetString() ?? "" : "Preview.xaml";
                    string iconPath = root.TryGetProperty("iconPath", out var iconEl) ? iconEl.GetString() ?? "" : "";
                    bool live = root.TryGetProperty("live", out var lvEl) && lvEl.ValueKind == JsonValueKind.True;
                    string winId = root.TryGetProperty("winId", out var wiEl) ? wiEl.GetString() ?? "" : "";
                    string liveLabel = root.TryGetProperty("liveLabel", out var llEl) ? llEl.GetString() ?? "live" : "live";
                    ShowRealWindow(Xaml(root), _theme, filename, iconPath, live, winId, liveLabel);
                    response = new Resp { id = id, ok = true };
                    break;
                }
                case "updateWindow":
                {
                    string winId = root.TryGetProperty("winId", out var wiEl) ? wiEl.GetString() ?? "" : "";
                    response = UpdateLiveWindow(id, winId, Xaml(root));
                    break;
                }
                default:
                    response = new Resp { id = id, ok = false, error = "unknown cmd" };
                    break;
            }
        }
        catch (Exception ex)
        {
            var (errLine, errCol) = ErrorPosition(ex);
            response = new Resp { id = id, ok = false, error = ErrorMessage(ex), line = errLine, col = errCol };
        }
        Console.WriteLine(JsonSerializer.Serialize(response, response.GetType()));
        Console.Out.Flush();
    }

    private const string ResourceThemePrefix = "resource:";

    private static string _appliedCulture = "\0";
    /// <summary>Ustawia kulturę bieżącą/UI (lokalizacja ResourceManager). "" = invariant (neutralny resx).
    /// Apki czytające CurrentUICulture odzwierciedlą wybór; te zależne od OS UI culture — niekoniecznie.</summary>
    private static void ApplyCulture(string culture)
    {
        if (culture == _appliedCulture) return;
        try
        {
            var ci = string.IsNullOrEmpty(culture)
                ? CultureInfo.InvariantCulture
                : CultureInfo.GetCultureInfo(culture);
            CultureInfo.DefaultThreadCurrentCulture = ci;
            CultureInfo.DefaultThreadCurrentUICulture = ci;
            CultureInfo.CurrentCulture = ci;
            CultureInfo.CurrentUICulture = ci;
            _appliedCulture = culture;
        }
        catch { /* nieznana kultura — zostaw bieżącą */ }
    }

    // cele refleksji lokalizacji — WSZYSTKIE statyczne singletony typu lokalizacji (np. DuPli
    // TranslationSource.Instance ORAZ .PreviewInstance), wykryte raz po załadowaniu zasobów.
    private static bool _locResolved;
    private static readonly List<(object inst, PropertyInfo prop, MethodInfo? refresh)> _locTargets = new();
    private static string? _locTargetName; // nazwa typu + liczba singletonów (do diagnostyki)

    /// <summary>Wykrywa typ lokalizacji w DLL projektu (publiczna, zapisywalna instancyjna
    /// <c>CurrentCulture</c>/<c>CurrentUICulture</c> typu <see cref="CultureInfo"/>) i zbiera WSZYSTKIE
    /// jego statyczne singletony (np. <c>Instance</c>, <c>PreviewInstance</c>), aby ustawić kulturę na
    /// każdym z nich. Zapamiętuje cele (taniej niż GetTypes przy każdym renderze).</summary>
    private static void DiscoverLocTarget()
    {
        _locResolved = true;
        _locTargets.Clear();
        _locTargetName = null;
        foreach (var asm in _projectAssemblies)
        {
            Type[] types;
            try { types = asm.GetTypes(); }
            catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray()!; }
            catch { continue; }
            foreach (var type in types)
            {
                try
                {
                    var cultProp = type.GetProperty("CurrentCulture", BindingFlags.Public | BindingFlags.Instance)
                                   ?? type.GetProperty("CurrentUICulture", BindingFlags.Public | BindingFlags.Instance);
                    if (cultProp == null || !cultProp.CanWrite || cultProp.PropertyType != typeof(CultureInfo)) continue;
                    var refresh = type.GetMethod("Refresh", Type.EmptyTypes);
                    // statyczne właściwości zwracające ten sam typ = singletony (Instance, PreviewInstance…)
                    foreach (var sp in type.GetProperties(BindingFlags.Public | BindingFlags.Static))
                    {
                        if (!type.IsAssignableFrom(sp.PropertyType)) continue;
                        object? inst;
                        try { inst = sp.GetValue(null); }
                        catch { continue; }
                        if (inst != null) _locTargets.Add((inst, cultProp, refresh));
                    }
                    if (_locTargets.Count > 0)
                    {
                        _locTargetName = type.FullName + " (×" + _locTargets.Count + ")";
                        return;
                    }
                }
                catch { /* ten typ się nie nadaje — próbuj dalej */ }
            }
        }
    }

    /// <summary>Ustawia kulturę na wszystkich wykrytych singletonach lokalizacji (np. DuPli
    /// <c>TranslationSource.Instance</c> i <c>.PreviewInstance</c>), by render odzwierciedlił wybór języka.</summary>
    private static void ReflectSetCulture(string culture)
    {
        if (!_locResolved) DiscoverLocTarget();
        if (_locTargets.Count == 0) return;
        CultureInfo ci;
        try { ci = string.IsNullOrEmpty(culture) ? CultureInfo.InvariantCulture : CultureInfo.GetCultureInfo(culture); }
        catch { return; }
        foreach (var (inst, prop, refresh) in _locTargets)
        {
            try
            {
                prop.SetValue(inst, ci); // setter zwykle sam odświeża bindingi (PropertyChanged)
                refresh?.Invoke(inst, null);
            }
            catch { /* ten singleton się nie nadaje — pomiń */ }
        }
    }

    private static void ApplyTheme(string theme)
    {
        _theme = theme;
        if (_theme == _appliedTheme) return;
        try
        {
            if (Application.Current != null)
            {
                // zdejmij poprzednie nakładki motywu (klasyczny + motyw-słownik projektu)
                if (_classicDict != null)
                {
                    Application.Current.Resources.MergedDictionaries.Remove(_classicDict);
                    _classicDict = null;
                }
                if (_projectThemeDict != null)
                {
                    Application.Current.Resources.MergedDictionaries.Remove(_projectThemeDict);
                    _projectThemeDict = null;
                }

                if (_theme.StartsWith(ResourceThemePrefix, StringComparison.Ordinal))
                {
                    // motyw projektu: słownik z pliku zasobów podstawiony jako aktywny motyw
                    Application.Current.ThemeMode = ThemeMode.None;
                    string path = _theme.Substring(ResourceThemePrefix.Length);
                    try
                    {
                        var rd = LoadResourceDictionary(path);
                        if (rd != null)
                        {
                            _projectThemeDict = rd;
                            Application.Current.Resources.MergedDictionaries.Add(rd);
                        }
                    }
                    catch { /* nieczytelny słownik — podgląd dziedziczy */ }
                }
                else
                {
                    Application.Current.ThemeMode = _theme switch
                    {
                        "light" => ThemeMode.Light,
                        "dark" => ThemeMode.Dark,
                        "system" => ThemeMode.System,
                        _ => ThemeMode.None,
                    };

                    if (_theme == "classic98")
                    {
                        var uri = new Uri("/PresentationFramework.Classic;component/themes/Classic.xaml", UriKind.Relative);
                        if (Application.LoadComponent(uri) is ResourceDictionary dict)
                        {
                            _classicDict = new ResourceDictionary();
                            _classicDict.MergedDictionaries.Add(dict);

                            // ControlBrush = szara „twarz" kontrolek/paneli (przyciski, GroupBox, tło okna).
                            var d4d0c8 = new SolidColorBrush(Color.FromRgb(0xd4, 0xd0, 0xc8));
                            _classicDict[SystemColors.ControlBrushKey] = d4d0c8;
                            _classicDict[SystemColors.ControlColorKey] = Color.FromRgb(0xd4, 0xd0, 0xc8);
                            // WindowBrush = białe tło „wnętrza" pól: TextBox, CheckBox/RadioButton (kwadrat/kółko),
                            // ComboBox, ListBox — jak w natywnym Windows 98 (patrz okno „Virtual Memory").
                            _classicDict[SystemColors.WindowBrushKey] = Brushes.White;
                            _classicDict[SystemColors.WindowColorKey] = Colors.White;
                            // Zaznaczenie (np. ComboBoxItem/ListBoxItem IsSelected) — granat + biały tekst,
                            // jak w Windows 98; bez tego szablon Classic używa systemowego Highlight (bywa niewidoczny).
                            var navy = Color.FromRgb(0x00, 0x00, 0x80);
                            _classicDict[SystemColors.HighlightBrushKey] = new SolidColorBrush(navy);
                            _classicDict[SystemColors.HighlightColorKey] = navy;
                            _classicDict[SystemColors.HighlightTextBrushKey] = Brushes.White;
                            _classicDict[SystemColors.HighlightTextColorKey] = Colors.White;

                            // Spłaszcz paski: domyślny szablon (Aero/Fluent) ToolBar/Menu/StatusBar ma gradient,
                            // którego sam Background nie usuwa — podstawiamy proste szablony (płaski Border).
                            var flatBars = BuildClassicBarStyles();
                            if (flatBars != null) _classicDict.MergedDictionaries.Add(flatBars);

                            Application.Current.Resources.MergedDictionaries.Add(_classicDict);
                        }
                    }
                }
            }
            _appliedTheme = _theme;
        }
        catch { /* starszy runtime bez ThemeMode */ }
    }

    /// <summary>Classic '98: płaskie style implicit pasków (ToolBar/ToolBarTray/Menu/StatusBar) — proste
    /// szablony bez gradientu Aero. Zwraca null, gdy XAML się nie sparsuje.</summary>
    private static ResourceDictionary? BuildClassicBarStyles()
    {
        const string xaml =
            @"<ResourceDictionary xmlns=""http://schemas.microsoft.com/winfx/2006/xaml/presentation""
                                  xmlns:x=""http://schemas.microsoft.com/winfx/2006/xaml"">
                <Style TargetType=""{x:Type ToolBarTray}"">
                  <Setter Property=""Background"" Value=""#FFD4D0C8""/>
                </Style>
                <Style TargetType=""{x:Type ToolBar}"">
                  <Setter Property=""Background"" Value=""#FFD4D0C8""/>
                  <Setter Property=""Template"">
                    <Setter.Value>
                      <ControlTemplate TargetType=""{x:Type ToolBar}"">
                        <Border Background=""{TemplateBinding Background}"">
                          <ToolBarPanel IsItemsHost=""True"" Margin=""2,1""/>
                        </Border>
                      </ControlTemplate>
                    </Setter.Value>
                  </Setter>
                </Style>
                <Style TargetType=""{x:Type Menu}"">
                  <Setter Property=""Background"" Value=""#FFD4D0C8""/>
                  <Setter Property=""Template"">
                    <Setter.Value>
                      <ControlTemplate TargetType=""{x:Type Menu}"">
                        <Border Background=""{TemplateBinding Background}"">
                          <ItemsPresenter/>
                        </Border>
                      </ControlTemplate>
                    </Setter.Value>
                  </Setter>
                </Style>
                <Style TargetType=""{x:Type StatusBar}"">
                  <Setter Property=""Background"" Value=""#FFD4D0C8""/>
                  <Setter Property=""Template"">
                    <Setter.Value>
                      <ControlTemplate TargetType=""{x:Type StatusBar}"">
                        <Border Background=""{TemplateBinding Background}"" BorderBrush=""#FF808080"" BorderThickness=""0,1,0,0"">
                          <ItemsPresenter/>
                        </Border>
                      </ControlTemplate>
                    </Setter.Value>
                  </Setter>
                </Style>
              </ResourceDictionary>";
        try
        {
            using var ms = new MemoryStream(Encoding.UTF8.GetBytes(xaml));
            return XamlReader.Load(ms) as ResourceDictionary;
        }
        catch
        {
            return null; // spłaszczenie pasków jest opcjonalne
        }
    }

    /// <summary>Dla motywu projektu zgaduje jasny/ciemny po nazwie pliku (jak w aplikacji desktop).
    /// Zwraca "dark"/"light" albo "" (nieokreślony → dziedzicz).</summary>
    private static string EffectiveFromResourceName(string themeOrPath)
    {
        string p = themeOrPath.StartsWith(ResourceThemePrefix, StringComparison.Ordinal)
            ? themeOrPath.Substring(ResourceThemePrefix.Length)
            : themeOrPath;
        string n = Path.GetFileNameWithoutExtension(p).ToLowerInvariant();
        if (n.Contains("dark") || n.Contains("ciemn")) return "dark";
        if (n.Contains("light") || n.Contains("jasn")) return "light";
        return "";
    }

    /// <summary>Składa tytuł okna: snapshot → „[HH:mm:ss]", na żywo → „[etykieta HH:mm:ss]".</summary>
    private static string ComposeTitle(string baseTitle, string liveLabel, bool live)
    {
        string time = DateTime.Now.ToString("HH:mm:ss");
        return live ? $"{baseTitle} [{liveLabel} {time}]" : $"{baseTitle} [{time}]";
    }

    private static void ShowRealWindow(string xaml, string theme, string filename, string iconPath, bool live, string winId, string liveLabel)
    {
        try
        {
            ApplyTheme(theme);

            // Już istnieje okno „na żywo" dla tego pliku → tylko podmień treść i wynieś na wierzch.
            if (live && !string.IsNullOrEmpty(winId)
                && _liveWindows.TryGetValue(winId, out var existing) && existing.Win.IsLoaded)
            {
                ReplaceContent(existing.Win, xaml);
                existing.Win.Title = ComposeTitle(existing.BaseTitle, existing.LiveLabel, live: true);
                existing.Win.Activate();
                return;
            }

            object parsed = ParseXaml(Sanitize(xaml));

            // baza tytułu bez nawiasu: „Tytuł - plik" (gdy Window.Title pusty → samo „plik")
            string baseTitle = parsed is Window pw && !string.IsNullOrEmpty(pw.Title)
                ? $"{pw.Title} - {filename}"
                : filename;
            string title = ComposeTitle(baseTitle, liveLabel, live);

            Window winToShow;
            FrameworkElement? content; // element, którego rozmiar = obszar klienta okna
            double designW, designH;
            bool sizeClient;

            if (parsed is Window userWinObj)
            {
                winToShow = userWinObj;
                content = userWinObj.Content as FrameworkElement;
                designW = !double.IsNaN(userWinObj.Width) && userWinObj.Width > 0 ? userWinObj.Width : 640;
                designH = !double.IsNaN(userWinObj.Height) && userWinObj.Height > 0 ? userWinObj.Height : 480;
                // klienta dopasowujemy tylko gdy autor nie używa SizeToContent i jest treść do zmierzenia
                sizeClient = userWinObj.SizeToContent == SizeToContent.Manual && content != null;
            }
            else if (parsed is FrameworkElement fe)
            {
                // UserControl/Page → opakuj w okno; rozmiar projektowy treści staje się obszarem KLIENTA.
                bool hasW = !double.IsNaN(fe.Width) && fe.Width > 0;
                bool hasH = !double.IsNaN(fe.Height) && fe.Height > 0;
                designW = hasW ? fe.Width : 640;
                designH = hasH ? fe.Height : 480;
                content = fe;
                winToShow = new Window { Content = fe };
                sizeClient = true;
            }
            else
            {
                MessageBox.Show("Root is not a FrameworkElement", "Error", MessageBoxButton.OK, MessageBoxImage.Error);
                return;
            }

            winToShow.Title = title;

            // Set window icon if path is provided and file exists
            if (!string.IsNullOrEmpty(iconPath) && File.Exists(iconPath))
            {
                try { winToShow.Icon = BitmapFrame.Create(new Uri(iconPath)); }
                catch { }
            }

            if (winToShow.ReadLocalValue(Control.BackgroundProperty) == DependencyProperty.UnsetValue)
                winToShow.Background = ThemedBackground();
            if (winToShow.ReadLocalValue(TextElement.ForegroundProperty) == DependencyProperty.UnsetValue)
                TextElement.SetForeground(winToShow, ThemedForeground());
            ApplyClassicFontDefault(winToShow);

            // OBSZAR KLIENTA = rozmiar projektowy (jak w podglądzie), a NIE rozmiar okna z chrome.
            // Pinujemy treść do designW×H i pozwalamy oknu dopasować się do treści (SizeToContent),
            // a po załadowaniu odpinamy: okno zachowuje wyliczony rozmiar zewnętrzny, treść rozciąga
            // się przy zmianie rozmiaru. Dzięki temu zawartość okna ma dokładnie wymiary z XAML.
            if (sizeClient && content != null)
            {
                var c = content;
                c.Width = designW;
                c.Height = designH;
                winToShow.SizeToContent = SizeToContent.WidthAndHeight;
                winToShow.Loaded += (_, _) =>
                {
                    winToShow.SizeToContent = SizeToContent.Manual;
                    if (!double.IsNaN(winToShow.ActualWidth)) winToShow.Width = winToShow.ActualWidth;
                    if (!double.IsNaN(winToShow.ActualHeight)) winToShow.Height = winToShow.ActualHeight;
                    c.Width = double.NaN;
                    c.Height = double.NaN;
                };
            }
            else if (winToShow.SizeToContent == SizeToContent.Manual)
            {
                if (double.IsNaN(winToShow.Width) || winToShow.Width <= 0) winToShow.Width = designW;
                if (double.IsNaN(winToShow.Height) || winToShow.Height <= 0) winToShow.Height = designH;
            }

            winToShow.WindowStartupLocation = WindowStartupLocation.CenterScreen;

            // rejestr okien „na żywo": kolejne zmiany dokumentu dosyłają updateWindow → ReplaceContent
            if (live && !string.IsNullOrEmpty(winId))
            {
                _liveWindows[winId] = new LiveWindow { Win = winToShow, BaseTitle = baseTitle, LiveLabel = liveLabel };
                winToShow.Closed += (_, _) => _liveWindows.Remove(winId);
            }

            winToShow.Show();
        }
        catch (Exception ex)
        {
            MessageBox.Show(ex.Message, "Error showing XAML", MessageBoxButton.OK, MessageBoxImage.Error);
        }
    }

    /// <summary>Podmienia treść otwartego okna nowym XAML (zachowuje rozmiar/pozycję okna).
    /// Używane przez tryb „na żywo" — treść rozciąga się do okna (Width/Height = NaN).</summary>
    private static void ReplaceContent(Window win, string xaml)
    {
        object parsed = ParseXaml(Sanitize(xaml));
        FrameworkElement? content;
        Brush? explicitBg = null;
        if (parsed is Window pw)
        {
            content = pw.Content as FrameworkElement;
            pw.Content = null; // odłącz od tymczasowo sparsowanego okna
            if (pw.ReadLocalValue(Control.BackgroundProperty) != DependencyProperty.UnsetValue)
                explicitBg = pw.Background;
        }
        else
        {
            content = parsed as FrameworkElement;
        }
        if (content == null) throw new InvalidOperationException("root is not a FrameworkElement");

        content.Width = double.NaN; // rozciągnij do bieżącego rozmiaru okna
        content.Height = double.NaN;
        if (content.ReadLocalValue(TextElement.ForegroundProperty) == DependencyProperty.UnsetValue)
            TextElement.SetForeground(content, ThemedForeground());
        ApplyClassicFontDefault(content);
        win.Content = content;
        if (explicitBg != null) win.Background = explicitBg;
    }

    /// <summary>Aktualizuje treść okna „na żywo". Zwraca ok:false „window-closed", gdy okno zamknięto
    /// (extension przestaje dosyłać) albo komunikat błędu parsowania (treść okna zostaje bez zmian).</summary>
    private static Resp UpdateLiveWindow(int id, string winId, string xaml)
    {
        if (string.IsNullOrEmpty(winId) || !_liveWindows.TryGetValue(winId, out var lw) || !lw.Win.IsLoaded)
            return new Resp { id = id, ok = false, error = "window-closed" };
        try
        {
            ApplyTheme(_theme);
            ReplaceContent(lw.Win, xaml);
            lw.Win.Title = ComposeTitle(lw.BaseTitle, lw.LiveLabel, live: true);
            return new Resp { id = id, ok = true };
        }
        catch (Exception ex)
        {
            // błędny XAML w trakcie edycji — zachowaj poprzednią treść, zgłoś pozycję błędu
            var (l, c) = ErrorPosition(ex);
            return new Resp { id = id, ok = false, error = ErrorMessage(ex), line = l, col = c };
        }
    }

    /// <summary>
    /// Wyłuskuje wiersz/kolumnę błędu z wyjątku (1-based). XamlParseException i XmlException
    /// niosą LineNumber/LinePosition; sprawdzamy też łańcuch InnerException.
    /// UWAGA: pozycje odnoszą się do tekstu PO Sanitize. Błędy składni XML (XDocument.Parse)
    /// mapują się wiernie na oryginał; błędy etapu XAML mogą być przybliżone (re-serializacja
    /// XLinq scala wieloliniowe znaczniki) — odbiorca traktuje je jako „best effort" i klampuje.
    /// </summary>
    private static (int line, int col) ErrorPosition(Exception ex)
    {
        for (Exception? e = ex; e != null; e = e.InnerException)
        {
            if (e is System.Windows.Markup.XamlParseException xpe && xpe.LineNumber > 0)
                return (xpe.LineNumber, xpe.LinePosition);
            if (e is System.Xml.XmlException xex && xex.LineNumber > 0)
                return (xex.LineNumber, xex.LinePosition);
        }
        return (0, 0);
    }

    /// <summary>Najgłębszy (najbardziej konkretny) komunikat z łańcucha wyjątków.</summary>
    private static string ErrorMessage(Exception ex)
    {
        string msg = ex.Message;
        for (Exception? e = ex.InnerException; e != null; e = e.InnerException)
            if (!string.IsNullOrWhiteSpace(e.Message)) msg = e.Message;
        return msg;
    }

    private static string Xaml(JsonElement r) => r.GetProperty("xaml").GetString() ?? "";
    private static int W(JsonElement r) => r.TryGetProperty("width", out var v) ? v.GetInt32() : 800;
    private static int H(JsonElement r) => r.TryGetProperty("height", out var v) ? v.GetInt32() : 600;

    private readonly record struct Surface(FrameworkElement root, int pxW, int pxH, string? rootUid);

    /// <summary>Parsuje + sanityzuje XAML, buduje renderowalny korzeń, mierzy/układa.</summary>
    // Tag znacznikowy korzenia opakowującego z auto-podglądem (Grid: realne drzewo + fake-panel).
    private const string RevealWrapperTag = "__xve_reveal_wrapper";

    private static Surface BuildSurface(string xaml, int width, int height, bool reveal = false, bool forDrag = false)
    {
        ApplyTheme(_theme);

        string cleaned = Sanitize(xaml);
        object parsed = ParseXaml(cleaned);
        string? rootUid = (parsed as FrameworkElement)?.Uid;
        double surfW = width, surfH = height;
        FrameworkElement rootFe;

        if (parsed is Window win)
        {
            var content = win.Content as UIElement;
            win.Content = null;
            if (!double.IsNaN(win.Width)) surfW = win.Width;
            if (!double.IsNaN(win.Height)) surfH = win.Height;
            // tło: jawne z XAML respektujemy; brak → tło wg motywu (ciemne/jasne)
            bool explicitBg = win.ReadLocalValue(Control.BackgroundProperty) != DependencyProperty.UnsetValue;
            rootFe = new Border
            {
                Width = surfW,
                Height = surfH,
                Background = explicitBg ? win.Background : ThemedBackground(),
                Child = content,
            };
            TextElement.SetForeground(rootFe, ThemedForeground());
            ApplyClassicFontDefault(rootFe);
        }
        else if (parsed is FrameworkElement fe)
        {
            rootFe = fe;
            if (!double.IsNaN(fe.Width)) surfW = fe.Width;
            if (!double.IsNaN(fe.Height)) surfH = fe.Height;
            if (fe.ReadLocalValue(TextElement.ForegroundProperty) == DependencyProperty.UnsetValue)
            {
                TextElement.SetForeground(rootFe, ThemedForeground());
            }
            ApplyClassicFontDefault(rootFe);
        }
        else
        {
            throw new InvalidOperationException("root is not a FrameworkElement");
        }

        // Parność z web: kontenery układu (Grid/StackPanel/…/Border/Viewbox) przycinają dzieci do swoich
        // granic (jak overflow:hidden). Dzięki temu element poza kontenerem nie jest ani rysowany, ani
        // klikalny (zgodnie z mapą hit-test). Canvas zostaje bez klipu — swobodne pozycje są widoczne.
        ApplyContainerClips(rootFe);

        int pxW = Math.Max(1, (int)Math.Ceiling(surfW));
        int pxH = Math.Max(1, (int)Math.Ceiling(surfH));
        rootFe.Measure(new Size(pxW, pxH));
        rootFe.Arrange(new Rect(0, 0, pxW, pxH));
        rootFe.UpdateLayout();

        // pamięć zakładek: ustaw zapamiętane TabItem (trwa niezależnie od auto-podglądu i zaznaczenia).
        // Auto-podgląd (poniżej) może to nadpisać, gdy zaznaczenie wpada w inną zakładkę tego TabControl.
        if (_tabUids.Length > 0 && ApplyTabSelections(rootFe)) rootFe.UpdateLayout();

        // funkcja 3: po layoucie znamy ScrollableHeight — zastosuj przewinięcia i prze-ułóż
        if (_scrolls.Count > 0)
        {
            ApplyScrolls(rootFe);
            rootFe.UpdateLayout();
        }

        _revealScrolled.Clear();
        bool applyReveal = reveal && _autoReveal && !string.IsNullOrEmpty(_revealUid);
        // Przeciąganie: fake-listę utrzymujemy tylko gdy ruszany jest element ZE środka listy.
        // Dla samego właściciela (ComboBox/Menu) chowamy ją na czas gestu (lista i tak „odkleiłaby się"
        // od przesuwanej kontrolki). Element z listy → lista zostaje (parzystość z trybem web).
        if (applyReveal && forDrag)
        {
            var owner = FindByUid(rootFe, _revealUid!);
            if (owner is ComboBox || owner is Menu) applyReveal = false;
        }
        if (applyReveal)
        {
            var target = FindByUid(rootFe, _revealUid!);
            if (target != null)
            {
                // auto-podgląd: przełącz na zakładkę (TabItem) zawierającą zaznaczenie — inaczej
                // niewybrana zakładka nie jest w drzewie wizualnym i element byłby niewidoczny.
                if (SelectAncestorTabs(target)) rootFe.UpdateLayout();
                // jednorazowo: przewiń ScrollViewery przodków, by wybrany element był widoczny (jak BringIntoView).
                // W trakcie gestu pomijamy — przewinięcie zrobiono już przy zmianie zaznaczenia.
                if (_revealScroll && !forDrag)
                {
                    RevealScrollTo(target, _revealScrolled);
                    rootFe.UpdateLayout();
                }
            }
        }

        // funkcja 2: auto-podgląd menu/list — dołóż „fake panel" na nakładce (opakowuje korzeń w Grid)
        FrameworkElement finalRoot = applyReveal ? ApplyAutoReveal(rootFe, pxW, pxH) : rootFe;
        return new Surface(finalRoot, pxW, pxH, rootUid);
    }

    private readonly record struct Rendered(
        string Png, double Vx, double Vy, double Vw, double Vh, int Pw, int Ph);

    private static string Encode(RenderTargetBitmap rtb)
    {
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(rtb));
        using var ms = new MemoryStream();
        enc.Save(ms);
        return Convert.ToBase64String(ms.ToArray());
    }

    /// <summary>Zwraca reużywaną bitmapę o zadanych wymiarach/DPI (Clear) albo alokuje nową.</summary>
    private static RenderTargetBitmap GetRtb(int w, int h, double dpi)
    {
        if (_rtb != null && _rtb.PixelWidth == w && _rtb.PixelHeight == h && Math.Abs(_rtb.DpiX - dpi) < 0.01)
        {
            _rtb.Clear();
            return _rtb;
        }
        return _rtb = new RenderTargetBitmap(w, h, dpi, dpi, PixelFormats.Pbgra32);
    }

    private static Rendered RenderPng(FrameworkElement root, int pxW, int pxH)
    {
        int cap = _cap > 0 ? _cap : int.MaxValue; // limit w PX URZĄDZENIA
        double scale = _scale > 0 ? _scale : 1;   // supersampling (devicePixelRatio / ustawienie)

        if (_hasVb)
        {
            // render tylko widocznego prostokąta (jednostki projektu) w skali zoom × scale.
            // VisualBrush rozciąga wycinek na większą bitmapę → supersampling (ostro po downsamplingu).
            double z = _zoom > 0 ? _zoom : 1;
            double bw0 = _vbW * z * scale;
            double bh0 = _vbH * z * scale;
            // Podstawa limitu: "visible" → licz cap wg SAMEGO widocznego obszaru (overscan renderuje się
            // w tej samej gęstości i nie zjada budżetu, więc ostrość widocznego fragmentu nie zależy od
            // rozmiaru okna). "slice" → dawne zachowanie (cap na całym wycinku z overscanem).
            double capRef = _capBasis == "visible"
                ? Math.Max(_vbVisW, _vbVisH) * z * scale
                : Math.Max(bw0, bh0);
            double capScale = Math.Min(1.0, cap / Math.Max(1.0, capRef));
            int bw = Math.Max(1, (int)Math.Round(bw0 * capScale));
            int bh = Math.Max(1, (int)Math.Round(bh0 * capScale));
            var rtb = GetRtb(bw, bh, 96);
            var dv = new DrawingVisual();
            using (var dc = dv.RenderOpen())
                dc.DrawRectangle(
                    new VisualBrush(root)
                    {
                        Viewbox = new Rect(_vbX, _vbY, _vbW, _vbH),
                        ViewboxUnits = BrushMappingMode.Absolute,
                        Stretch = Stretch.Fill,
                    },
                    null,
                    new Rect(0, 0, bw, bh));
            rtb.Render(dv);
            return new Rendered(Encode(rtb), _vbX, _vbY, _vbW, _vbH, bw, bh);
        }

        // pełna powierzchnia: jeden tor przez DPI bitmapy. sEff = scale × (ewentualny downscale do cap).
        // Render(root) rasteryzuje wektory wprost w docelowej rozdzielczości (ostre też przy skalowaniu).
        double capScaleF = Math.Min(1.0, cap / (Math.Max(pxW, pxH) * scale));
        double sEff = scale * capScaleF;
        int fw = Math.Max(1, (int)Math.Round(pxW * sEff));
        int fh = Math.Max(1, (int)Math.Round(pxH * sEff));
        var full = GetRtb(fw, fh, 96.0 * sEff);
        full.Render(root);
        return new Rendered(Encode(full), 0, 0, pxW, pxH, fw, fh);
    }

    private static Resp RenderResult(int id, Surface s, bool withRects = true)
    {
        var r = RenderPng(s.root, s.pxW, s.pxH);
        // Mapę hit-test pomijamy w klatkach drag (withRects=false): rusza się tylko przeciągany
        // element, a nakładkę zaznaczenia webview prowadzi lokalnie. Pełne rects wracają po commicie.
        List<RectInfo>? rects = null;
        if (withRects)
        {
            rects = new List<RectInfo>();
            if (!string.IsNullOrEmpty(s.rootUid) && s.rootUid!.StartsWith("u"))
                rects.Add(new RectInfo { uid = s.rootUid, x = 0, y = 0, w = s.pxW, h = s.pxH });
            Collect(s.root, s.root, rects);
        }
        return new Resp
        {
            id = id,
            ok = true,
            png = r.Png,
            width = s.pxW, // pełny logiczny rozmiar powierzchni
            height = s.pxH,
            vx = r.Vx,
            vy = r.Vy,
            vw = r.Vw,
            vh = r.Vh,
            rpw = r.Pw,
            rph = r.Ph,
            rects = rects,
            scrolled = _revealScrolled.Count > 0 ? new List<ScrollInfo>(_revealScrolled) : null,
        };
    }

    private static Resp DragUpdate(int id, string uid, JsonElement attrs)
    {
        if (_dragRoot == null || _dragMap == null)
            return new Resp { id = id, ok = false, error = "no drag session" };
        FrameworkElement? target = uid == _dragRootUid ? _dragRoot : (_dragMap.TryGetValue(uid, out var t) ? t : null);
        if (target == null) return new Resp { id = id, ok = false, error = "uid not found" };

        foreach (var p in attrs.EnumerateObject())
        {
            string val = p.Value.GetString() ?? "";
            switch (p.Name)
            {
                case "Margin":
                    target.Margin = ParseThickness(val);
                    break;
                case "Width":
                    if (double.TryParse(val, NumberStyles.Float, CultureInfo.InvariantCulture, out var w)) target.Width = w;
                    break;
                case "Height":
                    if (double.TryParse(val, NumberStyles.Float, CultureInfo.InvariantCulture, out var h)) target.Height = h;
                    break;
                case "Canvas.Left":
                    if (double.TryParse(val, NumberStyles.Float, CultureInfo.InvariantCulture, out var l)) Canvas.SetLeft(target, l);
                    break;
                case "Canvas.Top":
                    if (double.TryParse(val, NumberStyles.Float, CultureInfo.InvariantCulture, out var tp)) Canvas.SetTop(target, tp);
                    break;
            }
        }
        _dragRoot.UpdateLayout();
        return RenderResult(id, new Surface(_dragRoot, _dragW, _dragH, _dragRootUid), withRects: false);
    }

    /// <summary>Tło powierzchni zależne od motywu (gdy okno nie definiuje własnego).</summary>
    private static Brush ThemedBackground()
    {
        if (_theme == "classic98") return new SolidColorBrush(Color.FromRgb(0xd4, 0xd0, 0xc8));
        if (Application.Current != null)
        {
            try
            {
                if (Application.Current.TryFindResource("ApplicationBackgroundBrush") is Brush bgBrush)
                    return bgBrush;
            }
            catch { }
        }
        // motyw projektu bez własnego tła → zgadnij jasny/ciemny po nazwie pliku
        if (_theme.StartsWith(ResourceThemePrefix, StringComparison.Ordinal))
        {
            string eff = EffectiveFromResourceName(_theme);
            if (eff == "dark") return new SolidColorBrush(Color.FromRgb(0x20, 0x20, 0x20));
            if (eff == "light") return Brushes.White;
        }
        if (_theme == "dark") return new SolidColorBrush(Color.FromRgb(0x20, 0x20, 0x20));
        return Brushes.White;
    }

    private static Brush ThemedForeground()
    {
        if (_theme == "classic98") return Brushes.Black;
        if (Application.Current != null)
        {
            try
            {
                if (Application.Current.TryFindResource("TextFillColorPrimaryBrush") is Brush fgBrush)
                    return fgBrush;
            }
            catch { }
        }
        if (_theme.StartsWith(ResourceThemePrefix, StringComparison.Ordinal))
        {
            string eff = EffectiveFromResourceName(_theme);
            if (eff == "dark") return Brushes.White;
            if (eff == "light") return Brushes.Black;
        }
        if (_theme == "dark") return Brushes.White;
        return SystemColors.WindowTextBrush;
    }

    /// <summary>Ustawia domyślny rozmiar czcionki na korzeniu (gdy autor nie podał FontSize),
    /// odtwarzając dziedziczenie, które w prawdziwej aplikacji daje motywowane okno. Host renderuje
    /// treść w gołym Borderze (Window jest odrzucany), więc bez tego goły TextBlock spada do domyślnej
    /// czcionki WPF (≈12 px) zamiast wartości motywu:
    ///   • Fluent (light/dark): 14 px = ContentControlThemeFontSize / „Body" WinUI (Windows 11),
    ///   • classic '98: 12 px (natywny Win98).
    /// Dziedziczona TextElement.FontSize spływa na całe drzewo; kontrolki z własnym FontSize (szablony
    /// Fluent, chrom pasków) nadpisują ją. Classic/none: zostaw domyślne WPF (12 px).</summary>
    private static void ApplyClassicFontDefault(DependencyObject root)
    {
        double? defFontSize = _theme switch
        {
            "light" or "dark" => 14.0,
            "classic98" => 12.0,
            _ => null,
        };
        if (defFontSize is double fs && root.ReadLocalValue(TextElement.FontSizeProperty) == DependencyProperty.UnsetValue)
            TextElement.SetFontSize(root, fs);
        if (_theme != "classic98") return;
        // Classic '98: brak zaokrągleń — wyzeruj CornerRadius wszystkich Borderów z XAML autora (Win98 = kwadratowe)
        void Walk(DependencyObject d)
        {
            if (d is Border b) b.CornerRadius = new CornerRadius(0);
            foreach (var child in LogicalTreeHelper.GetChildren(d))
                if (child is DependencyObject dc) Walk(dc);
        }
        Walk(root);
    }

    private static Thickness ParseThickness(string v)
    {
        var p = v.Split(',');
        double D(int i) => i < p.Length && double.TryParse(p[i].Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var d) ? d : 0;
        if (p.Length == 1) return new Thickness(D(0));
        if (p.Length == 2) return new Thickness(D(0), D(1), D(0), D(1));
        return new Thickness(D(0), D(1), D(2), D(3));
    }

    private static Dictionary<string, FrameworkElement> BuildUidMap(FrameworkElement root)
    {
        var map = new Dictionary<string, FrameworkElement>();
        void Walk(DependencyObject d)
        {
            foreach (var child in LogicalTreeHelper.GetChildren(d))
            {
                if (child is FrameworkElement fe)
                {
                    if (!string.IsNullOrEmpty(fe.Uid)) map[fe.Uid] = fe;
                    Walk(fe);
                }
                else if (child is DependencyObject dch)
                {
                    Walk(dch);
                }
            }
        }
        Walk(root);
        return map;
    }

    private static string Sanitize(string xaml)
    {
        // BOM jako znak w stringu (nie strumieniu) psuje XDocument.Parse („Data at root level invalid")
        if (xaml.Length > 0 && xaml[0] == '﻿') xaml = xaml.Substring(1);
        xaml = QualifyClrNamespaces(xaml); // clr-namespace bez assembly → ;assembly=<biblioteka projektu>
        xaml = RewritePackUris(xaml); // pack://application → pliki w katalogu projektu
        var types = _typeIndex ??= BuildTypeIndex();
        var doc = XDocument.Parse(xaml, LoadOptions.PreserveWhitespace);
        // Konwersja StaticResource→DynamicResource TYLKO gdy nie załadowano zasobów projektu (podgląd
        // „goły"), by brakujące zasoby nie wywalały parsera. Gdy zasoby SĄ — StaticResource rozwiązujemy
        // natywnie (DynamicResource psułby właściwości nie-DP: Style.BasedOn, Binding.Converter, …).
        bool resourcesLoaded = _projectAssemblies.Count > 0 || _projectDicts.Count > 0;
        var definedKeys = resourcesLoaded ? null : CollectDefinedKeys(doc);
        foreach (var el in doc.Descendants().ToList())
        {
            Type? type = types.TryGetValue(el.Name.LocalName, out var t) ? t : null;
            foreach (var attr in el.Attributes().ToList())
            {
                if (attr.IsNamespaceDeclaration) continue;
                var an = attr.Name;
                if (an.Namespace == XamlNs && (an.LocalName is "Class" or "Subclass" or "ClassModifier"))
                {
                    attr.Remove();
                    continue;
                }
                if (an.Namespace == XNamespace.None && type != null && type.GetEvent(an.LocalName) != null)
                {
                    attr.Remove();
                    continue;
                }
                // zdarzenie dołączone (attached event): nazwa „Owner.Member", np. „Thumb.DragStarted",
                // „Mouse.MouseDown". Bez tego XamlReader (loose XAML, brak code-behind) próbuje związać
                // metodę handlera i wywala „Cannot bind to the target method…". UWAGA: nie ruszamy
                // właściwości dołączonych (Grid.Row, ScrollViewer.HorizontalScrollBarVisibility) —
                // usuwamy tylko gdy Owner ma ZDARZENIE o tej nazwie.
                int dotIdx = an.LocalName.LastIndexOf('.');
                if (dotIdx > 0)
                {
                    string ownerName = an.LocalName.Substring(0, dotIdx);
                    string memberName = an.LocalName.Substring(dotIdx + 1);
                    if (types.TryGetValue(ownerName, out var ownerType) && ownerType.GetEvent(memberName) != null)
                    {
                        attr.Remove();
                        continue;
                    }
                }
                // tylko proste, nieznane klucze (typowe `{x:Type ..}` nie pasują do regexu → zostają)
                if (definedKeys != null && attr.Value.Contains("{StaticResource"))
                    attr.Value = StaticResRegex.Replace(attr.Value, m =>
                        definedKeys.Contains(m.Groups[1].Value.Trim())
                            ? m.Value
                            : "{DynamicResource " + m.Groups[1].Value + "}");
            }
        }
        return doc.ToString(SaveOptions.DisableFormatting);
    }

    private static void Collect(DependencyObject d, FrameworkElement root, List<RectInfo> rects)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(d))
        {
            if (child is FrameworkElement fe)
            {
                bool isBlock = fe.Uid == "block";
                if (!string.IsNullOrEmpty(fe.Uid) && (fe.Uid.StartsWith("u") || isBlock))
                {
                    try
                    {
                        var tr = fe.TransformToAncestor(root);
                        var r = tr.TransformBounds(new Rect(0, 0, fe.ActualWidth, fe.ActualHeight));
                        // przytnij do widoczności (ScrollViewer/ClipToBounds/kontenery) — element poza klipem
                        // nie jest klikalny (parność z web elementFromPoint).
                        var vis = ClipToAncestors(fe, r, root);
                        bool fullyClipped = vis.Width < 0.5 || vis.Height < 0.5;
                        // częściowo przycięty: widoczny prostokąt mniejszy niż realny choć na jednym boku
                        bool partlyClipped = !fullyClipped &&
                            (vis.X > r.X + 0.5 || vis.Y > r.Y + 0.5 || vis.Right < r.Right - 0.5 || vis.Bottom < r.Bottom - 0.5);
                        // Tło fake-panelu pomijamy gdy przycięte; realny element wysyłamy ZAWSZE (ma sensowne granice) —
                        // nawet całkiem przycięty, by dało się go zaznaczyć z drzewka/kodu i pokazać ramką + narzędziami.
                        bool emit = isBlock ? !fullyClipped : (r.Width >= 0.5 && r.Height >= 0.5);
                        if (emit)
                        {
                            var ri = new RectInfo
                            {
                                uid = fe.Uid,
                                // widoczne granice → hit-test/klik (puste gdy całkiem przycięty)
                                x = fullyClipped ? 0 : vis.X,
                                y = fullyClipped ? 0 : vis.Y,
                                w = fullyClipped ? 0 : vis.Width,
                                h = fullyClipped ? 0 : vis.Height,
                                block = isBlock,
                                // przycięty (całkiem lub częściowo) → ramka przerywana na realnych granicach
                                clipped = !isBlock && (fullyClipped || partlyClipped),
                                // realne granice → ramka zaznaczenia + przesuwanie/skalowanie dla niewidocznych
                                rx = r.X, ry = r.Y, rw = r.Width, rh = r.Height,
                            };
                            // funkcja 3: oznacz przewijalne ScrollViewery (webview kieruje na nie kółko)
                            if (fe is ScrollViewer sv && (sv.ScrollableHeight > 0 || sv.ScrollableWidth > 0))
                            {
                                ri.scroll = true;
                                ri.sw = sv.ScrollableWidth;
                                ri.sh = sv.ScrollableHeight;
                            }
                            rects.Add(ri);
                        }
                    }
                    catch { /* poza drzewem — pomiń */ }
                }
                Collect(fe, root, rects);
            }
            else if (child is DependencyObject dch)
            {
                Collect(dch, root, rects);
            }
        }
    }

    // Ustawia ClipToBounds na kontenerach układu (przed Measure, na drzewie logicznym = elementy z XAML,
    // bez wnętrz szablonów). Canvas pomijany — dopuszcza swobodny overflow (jak w web).
    private static void ApplyContainerClips(DependencyObject d)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(d))
        {
            if (child is FrameworkElement fe)
            {
                if ((fe is Panel && fe is not Canvas) || fe is Border || fe is Viewbox) fe.ClipToBounds = true;
                ApplyContainerClips(fe);
            }
            else if (child is DependencyObject dch) ApplyContainerClips(dch);
        }
    }

    // Kontenery, które przycinają dzieci do swoich granic — parność z web (overflow:hidden na
    // Grid/StackPanel/DockPanel/WrapPanel/Border/Viewbox/ScrollViewer). Canvas NIE przycina (jak w web),
    // więc swobodne/ujemne pozycje na Canvasie pozostają widoczne i klikalne.
    private static bool ClipsChildren(DependencyObject a)
        => a is ScrollViewer
           || (a is FrameworkElement fe && fe.ClipToBounds)
           || (a is Panel && a is not Canvas)
           || a is Border
           || a is Viewbox;

    // Przycina prostokąt elementu do widocznego obszaru przodków, które klipują (patrz ClipsChildren).
    // Element całkiem poza klipem → pusty prostokąt (zostanie pominięty), więc nie da się go zaznaczyć „przez" klip.
    private static Rect ClipToAncestors(FrameworkElement fe, Rect r, FrameworkElement root)
    {
        DependencyObject? a = VisualTreeHelper.GetParent(fe);
        while (a != null && !ReferenceEquals(a, root))
        {
            if (a is FrameworkElement afe && ClipsChildren(a))
            {
                try
                {
                    var ar = afe.TransformToAncestor(root).TransformBounds(new Rect(0, 0, afe.ActualWidth, afe.ActualHeight));
                    r = Rect.Intersect(r, ar);
                    if (r.IsEmpty) return r;
                }
                catch { /* poza wspólnym drzewem — pomiń ten klip */ }
            }
            a = VisualTreeHelper.GetParent(a);
        }
        return r;
    }

    // ---------- funkcja 3: przewijanie ScrollViewer ----------

    // Ustawia offset każdego ScrollViewer-a, którego uid przysłano w `scrolls` (clamp do zakresu).
    private static void ApplyScrolls(DependencyObject root)
    {
        foreach (var child in LogicalTreeHelper.GetChildren(root))
        {
            if (child is ScrollViewer sv && !string.IsNullOrEmpty(sv.Uid) && _scrolls.TryGetValue(sv.Uid, out var off))
            {
                sv.ScrollToHorizontalOffset(Math.Max(0, Math.Min(off.H, sv.ScrollableWidth)));
                sv.ScrollToVerticalOffset(Math.Max(0, Math.Min(off.V, sv.ScrollableHeight)));
            }
            if (child is DependencyObject d) ApplyScrolls(d);
        }
    }

    // Przewija każdy ScrollViewer-przodek minimalnie, by `target` był widoczny (jak FrameworkElement.BringIntoView).
    // Zwraca końcowe offsety (uid → h,v), by extension utrwalił je w mapie `scrolls` i zsynchronizował webview.
    private static void RevealScrollTo(FrameworkElement target, List<ScrollInfo> outList)
    {
        DependencyObject? cur = LogicalTreeHelper.GetParent(target) ?? VisualTreeHelper.GetParent(target);
        while (cur != null)
        {
            if (cur is ScrollViewer sv && !ReferenceEquals(sv.Content, target))
            {
                // gdy zaznaczono samą zawartość ScrollViewera (np. StackPanel większy niż viewport),
                // nie przewijamy go — nie ma czego „odsłaniać", scroll zostaje na swoim miejscu.
                // Dzieci panelu mają rodzica = panel (nie ScrollViewer), więc nadal są odsłaniane.
                try
                {
                    // pozycja elementu w układzie współrzędnych viewportu ScrollViewera (uwzględnia bieżący scroll)
                    var tr = target.TransformToAncestor(sv).TransformBounds(new Rect(0, 0, target.ActualWidth, target.ActualHeight));
                    double v = sv.VerticalOffset;
                    if (tr.Top < 0) v += tr.Top; // wystaje górą → przewiń w górę
                    else if (tr.Bottom > sv.ViewportHeight) v += tr.Bottom - sv.ViewportHeight; // dołem → w dół
                    v = Math.Max(0, Math.Min(v, sv.ScrollableHeight));
                    double h = sv.HorizontalOffset;
                    if (tr.Left < 0) h += tr.Left;
                    else if (tr.Right > sv.ViewportWidth) h += tr.Right - sv.ViewportWidth;
                    h = Math.Max(0, Math.Min(h, sv.ScrollableWidth));
                    if (Math.Abs(v - sv.VerticalOffset) > 0.5 || Math.Abs(h - sv.HorizontalOffset) > 0.5)
                    {
                        sv.ScrollToVerticalOffset(v);
                        sv.ScrollToHorizontalOffset(h);
                        sv.UpdateLayout(); // by transform dla kolejnego (zewnętrznego) ScrollViewera był aktualny
                    }
                    if (!string.IsNullOrEmpty(sv.Uid) && sv.Uid.StartsWith("u"))
                        outList.Add(new ScrollInfo { uid = sv.Uid, h = sv.HorizontalOffset, v = sv.VerticalOffset });
                }
                catch { /* poza drzewem — pomiń */ }
            }
            cur = LogicalTreeHelper.GetParent(cur) ?? VisualTreeHelper.GetParent(cur);
        }
    }

    // ---------- funkcja 2: auto-podgląd menu/list (kaskada „fake", port ShowFakeMenuCascade/ShowFakeCombo) ----------
    // Realne kontenery z szablonu motywu (ComboBoxItem) dla ComboBox; ręcznie budowane wiersze (FakeMenuRow)
    // dla Menu — prawdziwy Popup nie zrenderuje się do RenderTargetBitmap (osobne okno), więc imitujemy go
    // wiernie na nakładce Canvas. Każdy wiersz dostaje x:Uid źródłowego elementu → klikalny/zaznaczalny ramką.

    private readonly record struct FakeTheme(bool Dark, bool Fluent, Brush Text, Brush Gesture, Brush Bg, Brush MenuBg, Brush Border, Brush Sep, Brush Open, FontFamily Font, double FontSize, double Corner);

    private static FakeTheme ThemeOf(Control src)
    {
        var fg = (src.Foreground as SolidColorBrush)?.Color ?? Colors.Black;
        bool dark = 0.299 * fg.R + 0.587 * fg.G + 0.114 * fg.B > 140; // jasny tekst ⇒ ciemny motyw
        bool fluent = _theme is "light" or "dark" or "system"; // Fluent (WinUI) — reszta klasyczna/natywna
        double corner = _theme is "none" or "classic98" ? 0 : 8; // Fluent ma zaokrąglone listy/menu
        // tło list/combo = białe pole (jak ComboBox/ListBox); tło MENU w Classic '98 = szare (#d4d0c8),
        // jak w Windows 98 (menu szare, listy białe) — w pozostałych motywach menu = tło listy.
        Brush listBg = dark ? new SolidColorBrush(Color.FromRgb(0x2B, 0x2B, 0x2B)) : Brushes.White;
        Brush menuBg = _theme == "classic98" ? new SolidColorBrush(Color.FromRgb(0xD4, 0xD0, 0xC8)) : listBg;
        return new FakeTheme(
            dark,
            fluent,
            src.Foreground ?? Brushes.Black,
            new SolidColorBrush(Color.FromArgb(0x99, fg.R, fg.G, fg.B)),
            listBg,
            menuBg,
            new SolidColorBrush(dark ? Color.FromRgb(0x55, 0x55, 0x55) : Color.FromRgb(0xAD, 0xAD, 0xAD)),
            new SolidColorBrush(dark ? Color.FromRgb(0x55, 0x55, 0x55) : Color.FromRgb(0xD0, 0xD0, 0xD0)),
            new SolidColorBrush(Color.FromArgb(0x33, 0x00, 0x7A, 0xCC)),
            src.FontFamily,
            src.FontSize > 0 ? src.FontSize : 12,
            corner);
    }

    private static Border MakeFakePanel(UIElement child, in FakeTheme t, double minW, Brush? bg = null) => new()
    {
        Uid = "block", // znacznik: klik w tło panelu (poza wierszem) nie ma zaznaczać elementu pod spodem
        Background = bg ?? t.Bg,
        BorderBrush = t.Border,
        BorderThickness = new Thickness(1),
        CornerRadius = new CornerRadius(t.Corner),
        MinWidth = minW,
        SnapsToDevicePixels = true,
        Effect = new DropShadowEffect { Color = Colors.Black, BlurRadius = 6, ShadowDepth = 2, Opacity = 0.35 },
        Child = child,
    };

    // Owija treść panelu w ScrollViewer (pionowy pasek „Auto"). Po ograniczeniu wysokości panelu
    // (MaxHeight) nadmiar pozycji jest dostępny przez przewijanie — jak prawdziwy popup/menu WPF,
    // który mieści się na ekranie i pokazuje pasek, gdy elementów jest za dużo.
    private static ScrollViewer ScrollWrap(UIElement content) => new()
    {
        VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
        HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
        Content = content,
    };

    // Syntetyczne uid dla ScrollViewera nakładki (lista/menu) z uid właściciela ("u"+id) — by webview
    // mógł kierować na panel kółko i utrwalać jego scroll. null, gdy właściciel nie ma numerycznego uid.
    private static string? TryFakeUid(FrameworkElement owner) =>
        owner.Uid is { Length: > 1 } u && u[0] == 'u' && int.TryParse(u.AsSpan(1), out var oid)
            ? "u" + (FakeScrollBase + oid)
            : null;

    // Przewinięcie nakładkowego ScrollViewera przy budowie panelu (pre-grid — daje poprawną kotwicę
    // podmenu w kaskadzie menu). Zmiana zaznaczenia: przewiń do `bring` i utrwal/echuj offset; inaczej
    // nałóż zapamiętaną pozycję z kółka. Wymaga już ułożonego panelu (Arrange). RevealFakeScroll()
    // ponawia to samo PO finalnym layoucie (pewniejszy moment dla BringIntoView).
    private static void ApplyFakeScroll(ScrollViewer sv, string? fakeUid, FrameworkElement? bring)
    {
        if (sv.ScrollableHeight <= 0 && sv.ScrollableWidth <= 0) return;
        if (_revealScroll && bring != null)
        {
            bring.BringIntoView();
            sv.UpdateLayout();
            if (fakeUid != null)
            {
                _scrolls[fakeUid] = (sv.HorizontalOffset, sv.VerticalOffset);
                _revealScrolled.Add(new ScrollInfo { uid = fakeUid, h = sv.HorizontalOffset, v = sv.VerticalOffset });
            }
            return;
        }
        if (fakeUid != null && _scrolls.TryGetValue(fakeUid, out var off))
        {
            sv.ScrollToHorizontalOffset(Math.Max(0, Math.Min(off.H, sv.ScrollableWidth)));
            sv.ScrollToVerticalOffset(Math.Max(0, Math.Min(off.V, sv.ScrollableHeight)));
            sv.UpdateLayout();
        }
    }

    // Po finalnym layoucie: przy zmianie zaznaczenia przewiń nakładkowy ScrollViewer tak, by zaznaczona
    // pozycja (`_fakeRevealTarget`) była widoczna — jak reveal realnego ScrollViewera — i utrwal/echuj
    // nowy offset (nadpisując pozycję z kółka). Inne rendery zostawiają scroll bez zmian.
    private static void RevealFakeScroll()
    {
        if (!_revealScroll || _fakeRevealTarget == null) return;
        ScrollViewer? sv = null;
        for (DependencyObject? a = _fakeRevealTarget; a != null; a = VisualTreeHelper.GetParent(a))
            if (a is ScrollViewer s) { sv = s; break; }
        if (sv == null || (sv.ScrollableHeight <= 0 && sv.ScrollableWidth <= 0)) return;
        _fakeRevealTarget.BringIntoView();
        sv.UpdateLayout();
        if (!string.IsNullOrEmpty(sv.Uid) && sv.Uid.StartsWith("u"))
        {
            _scrolls[sv.Uid] = (sv.HorizontalOffset, sv.VerticalOffset);
            _revealScrolled.Add(new ScrollInfo { uid = sv.Uid, h = sv.HorizontalOffset, v = sv.VerticalOffset });
        }
    }

    // Separator: cienka linia w środku klikalnego paska (Height=9). Uid źródłowego elementu → hit-test/selekcja
    // (jak pozycje menu); bez uid zwraca samą linię (np. gdy element nie ma x:Uid).
    private static Border FakeSeparator(in FakeTheme t, double indent, string? uid = null)
    {
        double vpad = t.Fluent ? 6 : 4; // Fluent — luźniejszy separator (parzystość z odstępami wierszy)
        var line = new Border { Height = 1, Margin = new Thickness(indent, vpad, 4, vpad), Background = t.Sep };
        if (string.IsNullOrEmpty(uid)) return line;
        return new Border { Uid = uid, Background = Brushes.Transparent, Child = line };
    }

    // Nagłówek z obsługą access-key WPF: pierwszy pojedynczy `_` znika i podkreśla następną literę (`__`→`_`).
    private static TextBlock AccelHeader(string s, Brush fg, FontFamily font, double size)
    {
        var tb = new TextBlock { Foreground = fg, FontFamily = font, FontSize = size };
        for (int i = 0; i < s.Length; i++)
        {
            if (s[i] == '_' && i + 1 < s.Length)
            {
                if (s[i + 1] == '_') { tb.Inlines.Add(new Run("_")); i++; continue; }
                tb.Inlines.Add(new Run(s[i + 1].ToString()) { TextDecorations = TextDecorations.Underline });
                tb.Inlines.Add(new Run(s.Substring(i + 2)));
                return tb;
            }
            tb.Inlines.Add(new Run(s[i].ToString()));
        }
        return tb;
    }

    // Wiersz menu: po lewej kolumna ikony/✓ (zaznaczone) | nagłówek (accel) | po prawej gest / ▸ (pod-pozycje).
    // `leftPad` = szerokość lewej kolumny (przestrzeń na ✓): klasyk/natywny zawsze szeroki, Fluent szeroki
    // tylko gdy panel ma pozycje IsCheckable (bez nich Fluent jest węższy jak lista ComboBox — parzystość WPF).
    private static Border FakeMenuRow(MenuItem mi, in FakeTheme t, double leftPad)
    {
        var font = mi.FontFamily ?? t.Font;
        double fontSize = mi.FontSize > 0 ? mi.FontSize : t.FontSize;
        var fg = mi.Foreground ?? t.Text;
        double vpad = t.Fluent ? 7 : 3; // Fluent ma luźniejsze odstępy pionowe między pozycjami
        var grid = new Grid { Margin = new Thickness(0, vpad, 12, vpad) };
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(leftPad) }); // ikona/✓
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = new GridLength(1, GridUnitType.Star) }); // nagłówek
        grid.ColumnDefinitions.Add(new ColumnDefinition { Width = GridLength.Auto }); // gest/▸
        if (mi.IsCheckable && mi.IsChecked)
        {
            var chk = new TextBlock { Text = "✓", Foreground = fg, FontFamily = font, FontSize = fontSize, HorizontalAlignment = HorizontalAlignment.Center };
            Grid.SetColumn(chk, 0);
            grid.Children.Add(chk);
        }
        var head = AccelHeader(mi.Header?.ToString() ?? "", fg, font, fontSize);
        head.FontWeight = mi.FontWeight;
        head.FontStyle = mi.FontStyle;
        Grid.SetColumn(head, 1);
        var gest = new TextBlock { Text = mi.HasItems ? "▸" : mi.InputGestureText ?? "", Foreground = t.Gesture, FontFamily = font, FontSize = fontSize, Margin = new Thickness(24, 0, 0, 0) };
        Grid.SetColumn(gest, 2);
        grid.Children.Add(head);
        grid.Children.Add(gest);
        var row = new Border { Background = Brushes.Transparent, Child = grid };
        if (!string.IsNullOrEmpty(mi.Uid)) row.Uid = mi.Uid; // hit-test/selekcja w PNG
        return row;
    }

    // Kopiuje na klon (ComboBoxItem) właściwości wpływające na wygląd, jak ustawiono na realnej pozycji.
    private static void CopyItemProps(Control src, Control target)
    {
        target.Margin = src.Margin;
        target.Padding = src.Padding;
        target.MinWidth = src.MinWidth;
        target.MinHeight = src.MinHeight;
        target.FontFamily = src.FontFamily;
        target.FontSize = src.FontSize > 0 ? src.FontSize : target.FontSize;
        target.FontWeight = src.FontWeight;
        target.FontStyle = src.FontStyle;
        if (src.Foreground != null) target.Foreground = src.Foreground;
        target.HorizontalContentAlignment = src.HorizontalContentAlignment;
        target.VerticalContentAlignment = src.VerticalContentAlignment;
    }

    private static string ItemText(object? it) => it switch
    {
        ComboBoxItem cbi => cbi.Content?.ToString() ?? "",
        MenuItem mi => mi.Header?.ToString() ?? "",
        ContentControl cc => cc.Content?.ToString() ?? "",
        _ => it?.ToString() ?? "",
    };

    /// <summary>Ustawia IsSelected na zapamiętanych zakładkach (uid TabItem). Zwraca true, gdy coś zmieniono.</summary>
    private static bool ApplyTabSelections(FrameworkElement root)
    {
        bool changed = false;
        foreach (var uid in _tabUids)
            if (FindByUid(root, uid) is TabItem { IsSelected: false } ti) { ti.IsSelected = true; changed = true; }
        return changed;
    }

    /// <summary>Aktywuje (IsSelected) wszystkie zakładki TabItem na ścieżce przodków celu — by zaznaczony
    /// element znalazł się w widocznej zakładce. Zwraca true, gdy coś przełączono (potrzebny re-layout).</summary>
    private static bool SelectAncestorTabs(DependencyObject target)
    {
        bool changed = false;
        for (DependencyObject? d = target; d != null; d = LogicalTreeHelper.GetParent(d) ?? VisualTreeHelper.GetParent(d))
            if (d is TabItem { IsSelected: false } ti) { ti.IsSelected = true; changed = true; }
        return changed;
    }

    private static T? FindAncestor<T>(DependencyObject start, bool stopAtMenu) where T : class
    {
        DependencyObject? d = start;
        while (d != null)
        {
            if (d is T t) return t;
            if (stopAtMenu && (d is MenuItem || d is Menu)) return null;
            d = LogicalTreeHelper.GetParent(d) ?? VisualTreeHelper.GetParent(d);
        }
        return null;
    }

    // Dokłada nakładkę z rozwiniętą listą/menu dla wybranego elementu; zwraca opakowany korzeń (Grid).
    private static FrameworkElement ApplyAutoReveal(FrameworkElement rootFe, int pxW, int pxH)
    {
        if (string.IsNullOrEmpty(_revealUid)) return rootFe;
        var target = FindByUid(rootFe, _revealUid!);
        if (target == null) return rootFe;

        _fakeRevealTarget = null; // ustawiany przy budowie nakładki; odsłaniany po layoucie
        var canvas = new Canvas { Width = pxW, Height = pxH, IsHitTestVisible = false };
        var combo = target as ComboBox ?? FindAncestor<ComboBox>(target, stopAtMenu: true);
        bool any = combo != null
            ? BuildComboCascade(combo, rootFe, canvas, pxW, pxH)
            : BuildMenuCascade(target, rootFe, canvas, pxW, pxH);
        if (!any) return rootFe;

        var grid = new Grid { Width = pxW, Height = pxH, Tag = RevealWrapperTag };
        grid.Children.Add(rootFe);
        grid.Children.Add(canvas);
        grid.Measure(new Size(pxW, pxH));
        grid.Arrange(new Rect(0, 0, pxW, pxH));
        grid.UpdateLayout();
        // Po finalnym layoucie znamy ScrollableHeight nakładkowych ScrollViewerów — zastosuj na nich
        // zapamiętany offset kółka (funkcja 3) jeszcze raz, by na pewno utrzymał się w wyrenderowanym PNG.
        if (_scrolls.Count > 0)
        {
            ApplyScrolls(canvas);
            grid.UpdateLayout();
        }
        // reveal do zaznaczonej pozycji fake-listy — PO finalnym layoucie (nadpisuje pozycję z kółka)
        RevealFakeScroll();
        grid.UpdateLayout();
        return grid;
    }

    /// <summary>Realne drzewo wewnątrz korzenia z auto-podglądem (gdy opakowano w Grid z fake-panelem);
    /// inaczej zwraca podany korzeń. Mapa uid do przeciągania budowana jest z tego drzewa, by trafiać
    /// w prawdziwe elementy, a nie w syntetyczne pozycje fake-listy (te mają zduplikowane uid).</summary>
    private static FrameworkElement RevealInnerRoot(FrameworkElement root)
        => root is Grid g && (g.Tag as string) == RevealWrapperTag && g.Children.Count > 0 && g.Children[0] is FrameworkElement inner
            ? inner
            : root;

    // Lista ComboBox: realne ComboBoxItem (prawdziwy template/motyw) + separatory, pozycjonowana pod kontrolką.
    private static bool BuildComboCascade(ComboBox combo, FrameworkElement rootFe, Canvas canvas, int pxW, int pxH)
    {
        if (combo.Items.Count == 0) return false;
        Rect anchor;
        try { anchor = combo.TransformToAncestor(rootFe).TransformBounds(new Rect(0, 0, combo.ActualWidth, combo.ActualHeight)); }
        catch { return false; }
        var t = ThemeOf(combo);
        var list = new StackPanel();
        FrameworkElement? revealEl = null; // pozycja/separator zaznaczony w edytorze
        ComboBoxItem? currentCi = null;    // bieżąca wartość (gdy zaznaczono samą kontrolkę)
        int idx = 0;
        foreach (var item in combo.Items)
        {
            bool isCurrent = idx++ == combo.SelectedIndex;
            var itemUid = (item as FrameworkElement)?.Uid;
            if (item is Separator)
            {
                var sep = FakeSeparator(t, 4, itemUid);
                list.Children.Add(sep);
                if (!string.IsNullOrEmpty(itemUid) && itemUid == _revealUid) revealEl = sep;
                continue;
            }
            var ci = new ComboBoxItem { Content = ItemText(item), HorizontalContentAlignment = HorizontalAlignment.Stretch };
            if (item is Control c) CopyItemProps(c, ci);
            if (!string.IsNullOrEmpty(itemUid))
            {
                ci.Uid = itemUid; // selekcja
                if (itemUid == _revealUid) revealEl = ci;
            }
            // bieżąca wartość: IsSelected → szablon motywu rysuje wskaźnik (Fluent: kreska).
            // W motywach klasycznych szablon nie pokazuje zaznaczenia (trigger używa statycznego
            // SystemColors.Highlight), więc wymuszamy lokalnie granat+biały (wartość lokalna > trigger).
            if (isCurrent)
            {
                ci.IsSelected = true;
                currentCi = ci;
                // Tylko classic98: jego szablon (Classic.xaml) honoruje TemplateBinding Background, więc
                // granat+biały działa. W „none"/Fluent szablon ignoruje Background — zostawiamy IsSelected
                // (inaczej sam biały Foreground byłby niewidoczny).
                if (_theme == "classic98")
                {
                    ci.Background = new SolidColorBrush(Color.FromRgb(0x00, 0x00, 0x80));
                    ci.Foreground = Brushes.White;
                }
            }
            list.Children.Add(ci);
        }
        var scroller = ScrollWrap(list);
        var panel = MakeFakePanel(scroller, t, Math.Max(combo.ActualWidth, 60));
        panel.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
        double pw = Math.Max(panel.DesiredSize.Width, combo.ActualWidth), ph = panel.DesiredSize.Height;
        // mieści się w dół albo niżej jest więcej miejsca → rozwiń w dół; inaczej w górę (jak WPF)
        double spaceBelow = pxH - anchor.Bottom, spaceAbove = anchor.Top;
        double left = anchor.Left, top, maxH;
        if (ph <= spaceBelow || spaceBelow >= spaceAbove) { top = anchor.Bottom; maxH = spaceBelow; }
        else { maxH = spaceAbove; top = Math.Max(0, anchor.Top - Math.Min(ph, maxH)); }
        if (ph > maxH)
        {
            panel.MaxHeight = Math.Max(0, maxH); // ogranicz i włącz przewijanie
            double sb = SystemParameters.VerticalScrollBarWidth;
            panel.MinWidth = pw + sb; // miejsce na pasek, by nie przyciął tekstu
            pw += sb;
        }
        if (left + pw > pxW) left = Math.Max(0, pxW - pw);
        Canvas.SetLeft(panel, left);
        Canvas.SetTop(panel, Math.Max(0, top));
        canvas.Children.Add(panel);
        // przewijanie kółkiem (funkcja 3); reveal do zaznaczonej/bieżącej pozycji robi RevealFakeScroll() po layoucie
        if (ph > maxH)
        {
            var fakeUid = TryFakeUid(combo);
            if (fakeUid != null) scroller.Uid = fakeUid;
            panel.Measure(new Size(pw, maxH));
            panel.Arrange(new Rect(0, 0, pw, maxH)); // ułóż przy ograniczonej wysokości → scroll działa
            var bring = revealEl ?? currentCi;
            ApplyFakeScroll(scroller, fakeUid, bring);
            _fakeRevealTarget = bring; // ponowny reveal po finalnym layoucie
        }
        return true;
    }

    // Kaskada menu: łańcuch MenuItem od paska do zaznaczenia (z danych logicznych). Poziom 0 pod kotwicą,
    // podmenu w prawo od podświetlonego wiersza rodzica. Wiersz wybranego elementu dostaje ramkę (przez uid).
    private static bool BuildMenuCascade(FrameworkElement target, FrameworkElement rootFe, Canvas canvas, int pxW, int pxH)
    {
        var chain = new List<MenuItem>();
        DependencyObject? d = target;
        while (d != null)
        {
            if (d is MenuItem mi) chain.Add(mi);
            if (d is Menu) break;
            d = LogicalTreeHelper.GetParent(d) ?? VisualTreeHelper.GetParent(d);
        }
        if (chain.Count == 0) return false;
        chain.Reverse(); // top-down: [pozycja paska ... zaznaczenie]
        var anchorMi = chain[0];
        Rect prev;
        try { prev = anchorMi.TransformToAncestor(rootFe).TransformBounds(new Rect(0, 0, anchorMi.ActualWidth, anchorMi.ActualHeight)); }
        catch { return false; }
        var t = ThemeOf(anchorMi);
        // Fluent dopasowuje szerokość do treści (bez sztywnego minimum); klasyk/natywny ma szersze menu.
        double minW = t.Fluent ? anchorMi.ActualWidth : Math.Max(anchorMi.ActualWidth, 180);
        bool any = false;

        for (int i = 0; i < chain.Count; i++)
        {
            var node = chain[i];
            if (node.Items.Count == 0) break; // liść
            var nextNode = i + 1 < chain.Count ? chain[i + 1] : null;

            // lewa kolumna ikony/✓: klasyk/natywny zawsze szeroka; Fluent szeroka tylko gdy panel ma
            // pozycje IsCheckable (bez nich Fluent jest węższy jak lista ComboBox) — przestrzeń na ✓.
            bool anyCheckable = node.Items.OfType<MenuItem>().Any(m => m.IsCheckable);
            double leftPad = !t.Fluent || anyCheckable ? 28 : 12;

            var list = new StackPanel();
            Border? nextRow = null;
            FrameworkElement? selectedRow = null; // wiersz/separator zaznaczony w edytorze (w tym panelu)
            foreach (var item in node.Items)
            {
                var itemUid = (item as FrameworkElement)?.Uid;
                if (item is Separator)
                {
                    var sep = FakeSeparator(t, leftPad, itemUid);
                    list.Children.Add(sep);
                    if (!string.IsNullOrEmpty(itemUid) && itemUid == _revealUid) selectedRow = sep;
                    continue;
                }
                if (item is not MenuItem mi2) continue;
                var row = FakeMenuRow(mi2, t, leftPad);
                if (nextNode != null && ReferenceEquals(mi2, nextNode)) { nextRow = row; row.Background = t.Open; }
                if (mi2.Uid == _revealUid) selectedRow = row;
                list.Children.Add(row);
            }

            var scroller = ScrollWrap(list);
            var panel = MakeFakePanel(scroller, t, minW, t.MenuBg); // menu: szare w Classic '98
            panel.Measure(new Size(double.PositiveInfinity, double.PositiveInfinity));
            double pw = Math.Max(panel.DesiredSize.Width, minW), ph = panel.DesiredSize.Height;
            double left, top, avail;
            if (i == 0)
            {
                // poziom 0: rozwiń POD paskiem albo NAD nim (nie zasłaniając pozycji paska); szerszy obszar
                // wygrywa, a przy nadmiarze włącza się scroll — inaczej długie menu przykrywało swój pasek.
                left = prev.Left;
                double below = pxH - prev.Bottom, above = prev.Top;
                if (ph <= below || below >= above) { top = prev.Bottom; avail = below; }
                else { avail = above; top = Math.Max(0, prev.Top - Math.Min(ph, avail)); }
                if (left + pw > pxW) left = Math.Max(0, pxW - pw);
            }
            else
            {
                left = prev.Right; top = prev.Top;
                if (left + pw > pxW) left = Math.Max(0, prev.Left - pw); // kaskada w lewo
                if (top + ph > pxH) top = Math.Max(0, pxH - ph);
                avail = pxH - top;
            }
            // panel wyższy niż dostępny obszar → ogranicz wysokość i włącz przewijanie (jak prawdziwy WPF)
            double maxH = avail;
            if (ph > maxH)
            {
                panel.MaxHeight = Math.Max(0, maxH);
                double sb = SystemParameters.VerticalScrollBarWidth;
                panel.MinWidth = pw + sb;
                pw += sb;
                if (left + pw > pxW) left = Math.Max(0, pxW - pw);
            }
            Canvas.SetLeft(panel, left);
            Canvas.SetTop(panel, top);
            canvas.Children.Add(panel);
            double ah = Math.Min(ph, maxH);
            panel.Arrange(new Rect(0, 0, pw, ah)); // realizuj wiersze, by policzyć kotwicę następnego poziomu
            any = true;

            // przewijanie kółkiem (funkcja 3); reveal do zaznaczonej pozycji robi RevealFakeScroll() po layoucie
            if (ph > maxH)
            {
                var fakeUid = TryFakeUid(node);
                if (fakeUid != null) scroller.Uid = fakeUid;
                var bring = nextRow ?? selectedRow; // ścieżka podmenu albo zaznaczony liść/separator
                ApplyFakeScroll(scroller, fakeUid, bring);
                if (bring != null) _fakeRevealTarget = bring; // najgłębszy panel wygrywa (= zaznaczenie)
            }

            if (nextNode == null || nextRow == null) break;
            try
            {
                var off = nextRow.TransformToAncestor(panel).TransformBounds(new Rect(0, 0, nextRow.ActualWidth, nextRow.ActualHeight));
                prev = new Rect(left + off.X, top + off.Y, off.Width, off.Height);
            }
            catch { break; }
        }
        return any;
    }

    // Szuka FrameworkElementu po x:Uid (drzewo wizualne + logiczne — pozycje list bywają tylko logiczne).
    private static FrameworkElement? FindByUid(DependencyObject root, string uid)
    {
        if (root is FrameworkElement fe && fe.Uid == uid) return fe;
        // VisualTreeHelper rzuca dla nie-Visualów (np. ColumnDefinition) — wchodź w drzewo wizualne tylko dla Visual
        if (root is Visual)
        {
            int n = VisualTreeHelper.GetChildrenCount(root);
            for (int i = 0; i < n; i++)
            {
                var r = FindByUid(VisualTreeHelper.GetChild(root, i), uid);
                if (r != null) return r;
            }
        }
        foreach (var c in LogicalTreeHelper.GetChildren(root))
            if (c is DependencyObject d && !ReferenceEquals(d, root))
            {
                var r = FindByUid(d, uid);
                if (r != null) return r;
            }
        return null;
    }

    private static Dictionary<string, Type> BuildTypeIndex()
    {
        var d = new Dictionary<string, Type>();
        var asms = new[]
        {
            typeof(System.Windows.Controls.Button).Assembly,
            typeof(System.Windows.UIElement).Assembly,
            typeof(System.Windows.DependencyObject).Assembly,
        };
        foreach (var a in asms)
            foreach (var t in a.GetExportedTypes())
                if (t.Namespace != null && t.Namespace.StartsWith("System.Windows") && !d.ContainsKey(t.Name))
                    d[t.Name] = t;
        // typy z bibliotek projektu (dowolny namespace) — by Sanitize rozpoznał custom kontrolki/eventy
        foreach (var a in _projectAssemblies)
        {
            Type?[] types;
            try { types = a.GetExportedTypes(); }
            catch (ReflectionTypeLoadException ex) { types = ex.Types; }
            foreach (var t in types)
                if (t != null && !d.ContainsKey(t.Name)) d[t.Name] = t;
        }
        return d;
    }

    /// <summary>Parsuje XAML z BaseUri (rozwiązywanie względnych URI: Icon/Image Source/słowniki).</summary>
    private static object ParseXaml(string cleaned)
        => _baseUri == null ? XamlReader.Parse(cleaned) : XamlReader.Parse(cleaned, new ParserContext { BaseUri = _baseUri });

    /// <summary>Ładuje zasoby projektu (apply-if-changed wg "key"): biblioteki, ParserContext, słowniki.</summary>
    private static void ApplyProject(JsonElement proj)
    {
        string key = proj.TryGetProperty("key", out var kEl) ? kEl.GetString() ?? "" : "";
        if (key == _projectKey) return;

        // reset poprzednich zasobów projektu
        if (Application.Current != null)
            foreach (var d in _projectDicts)
                Application.Current.Resources.MergedDictionaries.Remove(d);
        _projectDicts.Clear();
        _projectAssemblies.Clear();
        _locResolved = false; // nowy zestaw DLL → wykryj cel lokalizacji ponownie
        _probeDirs.Clear();
        _nsToAsm = null;
        _typeIndex = null; // wymuś przebudowę indeksu typów (z custom assembly)
        _projectKey = key;

        if (!_assemblyResolveHooked)
        {
            AppDomain.CurrentDomain.AssemblyResolve += OnAssemblyResolve;
            _assemblyResolveHooked = true;
        }

        _projectAsmNames.Clear();
        _projectDictResults.Clear();
        var asmNames = _projectAsmNames;
        var dictResults = _projectDictResults;

        // 1) biblioteki custom kontrolek
        if (proj.TryGetProperty("assemblies", out var asmEl) && asmEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var a in asmEl.EnumerateArray())
            {
                string p = a.GetString() ?? "";
                if (string.IsNullOrEmpty(p) || !File.Exists(p)) continue;
                try
                {
                    var asm = LoadAssemblyNoLock(p);
                    if (!_projectAssemblies.Any(x => x.FullName == asm.FullName)) _projectAssemblies.Add(asm);
                    asmNames.Add(asm.GetName().Name ?? Path.GetFileName(p));
                    string? dir = Path.GetDirectoryName(p);
                    if (dir != null && !_probeDirs.Contains(dir)) _probeDirs.Add(dir);
                }
                catch (Exception ex) { dictResults.Add(new DictRes { st = "err", name = Path.GetFileName(p), err = ex.Message }); }
            }
        }

        // 3) słowniki zasobów + App.xaml → Application.Resources.MergedDictionaries
        if (Application.Current != null && proj.TryGetProperty("dictionaries", out var dictEl) && dictEl.ValueKind == JsonValueKind.Array)
        {
            foreach (var d in dictEl.EnumerateArray())
            {
                string p = d.GetString() ?? "";
                if (string.IsNullOrEmpty(p) || !File.Exists(p)) continue;
                try
                {
                    var rd = LoadResourceDictionary(p);
                    if (rd != null)
                    {
                        Application.Current.Resources.MergedDictionaries.Add(rd);
                        _projectDicts.Add(rd);
                        dictResults.Add(new DictRes { st = "ok", name = Path.GetFileName(p), n = rd.Count });
                    }
                    else dictResults.Add(new DictRes { st = "skip", name = Path.GetFileName(p) });
                }
                catch (Exception ex) { dictResults.Add(new DictRes { st = "err", name = Path.GetFileName(p), err = ex.Message }); }
            }
        }

        DiscoverLocTarget(); // wykryj singleton lokalizacji (do refleksji kultury + diagnostyki)
    }

    private static readonly Regex StaticResRegex = new(@"\{StaticResource\s+([^{}]+)\}", RegexOptions.Compiled);
    private static readonly Regex ClrNsRegex =
        new("xmlns(:[A-Za-z0-9_]+)?=\"clr-namespace:([^\";]+)\"", RegexOptions.Compiled);

    /// <summary>Dopisuje `;assembly=&lt;biblioteka&gt;` do deklaracji xmlns `clr-namespace:` bez assembly
    /// (modern XamlReader rozumie wtedy typ; AssemblyResolve ładuje bibliotekę po nazwie).</summary>
    private static string QualifyClrNamespaces(string xaml)
    {
        if (_projectAssemblies.Count == 0) return xaml;
        var map = NsToAsm();
        return ClrNsRegex.Replace(xaml, m =>
        {
            string ns = m.Groups[2].Value;
            return map.TryGetValue(ns, out var asm)
                ? $"xmlns{m.Groups[1].Value}=\"clr-namespace:{ns};assembly={asm}\""
                : m.Value;
        });
    }

    /// <summary>Zamienia `pack://application:,,,/X` na URI pliku w katalogu projektu (_baseUri) — by
    /// zasoby Content (obrazy tła, ikony) ładowały się jako pliki zamiast szukać ich w hoście.</summary>
    private static string RewritePackUris(string xaml)
        => _baseUri == null ? xaml : xaml.Replace("pack://application:,,,/", _baseUri.AbsoluteUri);

    private static Dictionary<string, string> NsToAsm()
    {
        if (_nsToAsm != null) return _nsToAsm;
        var m = new Dictionary<string, string>(StringComparer.Ordinal);
        foreach (var asm in _projectAssemblies)
        {
            string an = asm.GetName().Name!;
            foreach (var ns in GetAssemblyNamespaces(asm))
                if (!m.ContainsKey(ns)) m[ns] = an;
        }
        return _nsToAsm = m;
    }

    /// <summary>Klucze zasobów zdefiniowane (x:Key w dokumencie + zasoby aplikacji) — by nie zamieniać
    /// StaticResource zdefiniowanych kluczy na DynamicResource (psułoby np. Style.BasedOn).</summary>
    private static HashSet<string> CollectDefinedKeys(XDocument doc)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var el in doc.Descendants())
            foreach (var attr in el.Attributes())
                if (attr.Name.Namespace == XamlNs && attr.Name.LocalName == "Key")
                    keys.Add(attr.Value.Trim());
        if (Application.Current != null) CollectResourceKeys(Application.Current.Resources, keys);
        return keys;
    }

    private static void CollectResourceKeys(ResourceDictionary rd, HashSet<string> keys)
    {
        foreach (var k in rd.Keys) if (k is string s) keys.Add(s);
        foreach (var md in rd.MergedDictionaries) CollectResourceKeys(md, keys);
    }

    private static IEnumerable<string> GetAssemblyNamespaces(Assembly asm)
    {
        Type?[] types;
        try { types = asm.GetTypes(); }
        catch (ReflectionTypeLoadException ex) { types = ex.Types; }
        return types.Where(t => t != null).Select(t => t!.Namespace)
            .Where(n => !string.IsNullOrEmpty(n)).Select(n => n!).Distinct();
    }

    private static Assembly? OnAssemblyResolve(object? sender, ResolveEventArgs args)
    {
        var an = new AssemblyName(args.Name);
        string? name = an.Name;
        if (name == null) return null;
        var hit = _projectAssemblies.FirstOrDefault(a => a.GetName().Name == name);
        if (hit != null) return hit;

        // Satelickie assembly z tłumaczeniami (np. "DuPli.App.resources" Culture=en) — leżą w podkatalogu
        // kultury obok DLL: <dir>/en/DuPli.App.resources.dll. Główny DLL ładujemy z bajtów (brak Location),
        // więc ResourceManager sam ich nie znajdzie — obsługujemy je tutaj, by {Loc}/GetString dał wybrany
        // język (a nie tylko neutralny). Nie cache'ujemy ich w _projectAssemblies (są per-kultura).
        string culture = an.CultureName ?? "";
        if (name.EndsWith(".resources", StringComparison.OrdinalIgnoreCase) && !string.IsNullOrEmpty(culture))
        {
            foreach (var dir in _probeDirs)
            {
                string cand = Path.Combine(dir, culture, name + ".dll");
                if (!File.Exists(cand)) continue;
                try { return LoadAssemblyNoLock(cand); }
                catch { /* spróbuj kolejny katalog */ }
            }
            return null; // brak satelity → ResourceManager użyje neutralnego (oczekiwane)
        }

        foreach (var dir in _probeDirs)
        {
            string cand = Path.Combine(dir, name + ".dll");
            if (!File.Exists(cand)) continue;
            try
            {
                var asm = LoadAssemblyNoLock(cand);
                _projectAssemblies.Add(asm);
                return asm;
            }
            catch { /* spróbuj kolejny katalog */ }
        }
        return null;
    }

    /// <summary>
    /// Ładuje assembly bez blokowania pliku na dysku: czyta bajty (+ ewentualnie .pdb) do
    /// pamięci i woła Assembly.Load, zamiast Assembly.LoadFrom (które trzyma uchwyt pliku
    /// przez cały czas życia procesu). Dzięki temu przebudowa projektu użytkownika nie
    /// kończy się błędem MSB3026 ("file is locked by xve-wpf-host").
    /// </summary>
    private static Assembly LoadAssemblyNoLock(string path)
    {
        byte[] raw = File.ReadAllBytes(path);
        string pdb = Path.ChangeExtension(path, ".pdb");
        if (File.Exists(pdb))
        {
            try { return Assembly.Load(raw, File.ReadAllBytes(pdb)); }
            catch { /* symbole opcjonalne — wczytaj bez nich */ }
        }
        return Assembly.Load(raw);
    }

    /// <summary>Ładuje plik jako ResourceDictionary. Dla App.xaml wyciąga zawartość Application.Resources.</summary>
    private static ResourceDictionary? LoadResourceDictionary(string path)
    {
        string full = Path.GetFullPath(path);
        string dir = Path.GetDirectoryName(full) ?? "";
        if (!dir.EndsWith(Path.DirectorySeparatorChar)) dir += Path.DirectorySeparatorChar;
        var pc = new ParserContext { BaseUri = new Uri(dir, UriKind.Absolute) };

        var xdoc = XDocument.Load(full, LoadOptions.PreserveWhitespace);
        var root = xdoc.Root;
        if (root == null) return null;

        XElement dictElem;
        if (root.Name.LocalName == "ResourceDictionary")
        {
            dictElem = root;
        }
        else if (root.Name.LocalName == "Application")
        {
            var resHolder = root.Elements().FirstOrDefault(e => e.Name.LocalName == "Application.Resources");
            if (resHolder == null) return null;
            var inner = resHolder.Elements().FirstOrDefault(e => e.Name.LocalName == "ResourceDictionary");
            dictElem = inner ?? new XElement(
                PresentationNs + "ResourceDictionary",
                resHolder.Elements().Select(e => new XElement(e)));
        }
        else return null;

        // Skopiuj deklaracje przestrzeni nazw z korzenia pliku na element słownika — prefiksy używane
        // tylko w wartościach markup-extension (`{x:Static ..}`, `{local:..}`) nie są auto-deklarowane
        // przy serializacji, więc bez tego XamlReader zgłasza „prefix x nie jest mapowany".
        foreach (var nsDecl in root.Attributes().Where(a => a.IsNamespaceDeclaration && a.Name.LocalName != "xmlns"))
            if (dictElem.Attribute(nsDecl.Name) == null)
                dictElem.SetAttributeValue(nsDecl.Name, nsDecl.Value);

        string xml = RewritePackUris(QualifyClrNamespaces(dictElem.ToString(SaveOptions.DisableFormatting)));
        using var ms = new MemoryStream(Encoding.UTF8.GetBytes(xml));
        return XamlReader.Load(ms, pc) as ResourceDictionary;
    }

    private sealed class Resp
    {
        public int id { get; set; }
        public bool ok { get; set; }
        public string? error { get; set; }
        public int line { get; set; } // wiersz błędu (1-based, 0 = nieznany)
        public int col { get; set; }  // kolumna błędu (1-based, 0 = nieznana)
        public string? info { get; set; } // podsumowanie ładowania zasobów (loadProject) — zaszłość
        public List<string>? resAsm { get; set; } // załadowane biblioteki (nazwy assembly)
        public List<DictRes>? resDict { get; set; } // wynik ładowania słowników (dane strukturalne)
        public string? locTarget { get; set; } // wykryty singleton lokalizacji (refleksja kultury) lub null
        public string? png { get; set; }
        public int width { get; set; } // pełny logiczny rozmiar powierzchni (design px)
        public int height { get; set; }
        public double vx { get; set; } // wycinek (slice) w jednostkach projektu
        public double vy { get; set; }
        public double vw { get; set; }
        public double vh { get; set; }
        public int rpw { get; set; } // realnie wyrenderowana bitmapa (px urządzenia) — dla konsoli debug
        public int rph { get; set; }
        public List<RectInfo>? rects { get; set; }
        public List<ScrollInfo>? scrolled { get; set; } // offsety po reveal-scroll (auto-podgląd)
    }

    // Wynik ładowania pojedynczego słownika (dane strukturalne; etykiety lokalizuje strona TS).
    private sealed class DictRes
    {
        public string st { get; set; } = ""; // "ok" | "skip" | "err"
        public string name { get; set; } = "";
        public int n { get; set; } // liczba wpisów (dla "ok")
        public string? err { get; set; } // komunikat błędu (dla "err")
    }

    private sealed class ScrollInfo
    {
        public string uid { get; set; } = "";
        public double h { get; set; }
        public double v { get; set; }
    }

    private sealed class RectInfo
    {
        public string uid { get; set; } = "";
        public double x { get; set; }
        public double y { get; set; }
        public double w { get; set; }
        public double h { get; set; }
        public bool scroll { get; set; } // ScrollViewer z przewijalną zawartością (funkcja 3)
        public double sw { get; set; } // ScrollableWidth (zakres przewijania)
        public double sh { get; set; } // ScrollableHeight
        public bool block { get; set; } // tło fake-panelu (lista/menu) — pochłania klik, nie zaznacza spod spodu
        public bool clipped { get; set; } // całkiem poza widocznym obszarem (przycięty) — niewidoczny, nieklikalny
        public double rx { get; set; } // realne (nieprzycięte) granice — ramka zaznaczenia + narzędzia dla niewidocznych
        public double ry { get; set; }
        public double rw { get; set; }
        public double rh { get; set; }
    }
}
