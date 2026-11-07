import AppKit
// round.swift <tile.png> <out.png> <size> : rounded dark tile for Windows (.ico), transparent corners
let a = CommandLine.arguments
let src = NSImage(contentsOfFile: a[1])!
let n = CGFloat(Double(a[3])!)
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(n), pixelsHigh: Int(n), bitsPerSample: 8,
  samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
let ctx = NSGraphicsContext(bitmapImageRep: rep)!
ctx.imageInterpolation = .high
NSGraphicsContext.current = ctx
let m = n * 0.025, r = NSRect(x: m, y: m, width: n - 2*m, height: n - 2*m)
NSBezierPath(roundedRect: r, xRadius: r.width * 0.21, yRadius: r.width * 0.21).addClip()
src.draw(in: r)
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
