// xve-wpf-host — proces pomocniczy (Windows). Renderuje XAML prawdziwym silnikiem WPF
// do PNG i zwraca mapę hit-test (prostokąty elementów wg x:Uid). Komunikacja: JSON-lines
// przez stdio. Jedno żądanie na linię stdin → jedna odpowiedź na linię stdout.
//
// Żądanie:  {"id":1,"cmd":"render","xaml":"...","width":640,"height":480}
// Odpowiedź:{"id":1,"ok":true,"png":"<base64>","width":W,"height":H,
//            "rects":[{"uid":"u5","x":..,"y":..,"w":..,"h":..}, ...]}
//           {"id":1,"ok":false,"error":"..."}

using System.IO;
using System.Reflection;
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
                var cmd = root.TryGetProperty("cmd", out var c) ? c.GetString() : null;
                if (cmd == "render")
                {
                    var xaml = root.GetProperty("xaml").GetString() ?? "";
                    int w = root.TryGetProperty("width", out var we) ? we.GetInt32() : 800;
                    int h = root.TryGetProperty("height", out var he) ? he.GetInt32() : 600;
                    response = Render(id, xaml, w, h);
                }
                else if (cmd == "ping")
                {
                    response = new Resp { id = id, ok = true };
                }
                else
                {
                    response = new Resp { id = id, ok = false, error = "unknown cmd" };
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

    private static object Render(int id, string xaml, int width, int height)
    {
        string cleaned = Sanitize(xaml);
        object parsed = XamlReader.Parse(cleaned);

        FrameworkElement rootFe;
        string? rootUid = (parsed as FrameworkElement)?.Uid;
        double surfW = width;
        double surfH = height;

        if (parsed is Window win)
        {
            // okna nie da się renderować bezpośrednio — przenosimy zawartość do kontenera
            var content = win.Content as UIElement;
            win.Content = null;
            if (!double.IsNaN(win.Width)) surfW = win.Width;
            if (!double.IsNaN(win.Height)) surfH = win.Height;
            rootFe = new Border
            {
                Width = surfW,
                Height = surfH,
                Background = win.Background ?? Brushes.White,
                Child = content,
            };
        }
        else if (parsed is FrameworkElement fe)
        {
            rootFe = fe;
            if (!double.IsNaN(fe.Width)) surfW = fe.Width;
            if (!double.IsNaN(fe.Height)) surfH = fe.Height;
        }
        else
        {
            return new Resp { id = id, ok = false, error = "root is not a FrameworkElement" };
        }

        int pxW = Math.Max(1, (int)Math.Ceiling(surfW));
        int pxH = Math.Max(1, (int)Math.Ceiling(surfH));

        rootFe.Measure(new Size(pxW, pxH));
        rootFe.Arrange(new Rect(0, 0, pxW, pxH));
        rootFe.UpdateLayout();

        var rtb = new RenderTargetBitmap(pxW, pxH, 96, 96, PixelFormats.Pbgra32);
        rtb.Render(rootFe);
        var enc = new PngBitmapEncoder();
        enc.Frames.Add(BitmapFrame.Create(rtb));
        using var ms = new MemoryStream();
        enc.Save(ms);
        string png = Convert.ToBase64String(ms.ToArray());

        var rects = new List<RectInfo>();
        if (!string.IsNullOrEmpty(rootUid) && rootUid!.StartsWith("u"))
            rects.Add(new RectInfo { uid = rootUid, x = 0, y = 0, w = pxW, h = pxH });
        Collect(rootFe, rootFe, rects);

        return new Resp { id = id, ok = true, png = png, width = pxW, height = pxH, rects = rects };
    }

    /// <summary>Usuwa to, co wywala loose-XAML: x:Class/modyfikatory, event handlery; StaticResource→DynamicResource.</summary>
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
                if (an.Namespace == XamlNs &&
                    (an.LocalName is "Class" or "Subclass" or "ClassModifier"))
                {
                    attr.Remove();
                    continue;
                }
                // event handler: atrybut bez przestrzeni nazw, którego nazwa to event typu
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
                    catch { /* element poza drzewem wizualnym — pomiń */ }
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
            typeof(System.Windows.Controls.Button).Assembly, // PresentationFramework
            typeof(System.Windows.UIElement).Assembly, // PresentationCore
            typeof(System.Windows.DependencyObject).Assembly, // WindowsBase
        };
        foreach (var a in asms)
        {
            foreach (var t in a.GetExportedTypes())
            {
                if (t.Namespace != null && t.Namespace.StartsWith("System.Windows") && !d.ContainsKey(t.Name))
                    d[t.Name] = t;
            }
        }
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
