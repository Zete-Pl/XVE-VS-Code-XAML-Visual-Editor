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
using System.Text;
using System.Text.Json;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Markup;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Xml.Linq;

internal static class Program
{
    private static readonly XNamespace XamlNs = "http://schemas.microsoft.com/winfx/2006/xaml";
    private static Dictionary<string, Type>? _typeIndex;

    // limit rozdzielczości bitmapy (px po dłuższym boku); <=0 = bez limitu (pełna ostrość)
    private static int _cap = 2560;

    // cache trwałej sesji przeciągania (jeden proces → pola statyczne)
    private static FrameworkElement? _dragRoot;
    private static Dictionary<string, FrameworkElement>? _dragMap;
    private static int _dragW, _dragH;
    private static string? _dragRootUid;

    [STAThread]
    private static void Main()
    {
        Console.OutputEncoding = Encoding.UTF8;
        string? line;
        while ((line = Console.ReadLine()) != null)
        {
            if (line.Length == 0) continue;
            object response;
            int id = 0;
            try
            {
                using var docReq = JsonDocument.Parse(line);
                var root = docReq.RootElement;
                id = root.TryGetProperty("id", out var idEl) ? idEl.GetInt32() : 0;
                if (root.TryGetProperty("cap", out var capEl)) _cap = capEl.GetInt32();
                var cmd = root.TryGetProperty("cmd", out var c) ? c.GetString() : null;
                switch (cmd)
                {
                    case "render":
                        response = RenderResult(id, BuildSurface(Xaml(root), W(root), H(root)));
                        break;
                    case "dragStart":
                    {
                        var s = BuildSurface(Xaml(root), W(root), H(root));
                        _dragRoot = s.root;
                        _dragW = s.pxW;
                        _dragH = s.pxH;
                        _dragRootUid = s.rootUid;
                        _dragMap = BuildUidMap(s.root);
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
                    default:
                        response = new Resp { id = id, ok = false, error = "unknown cmd" };
                        break;
                }
            }
            catch (Exception ex)
            {
                response = new Resp { id = id, ok = false, error = ex.Message };
            }
            Console.WriteLine(JsonSerializer.Serialize(response, response.GetType()));
            Console.Out.Flush();
        }
    }

    private static string Xaml(JsonElement r) => r.GetProperty("xaml").GetString() ?? "";
    private static int W(JsonElement r) => r.TryGetProperty("width", out var v) ? v.GetInt32() : 800;
    private static int H(JsonElement r) => r.TryGetProperty("height", out var v) ? v.GetInt32() : 600;

    private readonly record struct Surface(FrameworkElement root, int pxW, int pxH, string? rootUid);

    /// <summary>Parsuje + sanityzuje XAML, buduje renderowalny korzeń, mierzy/układa.</summary>
    private static Surface BuildSurface(string xaml, int width, int height)
    {
        string cleaned = Sanitize(xaml);
        object parsed = XamlReader.Parse(cleaned);
        string? rootUid = (parsed as FrameworkElement)?.Uid;
        double surfW = width, surfH = height;
        FrameworkElement rootFe;

        if (parsed is Window win)
        {
            var content = win.Content as UIElement;
            win.Content = null;
            if (!double.IsNaN(win.Width)) surfW = win.Width;
            if (!double.IsNaN(win.Height)) surfH = win.Height;
            rootFe = new Border { Width = surfW, Height = surfH, Background = win.Background ?? Brushes.White, Child = content };
        }
        else if (parsed is FrameworkElement fe)
        {
            rootFe = fe;
            if (!double.IsNaN(fe.Width)) surfW = fe.Width;
            if (!double.IsNaN(fe.Height)) surfH = fe.Height;
        }
        else
        {
            throw new InvalidOperationException("root is not a FrameworkElement");
        }

        int pxW = Math.Max(1, (int)Math.Ceiling(surfW));
        int pxH = Math.Max(1, (int)Math.Ceiling(surfH));
        rootFe.Measure(new Size(pxW, pxH));
        rootFe.Arrange(new Rect(0, 0, pxW, pxH));
        rootFe.UpdateLayout();
        return new Surface(rootFe, pxW, pxH, rootUid);
    }

    private static string RenderPng(FrameworkElement root, int pxW, int pxH)
    {
        int cap = _cap > 0 ? _cap : int.MaxValue;
        double scale = Math.Min(1.0, (double)cap / Math.Max(pxW, pxH));
        RenderTargetBitmap rtb;
        if (scale >= 1.0)
        {
            rtb = new RenderTargetBitmap(pxW, pxH, 96, 96, PixelFormats.Pbgra32);
            rtb.Render(root);
        }
        else
        {
            int bw = Math.Max(1, (int)Math.Round(pxW * scale));
            int bh = Math.Max(1, (int)Math.Round(pxH * scale));
            rtb = new RenderTargetBitmap(bw, bh, 96, 96, PixelFormats.Pbgra32);
            var dv = new DrawingVisual();
            using (var dc = dv.RenderOpen())
                dc.DrawRectangle(new VisualBrush(root) { Stretch = Stretch.Fill }, null, new Rect(0, 0, bw, bh));
            rtb.Render(dv);
        }
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(rtb));
        using var ms = new MemoryStream();
        enc.Save(ms);
        return Convert.ToBase64String(ms.ToArray());
    }

    private static Resp RenderResult(int id, Surface s)
    {
        string png = RenderPng(s.root, s.pxW, s.pxH);
        var rects = new List<RectInfo>();
        if (!string.IsNullOrEmpty(s.rootUid) && s.rootUid!.StartsWith("u"))
            rects.Add(new RectInfo { uid = s.rootUid, x = 0, y = 0, w = s.pxW, h = s.pxH });
        Collect(s.root, s.root, rects);
        return new Resp { id = id, ok = true, png = png, width = s.pxW, height = s.pxH, rects = rects };
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
        return RenderResult(id, new Surface(_dragRoot, _dragW, _dragH, _dragRootUid));
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
        var types = _typeIndex ??= BuildTypeIndex();
        var doc = XDocument.Parse(xaml, LoadOptions.PreserveWhitespace);
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
                if (attr.Value.Contains("{StaticResource"))
                    attr.Value = attr.Value.Replace("{StaticResource", "{DynamicResource");
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
                if (!string.IsNullOrEmpty(fe.Uid) && fe.Uid.StartsWith("u"))
                {
                    try
                    {
                        var tr = fe.TransformToAncestor(root);
                        var r = tr.TransformBounds(new Rect(0, 0, fe.ActualWidth, fe.ActualHeight));
                        rects.Add(new RectInfo { uid = fe.Uid, x = r.X, y = r.Y, w = r.Width, h = r.Height });
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
        return d;
    }

    private sealed class Resp
    {
        public int id { get; set; }
        public bool ok { get; set; }
        public string? error { get; set; }
        public string? png { get; set; }
        public int width { get; set; }
        public int height { get; set; }
        public List<RectInfo>? rects { get; set; }
    }

    private sealed class RectInfo
    {
        public string uid { get; set; } = "";
        public double x { get; set; }
        public double y { get; set; }
        public double w { get; set; }
        public double h { get; set; }
    }
}
