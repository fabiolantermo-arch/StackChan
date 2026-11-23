// The red dot that blinks in the top right corner during a conversation (owner, 14 Nov 2026, 20:01: «durante la
// chiamata fai apparire un puntino rosso lampeggiante sullo schermo in alto a destra»). The face's pictures have no
// transparency (faster to draw), so the dot is a small opaque picture: the corner of the face's serene picture with a
// red disc on it, one for each face. Checks first that the corner is the same plain background in every picture of
// that face (otherwise the dot's square would show), and stops if not.
// Writes assets/<style>call-dot.png (CALL_DOT in portrait-state.js gives where it goes).
// Run from the repository root: swift firmware/stackchan-mod/prepare-call-dot.swift
import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

let assets = "firmware/stackchan-mod/assets/"
let box = (left: 298, top: 8, size: 14)
func load(_ path: String) -> [UInt8]? {
    guard let src = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let img = CGImageSourceCreateImageAtIndex(src, 0, nil), img.width == 320, img.height == 240 else { return nil }
    let ctx = CGContext(data: nil, width: 320, height: 240, bitsPerComponent: 8, bytesPerRow: 320 * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    ctx.draw(img, in: CGRect(x: 0, y: 0, width: 320, height: 240))
    return Array(UnsafeBufferPointer(start: ctx.data!.assumingMemoryBound(to: UInt8.self), count: 320 * 240 * 4))
}
for style in ["girl-", "white-", "red-", "curly-"] {
    let files = try FileManager.default.contentsOfDirectory(atPath: assets).filter { $0.hasPrefix(style) && $0.hasSuffix(".png") }.sorted()
    guard let base = load(assets + style + "neutral.png") else { fatalError("\(style)neutral.png") }
    let at = { (x: Int, y: Int) in (y * 320 + x) * 4 }
    let reference = Array(base[at(box.left, box.top)..<at(box.left, box.top) + 3])
    var worst = 0, checked = 0
    for file in files {
        guard let px = load(assets + file) else { continue } // the small pictures (mouths, eyes)
        checked += 1
        for y in (box.top - 2)..<(box.top + box.size + 2) { for x in (box.left - 2)..<min(320, box.left + box.size + 2) {
            let i = at(x, y); worst = max(worst, (0..<3).map { abs(Int(px[i + $0]) - Int(reference[$0])) }.max()!)
        } }
    }
    print("\(style): corner \(reference) in \(checked) pictures, largest difference \(worst)")
    if worst > 24 { fatalError("\(style): the corner is not a plain background in every picture") }
    // The disc, with a soft edge over the corner's own colour.
    var out = [UInt8](repeating: 255, count: box.size * box.size * 4)
    let centre = Double(box.size) / 2, radius = centre - 1.2
    for y in 0..<box.size { for x in 0..<box.size {
        let d = hypot(Double(x) + 0.5 - centre, Double(y) + 0.5 - centre), cover = max(0, min(1, radius + 0.5 - d))
        let red: [Double] = [235, 30, 35]
        for c in 0..<3 { out[(y * box.size + x) * 4 + c] = UInt8((Double(reference[c]) * (1 - cover) + red[c] * cover).rounded()) }
    } }
    let ctx = CGContext(data: &out, width: box.size, height: box.size, bitsPerComponent: 8, bytesPerRow: box.size * 4,
                        space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
    let dst = CGImageDestinationCreateWithURL(URL(fileURLWithPath: assets + style + "call-dot.png") as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dst, ctx.makeImage()!, nil); if !CGImageDestinationFinalize(dst) { fatalError("cannot write") }
}
