import AppKit
// Renders the macOS app icon: official rly0-ip-on-dark.svg on a full-bleed ink-950 (#0D0D0B) tile.
//   swiftc -O render-app-icon.swift -o /tmp/render && /tmp/render rly0-ip-on-dark.svg AppIcon-1024.png 1024 1.0
// Never ship a transparent or light-tile icon (brand rule: app icons are dark tiles).
let a = CommandLine.arguments
let svg = NSImage(contentsOfFile: a[1])!
let size = CGFloat(Double(a[3])!), frac = CGFloat(Double(a[4])!)
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
  samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
NSColor(srgbRed: 0x0D/255.0, green: 0x0D/255.0, blue: 0x0B/255.0, alpha: 1).setFill()   // ink-950
NSRect(x: 0, y: 0, width: size, height: size).fill()
let s = size * frac
svg.draw(in: NSRect(x: (size - s) / 2, y: (size - s) / 2, width: s, height: s))
NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: a[2]))
