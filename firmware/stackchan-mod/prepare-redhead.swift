// Cuts the six 320×240 expressions of the red-haired face from the ChatGPT grid
// (assets/red-atlas-source.png, 3×2 tiles with labels at the bottom, provided by the user on
// 7 November 2026). Per-tile offsets (dx, dy) align the head on the first tile.
// Run from the repository root: swift firmware/stackchan-mod/prepare-redhead.swift
import AppKit
import CoreImage
let assets = "firmware/stackchan-mod/assets/"
let cg = NSImage(contentsOfFile: assets + "red-atlas-source.png")!.cgImage(forProposedRect: nil, context: nil, hints: nil)!
let width = 476
let tiles=[(2,2,0,0),(484,2,1,0),(967,2,1,1),(2,544,0,0),(484,544,1,0),(967,544,1,0)]
let names=["neutral","happy","sad","blink","talk-small","talk-open"]
var frames: [String: CGImage] = [:]
let left = (478 - width) / 2
// 9 Nov 2026 (owner's request): the face slightly smaller, so the whole hair, bun included, fits the screen.
// Until then each tile was cut 50 points below its top edge and filled the screen (scale 320/476 ≈ 0.67):
// the bun was cut off. Now each tile is drawn from its first row at scale 0.60, from the top of the screen,
// centred; the bands left free at the sides continue the blue background. The bun already touches the top of
// the grid tile, so it starts at the very top of the screen, as if just out of frame.
let scale = 0.60, topPad = 0.0, cropTop = 1
let cropHeight = Int(((240 - topPad) / scale).rounded(.up)), drawnWidth = Double(width) * scale
let originX = (320 - drawnWidth) / 2
let render = CIContext()
for (i,t) in tiles.enumerated() {
  let r = CGRect(x: t.0 + t.2 + left, y: t.1 + t.3 + cropTop, width: width, height: cropHeight)
  // The edges are continued before scaling, so the side bands are the same blue (no half-transparent seam).
  let piece = CIImage(cgImage: cg.cropping(to: r)!).clampedToExtent()
  // Core Image counts y from the bottom: the top of the picture lands topPad below the top of the screen.
  let placed = piece.transformed(by: CGAffineTransform(scaleX: scale, y: scale)
      .concatenating(CGAffineTransform(translationX: originX, y: 240 - topPad - Double(cropHeight) * scale)))
  frames[names[i]] = render.createCGImage(placed.cropped(to: CGRect(x: 0, y: 0, width: 320, height: 240)),
                                          from: CGRect(x: 0, y: 0, width: 320, height: 240), format: .RGBA8, colorSpace: CGColorSpaceCreateDeviceRGB())!
}
// Where a point of a tile lands on the screen (x from the left, y from the top).
func onScreen(_ x: Double, _ y: Double) -> (Double, Double) { ((x - Double(left)) * scale + originX, (y - Double(cropTop)) * scale + topPad) }
// In the talking frames ChatGPT also changed eyes and brows (the open mouth looks surprised): the
// whole face jumped at every syllable. Keep the serene face and take only the mouth area, with a
// soft edge, so only the mouth moves while speaking.
let context = render
// The area spans from just under the nose to the chin and well past the lip corners, so neither
// the closed lip line nor the upper lip of the serene face shows through. Fully replaced inside
// 80% of the ellipse, softened only near its edge. In tile points: centre (246.4, 337.1), radii 77.3 × 50.6
// (the same area as before the face was made smaller: centre (165, 193), radii 52 × 34 on screen).
let (mouthX, mouthY) = onScreen(246.4, 337.1)
let ellipse = CIFilter(name: "CIRadialGradient", parameters: ["inputCenter": CIVector(x: 0, y: 0), "inputRadius0": 0.8, "inputRadius1": 1.0,
                       "inputColor0": CIColor.white, "inputColor1": CIColor.clear])!.outputImage!
    .transformed(by: CGAffineTransform(scaleX: 77.3 * scale, y: 50.6 * scale).concatenating(CGAffineTransform(translationX: mouthX, y: 240 - mouthY)))
    .cropped(to: CGRect(x: 0, y: 0, width: 320, height: 240))
for name in ["talk-small", "talk-open"] {
    let blend = CIFilter(name: "CIBlendWithAlphaMask", parameters: [kCIInputImageKey: CIImage(cgImage: frames[name]!),
        kCIInputBackgroundImageKey: CIImage(cgImage: frames["neutral"]!), kCIInputMaskImageKey: ellipse])!.outputImage!
    frames[name] = context.createCGImage(blend, from: CGRect(x: 0, y: 0, width: 320, height: 240))!
}
for (name, image) in frames {
  try! NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: assets + "red-" + name + ".png"))
}
print("Prepared six 320×240 red-haired expressions. No firmware or cloud changes.")
