// The small hand in the top left corner when the robot takes a hand gesture (owner, 23 Nov 2026: «facciamo una piccola
// iconcina con la mano, con pollice in su, pollice in giù, mano che saluta e gesto con 2 dita di vittoria. In alto a
// sinistra», on the robot's screen). As the call's dot (prepare-call-dot.swift): the face's pictures have no
// transparency, so each icon is an opaque picture, a dark rounded badge with the yellow hand drawn in it, on the corner's own
// colour, one for each face. Checks first that the corner is the same plain background in every picture of the face.
// Writes assets/<style>hand-<name>.png (HAND_ICON in portrait-state.js gives where it goes).
// Run from the repository root: swift firmware/stackchan-mod/prepare-hand-icons.swift [folder for a large check picture]
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let assets = "firmware/stackchan-mod/assets/"
let box = (left: 4, top: 4, size: 36)
let check = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : nil
func load(_ path: String) -> [UInt8]? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil), img.width == 320, img.height == 240 else { return nil }
    let ctx = CGContext(data: nil, width: 320, height: 240, bitsPerComponent: 8, bytesPerRow: 320 * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: 320, height: 240))
    return Array(UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: 320 * 240 * 4))
}
func write(_ image: CGImage, _ path: String) {
    let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: path) as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dst, image, nil); if !CGImageDestinationFinalize(dst) { fatalError("cannot write \(path)") }
}
// The hands, drawn in a 100×100 square (y up, as CoreGraphics draws). Since 23 Nov 2026 (owner: «fai delle iconcine
// disegnate meglio, gialle») yellow like the hands of the emoji, on a dark badge: each hand is a few rounded pieces
// (palm, fingers, thumb), drawn as one shape: first all the pieces with a thick dark outline, then all of them filled
// with a yellow that gets warmer towards the bottom (so the pieces join without lines between them), then thin dark
// lines only where two fingers meet.
let outline = CGColor(red: 0.36, green: 0.20, blue: 0.04, alpha: 1)
let yellowTop = CGColor(red: 1.0, green: 0.86, blue: 0.30, alpha: 1), yellowLow = CGColor(red: 0.98, green: 0.66, blue: 0.10, alpha: 1)
struct Hand { var pieces: [CGPath] = []; var creases: [(CGPoint, CGPoint)] = [] }
func piece(_ rect: CGRect, radius: CGFloat, angle: CGFloat = 0, about: CGPoint? = nil) -> CGPath {
    let p = about ?? CGPoint(x: rect.midX, y: rect.midY)
    var t = CGAffineTransform(translationX: p.x, y: p.y).rotated(by: angle * .pi / 180).translatedBy(x: -p.x, y: -p.y)
    return CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: &t)
}
func draw(_ c: CGContext, _ hand: Hand) {
    c.setLineJoin(.round); c.setLineCap(.round)
    for p in hand.pieces { c.addPath(p) }; c.setStrokeColor(outline); c.setLineWidth(8); c.strokePath()
    c.saveGState()
    for p in hand.pieces { c.addPath(p) }; c.clip()
    let g = CGGradient(colorsSpace: CGColorSpaceCreateDeviceRGB(), colors: [yellowLow, yellowTop] as CFArray, locations: [0, 1])!
    c.drawLinearGradient(g, start: CGPoint(x: 0, y: 8), end: CGPoint(x: 0, y: 92), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    c.restoreGState()
    c.setStrokeColor(outline); c.setLineWidth(3.2)
    for (a, b) in hand.creases { c.move(to: a); c.addLine(to: b) }; c.strokePath()
}
// A fist seen from the side of the fingers, the thumb up: four folded fingers one over the other in front of the palm.
func thumbsUpHand() -> Hand {
    var h = Hand()
    h.pieces.append(piece(CGRect(x: 36, y: 10, width: 44, height: 54), radius: 16))                           // palm
    h.pieces.append(piece(CGRect(x: 38, y: 54, width: 19, height: 40), radius: 9.5, angle: -6, about: CGPoint(x: 47, y: 56))) // thumb
    for i in 0..<4 { h.pieces.append(piece(CGRect(x: 22, y: 12 + CGFloat(i) * 12, width: 36, height: 14), radius: 7)) }
    for i in 1..<4 { let y = 12 + CGFloat(i) * 12 + 1; h.creases.append((CGPoint(x: 26, y: y), CGPoint(x: 48, y: y))) }
    return h
}
func thumbsUp(_ c: CGContext) { draw(c, thumbsUpHand()) }
func thumbsDown(_ c: CGContext) { c.translateBy(x: 0, y: 100); c.scaleBy(x: 1, y: -1); draw(c, thumbsUpHand()) }
func wave(_ c: CGContext) {
    // An open hand, a little turned, and two lines of the movement.
    c.saveGState(); c.translateBy(x: 48, y: 46); c.rotate(by: -16 * .pi / 180); c.translateBy(x: -48, y: -46)
    var h = Hand()
    let tops: [CGFloat] = [76, 86, 83, 70], w: CGFloat = 12.5
    for (i, top) in tops.enumerated() { let x = 28 + CGFloat(i) * 12; h.pieces.append(piece(CGRect(x: x, y: 36, width: w, height: top - 36), radius: w / 2)) }
    h.pieces.append(piece(CGRect(x: 10, y: 26, width: 14, height: 36), radius: 7, angle: 40, about: CGPoint(x: 24, y: 28)))
    h.pieces.append(piece(CGRect(x: 26, y: 8, width: 50, height: 44), radius: 18))
    for i in 1..<4 { let x = 28 + CGFloat(i) * 12 + 0.2; h.creases.append((CGPoint(x: x, y: 50), CGPoint(x: x, y: min(tops[i - 1], tops[i]) - 5))) }
    draw(c, h)
    c.restoreGState()
    c.setStrokeColor(CGColor(red: 1, green: 0.93, blue: 0.62, alpha: 1)); c.setLineWidth(5); c.setLineCap(.round)
    for r: CGFloat in [9, 17] { c.addArc(center: CGPoint(x: 72, y: 74), radius: r, startAngle: -15 * .pi / 180, endAngle: 60 * .pi / 180, clockwise: false); c.strokePath() }
}
func victory(_ c: CGContext) {
    var h = Hand()
    h.pieces.append(piece(CGRect(x: 32, y: 46, width: 14, height: 50), radius: 7, angle: 14, about: CGPoint(x: 39, y: 48)))  // index
    h.pieces.append(piece(CGRect(x: 50, y: 46, width: 14, height: 50), radius: 7, angle: -12, about: CGPoint(x: 57, y: 48))) // middle
    h.pieces.append(piece(CGRect(x: 28, y: 8, width: 50, height: 48), radius: 18))                                          // palm
    for i in 0..<2 { h.pieces.append(piece(CGRect(x: 52, y: 12 + CGFloat(i) * 13, width: 30, height: 15), radius: 7.5)) }    // ring, little
    h.pieces.append(piece(CGRect(x: 20, y: 16, width: 36, height: 14), radius: 7, angle: 24, about: CGPoint(x: 24, y: 22)))  // thumb across
    h.creases.append((CGPoint(x: 56, y: 26), CGPoint(x: 76, y: 26)))
    h.creases.append((CGPoint(x: 47, y: 52), CGPoint(x: 48, y: 62)))
    draw(c, h)
}
// The owner's pictures (23 Nov 2026, 20:00: «usa queste icone»), 512×512 with transparency, in assets/hand-source/:
// thumbsUp, wave, victory, palm (the open hand, also shown for the Force) and ok (no gesture of the robot yet). The thumb
// down is the thumb up turned upside down. A hand without a picture would be drawn (thumbsUp… victory below).
func source(_ name: String) -> CGImage? {
    func read(_ n: String) -> CGImage? {
        guard let s = CGImageSourceCreateWithURL(URL(fileURLWithPath: assets + "hand-source/" + n + ".png") as CFURL, nil) else { return nil }
        return CGImageSourceCreateImageAtIndex(s, 0, nil)
    }
    if name != "thumbsDown" { return read(name) }
    guard let up = read("thumbsUp") else { return nil }
    let c = CGContext(data: nil, width: up.width, height: up.height, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    c.translateBy(x: 0, y: CGFloat(up.height)); c.scaleBy(x: 1, y: -1); c.draw(up, in: CGRect(x: 0, y: 0, width: up.width, height: up.height))
    return c.makeImage()
}
let hands: [(String, (CGContext) -> Void)] = [("thumbsUp", thumbsUp), ("thumbsDown", thumbsDown), ("wave", wave), ("victory", victory), ("palm", { _ in fatalError("palm.png missing in assets/hand-source") })]
var sheet: [(String, CGImage)] = []
for style in ["girl-", "white-", "red-", "curly-"] {
    let files = try FileManager.default.contentsOfDirectory(atPath: assets).filter { $0.hasPrefix(style) && $0.hasSuffix(".png") && !$0.contains("hand-") }.sorted()
    guard let base = load(assets + style + "neutral.png") else { fatalError("\(style)neutral.png") }
    let at = { (x: Int, y: Int) in (y * 320 + x) * 4 }
    let reference = Array(base[at(box.left, box.top)..<at(box.left, box.top) + 3])
    var worst = 0, checked = 0
    for file in files {
        guard let px = load(assets + file) else { continue } // the small pictures (mouths, eyes)
        checked += 1; var mine = 0; defer { print("  \(file) \(mine)"); fflush(stdout) }
        // Only the badge's four rounded corners show the face's background (5×5 points each): those must be background.
        for (cx, cy) in [(0, 0), (box.size - 5, 0), (0, box.size - 5), (box.size - 5, box.size - 5)] {
            for y in (box.top + cy)..<(box.top + cy + 5) { for x in (box.left + cx)..<(box.left + cx + 5) {
                let i = at(x, y); let d = (0..<3).map { abs(Int(px[i + $0]) - Int(reference[$0])) }.max()!; worst = max(worst, d); mine = max(mine, d)
            } }
        }
    }
    print("\(style): corner \(reference) in \(checked) pictures, largest difference \(worst)"); fflush(stdout)
    // The badge covers the box but its rounded corners: a shaded background (the blonde's, 23 Nov 2026) is fine there;
    // hair or a face in the box is not.
    if worst > 60 { fatalError("\(style): the corner is not background in every picture") }
    for (name, draw) in hands {
        let n = box.size
        let ctx = CGContext(data: nil, width: n, height: n, bitsPerComponent: 8, bytesPerRow: n * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
        ctx.setFillColor(CGColor(red: CGFloat(reference[0]) / 255, green: CGFloat(reference[1]) / 255, blue: CGFloat(reference[2]) / 255, alpha: 1)); ctx.fill(CGRect(x: 0, y: 0, width: n, height: n))
        let badge = CGPath(roundedRect: CGRect(x: 1, y: 1, width: n - 2, height: n - 2), cornerWidth: 9, cornerHeight: 9, transform: nil)
        ctx.addPath(badge); ctx.setFillColor(CGColor(red: 0.13, green: 0.15, blue: 0.22, alpha: 1)); ctx.fillPath()
        ctx.addPath(badge); ctx.setStrokeColor(CGColor(red: 0.42, green: 0.46, blue: 0.56, alpha: 1)); ctx.setLineWidth(1.5); ctx.strokePath()
        if let picture = source(name) { ctx.interpolationQuality = .high; ctx.draw(picture, in: CGRect(x: 2, y: 2, width: n - 4, height: n - 4)) }
        else { ctx.saveGState(); ctx.translateBy(x: 3, y: 3); ctx.scaleBy(x: CGFloat(n - 6) / 100, y: CGFloat(n - 6) / 100); draw(ctx); ctx.restoreGState() }
        let image = ctx.makeImage()!
        write(image, assets + style + "hand-" + name + ".png"); sheet.append((style + name, image))
    }
}
// A large picture of them all, to look at.
if let folder = check {
    let scale = 4, n = box.size * scale, cols = hands.count
    let ctx = CGContext(data: nil, width: n * cols, height: n * 4, bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    ctx.interpolationQuality = .none
    for (i, (_, image)) in sheet.enumerated() { ctx.draw(image, in: CGRect(x: (i % cols) * n, y: (3 - i / cols) * n, width: n, height: n)) }
    write(ctx.makeImage()!, folder + "/hands-check.png")
}
