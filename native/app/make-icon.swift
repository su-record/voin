// 앱 아이콘(1024px PNG)을 그린다: macOS 아이콘 격자(824px 둥근 사각형) 위에
// 위가 밝은 남보라 그라데이션 + 유리처럼 위쪽 빛 반사 + 흰 SF Symbols 파형
import AppKit

let size = 1024.0
let image = NSImage(size: NSSize(width: size, height: size))
image.lockFocus()
let body = NSRect(x: 100, y: 100, width: 824, height: 824)
let shape = NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185)

// 아래 그림자 (macOS 아이콘처럼 살짝 떠 보이게)
NSGraphicsContext.saveGraphicsState()
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
shadow.shadowOffset = NSSize(width: 0, height: -12)
shadow.shadowBlurRadius = 28
shadow.set()
NSColor.black.setFill()
shape.fill()
NSGraphicsContext.restoreGraphicsState()

// 바탕: 위는 밝은 남보라, 아래는 깊은 남색
NSGradient(colors: [
    NSColor(red: 0.47, green: 0.45, blue: 0.98, alpha: 1),
    NSColor(red: 0.29, green: 0.25, blue: 0.82, alpha: 1),
    NSColor(red: 0.17, green: 0.14, blue: 0.52, alpha: 1),
], atLocations: [0, 0.55, 1], colorSpace: .sRGB)!.draw(in: shape, angle: -90)

// 유리 빛: 위쪽 절반에 옅은 흰 반사, 테두리 안쪽에 얇은 밝은 선
NSGraphicsContext.saveGraphicsState()
shape.addClip()
NSGradient(colors: [NSColor.white.withAlphaComponent(0.22), NSColor.white.withAlphaComponent(0.0)])!
    .draw(in: NSRect(x: 100, y: 470, width: 824, height: 454), angle: -90)
NSGraphicsContext.restoreGraphicsState()
let rim = NSBezierPath(roundedRect: body.insetBy(dx: 3, dy: 3), xRadius: 182, yRadius: 182)
rim.lineWidth = 6
NSColor.white.withAlphaComponent(0.22).setStroke()
rim.stroke()

// 흰 기호 그리기 (그림자를 살짝)
func drawSymbol(_ name: String, pointSize: CGFloat, weight: NSFont.Weight, center: NSPoint, alpha: CGFloat = 1) {
    guard let symbol = NSImage(systemSymbolName: name, accessibilityDescription: nil)?
        .withSymbolConfiguration(NSImage.SymbolConfiguration(pointSize: pointSize, weight: weight)) else { return }
    let tinted = NSImage(size: symbol.size)
    tinted.lockFocus()
    NSColor.white.withAlphaComponent(alpha).set()
    NSRect(origin: .zero, size: symbol.size).fill()
    symbol.draw(at: .zero, from: .zero, operation: .destinationIn, fraction: 1)
    tinted.unlockFocus()
    NSGraphicsContext.saveGraphicsState()
    let s = NSShadow()
    s.shadowColor = NSColor(red: 0.08, green: 0.05, blue: 0.3, alpha: 0.35)
    s.shadowOffset = NSSize(width: 0, height: -8)
    s.shadowBlurRadius = 18
    s.set()
    tinted.draw(in: NSRect(x: center.x - symbol.size.width / 2, y: center.y - symbol.size.height / 2, width: symbol.size.width, height: symbol.size.height))
    NSGraphicsContext.restoreGraphicsState()
}
drawSymbol("waveform", pointSize: 430, weight: .medium, center: NSPoint(x: 512, y: 512))

image.unlockFocus()
let rep = NSBitmapImageRep(data: image.tiffRepresentation!)!
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
