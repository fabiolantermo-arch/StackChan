// Lends a camera of this Mac to the iOS Simulator, which has no camera. It prefers the iPhone used as
// a webcam (Continuity Camera: Apple always uses the iPhone's rear camera for this, so turn its back
// toward you), otherwise the Mac's own camera. Add --mac to force the Mac's camera.
// Only on this Mac (127.0.0.1:8765): each frame is sent as a 4-byte big-endian length + JPEG.
// The Robottino app uses it only when it runs in the Simulator (Live → «Imita il mio viso»).
// Run: swift scripts/mac-camera.swift [--mac]   (macOS asks once for camera permission). Ctrl+C stops it.
import AVFoundation
import CoreImage
import Foundation
import Network

let port: NWEndpoint.Port = 8765
let queue = DispatchQueue(label: "robottino.mac-camera")

final class Streamer: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    private var clients: [ObjectIdentifier: NWConnection] = [:]
    private let context = CIContext()
    private var last = 0.0
    func add(_ connection: NWConnection) {
        let id = ObjectIdentifier(connection)
        connection.stateUpdateHandler = { [weak self] state in
            switch state {
            case .failed, .cancelled: queue.async { self?.clients[id] = nil; print("App scollegata.") }
            default: break
            }
        }
        connection.start(queue: queue)
        clients[id] = connection
        print("App collegata.")
    }
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        let now = CACurrentMediaTime()
        guard !clients.isEmpty, now - last >= 0.1, let pixels = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        last = now
        var image = CIImage(cvPixelBuffer: pixels)
        let scale = 640 / image.extent.width
        if scale < 1 { image = image.transformed(by: CGAffineTransform(scaleX: scale, y: scale)) }
        guard let jpeg = context.jpegRepresentation(of: image, colorSpace: CGColorSpaceCreateDeviceRGB(), options: [kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: 0.6]) else { return }
        var length = UInt32(jpeg.count).bigEndian
        let packet = Data(bytes: &length, count: 4) + jpeg
        for client in clients.values { client.send(content: packet, completion: .idempotent) }
    }
}

let streamer = Streamer()
let semaphore = DispatchSemaphore(value: 0)
var allowed = false
AVCaptureDevice.requestAccess(for: .video) { allowed = $0; semaphore.signal() }
semaphore.wait()
let cameras = AVCaptureDevice.DiscoverySession(deviceTypes: [.continuityCamera, .builtInWideAngleCamera, .external], mediaType: .video, position: .unspecified).devices
let preferred = CommandLine.arguments.contains("--mac") ? nil : cameras.first { $0.deviceType == .continuityCamera }
guard allowed, let camera = preferred ?? cameras.first(where: { $0.deviceType == .builtInWideAngleCamera }) ?? cameras.first else {
    print("Fotocamera del Mac non autorizzata o assente. Consenti l’accesso in Impostazioni di Sistema → Privacy e sicurezza → Fotocamera.")
    exit(1)
}
let session = AVCaptureSession()
session.sessionPreset = .vga640x480
let input = try AVCaptureDeviceInput(device: camera)
let output = AVCaptureVideoDataOutput()
output.alwaysDiscardsLateVideoFrames = true
output.setSampleBufferDelegate(streamer, queue: queue)
guard session.canAddInput(input), session.canAddOutput(output) else { print("Impossibile usare la fotocamera."); exit(1) }
session.addInput(input); session.addOutput(output)
session.startRunning()

let parameters = NWParameters.tcp
parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: port)
let listener = try NWListener(using: parameters)
listener.newConnectionHandler = { streamer.add($0) }
listener.stateUpdateHandler = { state in
    if case .failed(let error) = state { print("Porta \(port) non disponibile: \(error)"); exit(1) }
    if case .ready = state { print("Fotocamera del Mac pronta per il simulatore (\(camera.localizedName)). Ctrl+C per fermare.") }
}
listener.start(queue: queue)
dispatchMain()
