# Reads which videos/audio are playing in a running PowerPoint slide show (Windows, read-only).
# Started hidden by the Lupixis Timer desktop app; prints one JSON array per line, ~3x per second:
#   [{ id, name, alt, kind:'video'|'audio', state:0 playing|1 paused, pos, len, start, end }]  (times in ms)
# It never changes anything in PowerPoint and never takes focus.
$ErrorActionPreference = 'SilentlyContinue'
$n = 0
while ($true) {
  $items = @()
  $app = $null
  try { $app = [Runtime.InteropServices.Marshal]::GetActiveObject('PowerPoint.Application') } catch { }
  if ($app) {
    try {
      foreach ($w in @($app.SlideShowWindows)) {
        $view = $w.View
        $slide = $view.Slide
        foreach ($sh in @($slide.Shapes)) {
          $mt = 0
          try { $mt = [int]$sh.MediaType } catch { }
          if ($mt -ne 2 -and $mt -ne 3) { continue }   # 2 = sound, 3 = movie
          $p = $null
          try { $p = $view.Player($sh.Id) } catch { }
          if (-not $p) { continue }
          $state = [int]$p.State
          if ($state -gt 1) { continue }               # only playing (0) or paused (1)
          $mf = $sh.MediaFormat
          $items += [ordered]@{
            id    = "$($slide.SlideID)-$($sh.Id)"
            name  = [string]$sh.Name
            alt   = [string]$sh.AlternativeText
            kind  = $(if ($mt -eq 3) { 'video' } else { 'audio' })
            state = $state
            pos   = [double]$p.CurrentPosition
            len   = [double]$mf.Length
            start = [double]$mf.StartPoint
            end   = [double]$mf.EndPoint
          }
        }
      }
    } catch { }
    $app = $null
  }
  [Console]::Out.WriteLine((ConvertTo-Json -Compress -Depth 3 -InputObject @($items)))
  [Console]::Out.Flush()
  $n++
  if ($n % 100 -eq 0) { [GC]::Collect() }             # release COM wrappers during long shows
  Start-Sleep -Milliseconds 300
}
