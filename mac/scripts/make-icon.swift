// Renders the app icon and builds Resources/AppIcon.icns.
//   swift scripts/make-icon.swift
import AppKit

let root = URL(fileURLWithPath: CommandLine.arguments[0]).deletingLastPathComponent().deletingLastPathComponent()
let iconset = root.appendingPathComponent("build/AppIcon.iconset")
try? FileManager.default.removeItem(at: iconset)
try! FileManager.default.createDirectory(at: iconset, withIntermediateDirectories: true)

func render(_ size: CGFloat) -> NSBitmapImageRep {
    let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size),
                               bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                               colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    let s = size / 1024

    // macOS icon grid: 824pt body centred in 1024, continuous-corner radius ~185.
    let body = NSRect(x: 100 * s, y: 100 * s, width: 824 * s, height: 824 * s)
    let shape = NSBezierPath(roundedRect: body, xRadius: 185 * s, yRadius: 185 * s)

    NSGraphicsContext.saveGraphicsState()
    let shadow = NSShadow()
    shadow.shadowColor = NSColor.black.withAlphaComponent(0.3)
    shadow.shadowBlurRadius = 24 * s
    shadow.shadowOffset = NSSize(width: 0, height: -10 * s)
    shadow.set()
    NSColor.black.setFill()
    shape.fill()
    NSGraphicsContext.restoreGraphicsState()

    NSGradient(colors: [NSColor(srgbRed: 0.42, green: 0.25, blue: 0.93, alpha: 1),
                        NSColor(srgbRed: 0.20, green: 0.13, blue: 0.55, alpha: 1)])!
        .draw(in: shape, angle: -90)

    // 2×2 grid of tiles; top-right tile is the agent tile with a sparkle.
    let tile = 250 * s, gap = 54 * s
    let origin = CGPoint(x: 512 * s - tile - gap / 2, y: 512 * s - tile - gap / 2)
    for row in 0..<2 {
        for col in 0..<2 {
            let rect = NSRect(x: origin.x + CGFloat(col) * (tile + gap), y: origin.y + CGFloat(row) * (tile + gap),
                              width: tile, height: tile)
            let path = NSBezierPath(roundedRect: rect, xRadius: 58 * s, yRadius: 58 * s)
            let isAgent = row == 1 && col == 1
            NSColor.white.withAlphaComponent(isAgent ? 1 : (row == 0 && col == 0 ? 0.92 : 0.55)).setFill()
            path.fill()
            if isAgent {
                let config = NSImage.SymbolConfiguration(pointSize: 150 * s, weight: .bold)
                    .applying(.init(paletteColors: [NSColor(srgbRed: 0.42, green: 0.25, blue: 0.93, alpha: 1)]))
                if let sparkle = NSImage(systemSymbolName: "sparkle", accessibilityDescription: nil)?
                    .withSymbolConfiguration(config) {
                    let sz = sparkle.size
                    sparkle.draw(in: NSRect(x: rect.midX - sz.width / 2, y: rect.midY - sz.height / 2,
                                            width: sz.width, height: sz.height))
                }
            }
        }
    }
    // Checkmark on the bottom-left (human, done) tile.
    let check = NSBezierPath()
    let c = CGPoint(x: origin.x + tile / 2, y: origin.y + tile / 2)
    check.move(to: CGPoint(x: c.x - 62 * s, y: c.y + 2 * s))
    check.line(to: CGPoint(x: c.x - 18 * s, y: c.y - 42 * s))
    check.line(to: CGPoint(x: c.x + 66 * s, y: c.y + 52 * s))
    check.lineWidth = 34 * s
    check.lineCapStyle = .round
    check.lineJoinStyle = .round
    NSColor(srgbRed: 0.20, green: 0.13, blue: 0.55, alpha: 1).setStroke()
    check.stroke()

    NSGraphicsContext.restoreGraphicsState()
    return rep
}

for base in [16, 32, 128, 256, 512] {
    for scale in [1, 2] {
        let name = scale == 1 ? "icon_\(base)x\(base).png" : "icon_\(base)x\(base)@2x.png"
        let png = render(CGFloat(base * scale)).representation(using: .png, properties: [:])!
        try! png.write(to: iconset.appendingPathComponent(name))
    }
}

let out = root.appendingPathComponent("Resources/AppIcon.icns")
try? FileManager.default.createDirectory(at: out.deletingLastPathComponent(), withIntermediateDirectories: true)
let p = Process()
p.executableURL = URL(fileURLWithPath: "/usr/bin/iconutil")
p.arguments = ["-c", "icns", iconset.path, "-o", out.path]
try! p.run()
p.waitUntilExit()
print(p.terminationStatus == 0 ? "Wrote \(out.path)" : "iconutil failed")
