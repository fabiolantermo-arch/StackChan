// The blonde's talking poses (assets/girl-talk-*-full.png, as drawn) also raise the brows and widen
// the eyes, so the whole face jumped at every syllable. Like the red-haired face, keep the serene
// face (girl-neutral) and take only the mouth area from the talking poses, with a soft edge.
// Writes assets/girl-talk-small.png and girl-talk-open.png and the matching iOS imagesets.
// Run from the repository root: swift firmware/stackchan-mod/prepare-blonde-mouth.swift
import AppKit
import CoreImage
let assets = "firmware/stackchan-mod/assets/"
func load(_ name: String) -> CIImage { CIImage(cgImage: NSImage(contentsOfFile: assets + name)!.cgImage(forProposedRect: nil, context: nil, hints: nil)!) }
let neutral = load("girl-neutral.png")
let context = CIContext()
// From under the nose to above the chin and past the lip corners (lips span x 135…190, y 180…218).
let ellipse = CIFilter(name: "CIRadialGradient", parameters: ["inputCenter": CIVector(x: 0, y: 0), "inputRadius0": 0.8, "inputRadius1": 1.0,
                       "inputColor0": CIColor.white, "inputColor1": CIColor.clear])!.outputImage!
    .transformed(by: CGAffineTransform(scaleX: 40, y: 26).concatenating(CGAffineTransform(translationX: 163, y: 240 - 199)))
    .cropped(to: CGRect(x: 0, y: 0, width: 320, height: 240))
for name in ["talk-small", "talk-open"] {
    let blend = CIFilter(name: "CIBlendWithAlphaMask", parameters: [kCIInputImageKey: load("girl-\(name)-full.png"),
        kCIInputBackgroundImageKey: neutral, kCIInputMaskImageKey: ellipse])!.outputImage!
    let image = context.createCGImage(blend, from: CGRect(x: 0, y: 0, width: 320, height: 240))!
    let png = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])!
    try! png.write(to: URL(fileURLWithPath: assets + "girl-\(name).png"))
    try! png.write(to: URL(fileURLWithPath: "ios/Robottino/Assets.xcassets/Face-\(name).imageset/face.png"))
}
print("Prepared the blonde's talking mouths over the serene face. No firmware or cloud changes.")
