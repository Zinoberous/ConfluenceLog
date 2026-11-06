$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing
Add-Type -ReferencedAssemblies System.Drawing.Common,System.Drawing.Primitives,System.Private.Windows.GdiPlus,System.Private.Windows.Core,System.Text.RegularExpressions -TypeDefinition @"
using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.Globalization;
using System.Text.RegularExpressions;
public static class ConfluenceIconBuilder {
 public static void Build(string template, string data, string output) {
  using(var src=new Bitmap(template)) using(var dst=new Bitmap(src.Width,src.Height,PixelFormat.Format32bppArgb)) {
   using(var g=Graphics.FromImage(dst))g.DrawImageUnscaled(src,0,0);
   for(int y=100;y<677;y++) {
    Color l=src.GetPixel(200,y),r=src.GetPixel(900,y);
    for(int x=0;x<src.Width;x++) {
     int a=src.GetPixel(x,y).A;if(a==0)continue;
     double t=Math.Max(0,Math.Min(1,(x-200.0)/700.0));
     dst.SetPixel(x,y,Color.FromArgb(a,(int)(l.R+(r.R-l.R)*t),(int)(l.G+(r.G-l.G)*t),(int)(l.B+(r.B-l.B)*t)));
    }
   }
   using(var path=new GraphicsPath()) {
    var tokens=Regex.Matches(data,@"[MLCZ]|[-+]?(?:\d*\.\d+|\d+)(?:[eE][-+]?\d+)?");
    int i=0;char cmd=' ';PointF p=new PointF();
    Func<float> n=()=>float.Parse(tokens[i++].Value,CultureInfo.InvariantCulture);
    while(i<tokens.Count) {
     if(char.IsLetter(tokens[i].Value[0]))cmd=tokens[i++].Value[0];
     if(cmd=='M'){p=new PointF(n(),n());path.StartFigure();cmd='L';}
     else if(cmd=='L'){var q=new PointF(n(),n());path.AddLine(p,q);p=q;}
     else if(cmd=='C'){var c1=new PointF(n(),n());var c2=new PointF(n(),n());var q=new PointF(n(),n());path.AddBezier(p,c1,c2,q);p=q;}
     else if(cmd=='Z'){path.CloseFigure();cmd=' ';}
     else throw new Exception("Unsupported SVG command");
    }
    using(var m=new Matrix(22.6f,0,0,22.6f,252-11.5625f*22.6f,105-12.1875f*22.6f))path.Transform(m);
    using(var g=Graphics.FromImage(dst))using(var b=new LinearGradientBrush(new Rectangle(240,100,580,550),Color.FromArgb(0,117,255),Color.FromArgb(0,86,220),50f)){g.SmoothingMode=SmoothingMode.AntiAlias;g.FillPath(b,path);}
   }
   dst.Save(System.IO.Path.Combine(output,"icon.png"),ImageFormat.Png);
   foreach(int size in new[]{16,32,48,128})using(var small=new Bitmap(size,size,PixelFormat.Format32bppArgb))using(var g=Graphics.FromImage(small)){
    g.CompositingMode=CompositingMode.SourceCopy;g.InterpolationMode=InterpolationMode.HighQualityBicubic;g.PixelOffsetMode=PixelOffsetMode.HighQuality;
    g.DrawImage(dst,new Rectangle(0,0,size,size));small.Save(System.IO.Path.Combine(output,"icon"+size+".png"),ImageFormat.Png);
   }
  }
 }
}
"@
$repoRoot = Split-Path -Parent $PSScriptRoot
$iconFolder = Join-Path $repoRoot 'icons'
[xml]$svg = Get-Content -LiteralPath (Join-Path $iconFolder 'confluence-mark.svg') -Raw
$glyph = $svg.SelectSingleNode("//*[local-name()='g']/*[local-name()='path']").GetAttribute('d')
$templatePath = Join-Path (Split-Path -Parent $repoRoot) 'JiraLog\icons\icon.png'
[ConfluenceIconBuilder]::Build($templatePath,$glyph,$iconFolder)

