import CoreMotion
import SwiftUI
import UIKit
@preconcurrency import AVFoundation
import Vision
import CoreML
import PhotosUI
import ImageIO
import CoreBluetooth
import UserNotifications
import Network

extension UIImage {
    static func robotRGB(_ packet: RobotMediaPacket) -> UIImage? {
        if packet.kind == 7 {
            // Grey frame for face following (160×120 from the robot, 80×60 while it listens): one byte a pixel, shown and analysed as it is.
            guard packet.payload.count == packet.width * packet.height, let provider = CGDataProvider(data: packet.payload as CFData),
                  let cg = CGImage(width: packet.width, height: packet.height, bitsPerComponent: 8, bitsPerPixel: 8, bytesPerRow: packet.width, space: CGColorSpaceCreateDeviceGray(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue), provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { return nil }
            return UIImage(cgImage: cg)
        }
        guard packet.kind == 1 else { return nil }
        let input = [UInt8](packet.payload); var rgba = [UInt8](repeating: 255, count: packet.width * packet.height * 4)
        for i in 0..<(packet.width * packet.height) {
            let pixel = UInt16(input[i * 2]) | UInt16(input[i * 2 + 1]) << 8
            rgba[i * 4] = UInt8((pixel >> 11) * 255 / 31); rgba[i * 4 + 1] = UInt8(((pixel >> 5) & 63) * 255 / 63); rgba[i * 4 + 2] = UInt8((pixel & 31) * 255 / 31)
        }
        guard let provider = CGDataProvider(data: Data(rgba) as CFData), let cg = CGImage(width: packet.width, height: packet.height, bitsPerComponent: 8, bitsPerPixel: 32, bytesPerRow: packet.width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.last.rawValue), provider: provider, decode: nil, shouldInterpolate: true, intent: .defaultIntent) else { return nil }
        return UIImage(cgImage: cg)
    }
    func robotPixels(width: Int = 320, height: Int = 240) -> Data? {
        // Rasterize to a fixed canvas: bounded dimensions, no EXIF/location metadata.
        let format = UIGraphicsImageRendererFormat(); format.scale = 1; format.opaque = true
        let image = UIGraphicsImageRenderer(size: CGSize(width: width, height: height), format: format).image { context in
            UIColor.black.setFill(); context.fill(CGRect(x: 0, y: 0, width: width, height: height))
            let ratio = min(CGFloat(width) / size.width, CGFloat(height) / size.height)
            let rect = CGRect(x: (CGFloat(width) - size.width * ratio) / 2, y: (CGFloat(height) - size.height * ratio) / 2, width: size.width * ratio, height: size.height * ratio)
            draw(in: rect)
        }
        guard let cg = image.cgImage else { return nil }
        var rgba = [UInt8](repeating: 0, count: width * height * 4)
        let drawn = rgba.withUnsafeMutableBytes { bytes -> Bool in
            guard let context = CGContext(data: bytes.baseAddress, width: width, height: height, bitsPerComponent: 8, bytesPerRow: width * 4, space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
            context.draw(cg, in: CGRect(x: 0, y: 0, width: width, height: height)); return true
        }
        guard drawn else { return nil }
        var pixels = Data(capacity: width * height * 2)
        for i in 0..<(width * height) {
            let value = UInt16(rgba[i * 4] >> 3) << 11 | UInt16(rgba[i * 4 + 1] >> 2) << 5 | UInt16(rgba[i * 4 + 2] >> 3)
            pixels.append(UInt8(value & 255)); pixels.append(UInt8(value >> 8))
        }
        return pixels
    }
}

// Each detector is driven by a single serial queue (camera delegate or robot analysis),
// and its callbacks hop to the main actor: no state is shared across threads.
final class RobotFaceDetector: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate, @unchecked Sendable {
    var onPose: ((RobotFacePose) -> Void)?
    var onMissing: (() -> Void)?
    var onFailure: (() -> Void)?
    /// Face following: frame number and face centre (0…1, y from the top) in that robot frame.
    var onTarget: ((UInt32, Double, Double) -> Void)?
    /// Nobody in the frame: the head takes a step to look (up at the start, toward where the face went).
    var onSearching: (() -> Void)?
    /// «Seguimi con la fotocamera dell’iPhone»: the face's box in the front camera's mirrored image.
    /// The box, and whether the image is wider than tall (phone on its side). The camera itself delivers the image
    /// upright and mirrored (startPhoneFollow), however the phone is held.
    var onPhoneFace: ((CGRect, Bool) -> Void)?
    private var last = 0.0
    private var yaw = 0.0, pitch = 0.0
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let image = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        if onPhoneFace != nil { phoneFace(VNImageRequestHandler(cvPixelBuffer: image, orientation: .up), landscape: CVPixelBufferGetWidth(image) > CVPixelBufferGetHeight(image)) }
        else { analyze(VNImageRequestHandler(cvPixelBuffer: image, orientation: .leftMirrored)) }
    }
    /// Only where the face is, up to twenty times a second (owner, 10 Nov 2026): the largest face the camera is
    /// sure enough of. The head still takes one command at a time, about five a second.
    private func phoneFace(_ handler: VNImageRequestHandler, landscape: Bool) {
        guard CACurrentMediaTime() - last > 0.045 else { return }
        defer { last = CACurrentMediaTime() }
        let request = VNDetectFaceRectanglesRequest(); Self.prepare(request)
        do { try handler.perform([request]) } catch { onFailure?(); return }
        guard let face = request.results?.filter({ RobotFaceFollow.accepts(confidence: $0.confidence) }).max(by: { $0.boundingBox.height < $1.boundingBox.height }) else { onMissing?(); return }
        onPhoneFace?(face.boundingBox, landscape)
    }
    func robotFrame(_ image: CGImage) {
        analyze(VNImageRequestHandler(cgImage: image, orientation: .up))
    }
    /// A webcam frame lent by the Mac to the Simulator: mirrored, like the iPhone front camera.
    func macFrame(_ image: CGImage) {
        analyze(VNImageRequestHandler(cgImage: image, orientation: .upMirrored))
    }
    /// Face following: only where the face is (no landmarks, quicker). The robot paces its frames, and the
    /// panel analyses one at a time, so every frame that arrives is looked at. A face cut by the edge, a person
    /// seen from behind, a face that just left the frame: `RobotFaceFollowMemory` (9 Nov 2026).
    private var followMemory = RobotFaceFollowMemory()
    /// `free`: an answer could leave now (the app sends one at a time), so a search step would not be wasted.
    func robotFollowFrame(_ image: CGImage, frameID: UInt32, free: Bool) {
        let now = ProcessInfo.processInfo.systemUptime, handler = VNImageRequestHandler(cgImage: image, orientation: .up), small = image.width <= 80
        let faces = VNDetectFaceRectanglesRequest(); Self.prepare(faces)
        do { try handler.perform([faces]) } catch { onFailure?(); return }
        let box = { (r: CGRect) in RobotFaceFollowMemory.Box(x: r.minX, y: r.minY, width: r.width, height: r.height) }
        if let face = faces.results?.filter({ RobotFaceFollow.accepts(confidence: $0.confidence) }).max(by: { $0.boundingBox.height < $1.boundingBox.height }),
           let target = followMemory.seen(box(face.boundingBox), at: now, small: small) { onTarget?(frameID, target.x, target.y); return }
        let people = VNDetectHumanRectanglesRequest(); people.upperBodyOnly = true; Self.prepare(people)
        if (try? handler.perform([people])) != nil,
           let body = people.results?.filter({ $0.confidence >= RobotFaceFollow.minimumConfidence }).max(by: { $0.boundingBox.height < $1.boundingBox.height }),
           let target = followMemory.seenBody(box(body.boundingBox), at: now) { onTarget?(frameID, target.x, target.y); return }
        if let search = followMemory.missing(at: now, frame: frameID, free: free) { onTarget?(frameID, search.x, search.y); onSearching?(); return }
        onMissing?()
    }
    private static func prepare(_ request: VNImageBasedRequest) {
        #if targetEnvironment(simulator)
        // The Simulator has no Neural Engine/GPU path for Vision: run every stage on the CPU.
        if let cpu = MLComputeDevice.allComputeDevices.first(where: { if case .cpu = $0 { return true } else { return false } }),
           let stages = try? request.supportedComputeStageDevices {
            for stage in stages.keys { request.setComputeDevice(cpu, for: stage) }
        }
        #endif
    }
    private func analyze(_ handler: VNImageRequestHandler) {
        // At least 0.2 s between the end of one analysis and the next: a slow analysis never queues a burst.
        guard CACurrentMediaTime() - last > 0.2 else { return }
        defer { last = CACurrentMediaTime() }
        let request = VNDetectFaceLandmarksRequest(); Self.prepare(request)
        do { try handler.perform([request]) } catch { onFailure?(); return }
        guard let face = request.results?.max(by: { $0.boundingBox.width < $1.boundingBox.width }), face.confidence > 0.8 else { onMissing?(); return }
        func openness(_ region: VNFaceLandmarkRegion2D?, factor: CGFloat, fallback: Double = 1) -> Double {
            guard let points = region?.normalizedPoints, points.count >= 3 else { return fallback }
            let x = points.map(\.x), y = points.map(\.y), width = (x.max() ?? 0) - (x.min() ?? 0)
            guard width > 0 else { return fallback }
            return min(1, max(0, Double(((y.max() ?? 0) - (y.min() ?? 0)) / width / factor)))
        }
        let newYaw = min(10, max(-10, (face.yaw?.doubleValue ?? 0) * 180 / .pi * 0.5))
        let newPitch = min(10, max(-10, (face.pitch?.doubleValue ?? 0) * 180 / .pi * 0.5))
        yaw = yaw * 0.65 + newYaw * 0.35; pitch = pitch * 0.65 + newPitch * 0.35
        let pose = RobotFacePose(yaw: yaw, pitch: pitch, leftEye: openness(face.landmarks?.leftEye, factor: 0.25), rightEye: openness(face.landmarks?.rightEye, factor: 0.25), mouth: openness(face.landmarks?.innerLips, factor: 0.5, fallback: 0))
        if pose.valid() { onPose?(pose) }
    }
}

/// How the phone is held, shared between the camera's thread and the page.
final class RobotOrientationBox: @unchecked Sendable { var landscape = false; var tilt = 0.0 }

/// The call's packer, held by the microphone tap (one thread) of one call.
final class RobotCallPackerBox { var value = RobotCallAudio.Packer() }

@MainActor final class RobotPhoneMedia: ObservableObject {
    @Published var robotImage: UIImage?
    @Published private(set) var calling = false
    @Published private(set) var mirroring = false
    @Published var note = ""
    @Published private(set) var robotMirroring = false
    @Published private(set) var following = false
    /// «Seguimi con la fotocamera dell’iPhone» is on.
    @Published private(set) var phoneFollowing = false
    /// Where the head should look, from the phone's camera (degrees, as the head joystick).
    var onAim: ((Int, Int) -> Void)?
    @Published var faceNote = ""
    var onPCM: ((Data) -> Void)?
    var onFace: ((RobotFacePose) -> Void)?
    var onTarget: ((UInt32, Double, Double) -> Void)?
    /// Face following: whether an answer could leave right now. Asked when a robot frame arrives.
    var canAnswer: (() -> Bool)?
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var outputFormat: AVAudioFormat?
    private var audioGeneration = UUID(), faceGeneration = UUID()
    var faceSessionID: UUID { faceGeneration }
    private var playingBuffers = 0
    private var callPlayer = RobotCallAudio.Player()
    private var audioObserver: NSObjectProtocol?
    private var capture: AVCaptureSession?
    private let motion = CMMotionManager()
    private var detector: RobotFaceDetector?
    /// Simulator only: frames from scripts/mac-camera.swift on 127.0.0.1:8765.
    private var macCamera: NWConnection?
    private let cameraQueue = DispatchQueue(label: "robottino.camera.lifecycle")
    private let analysisQueue = DispatchQueue(label: "robottino.face.robot")
    private var analysisBusy = false
    func video(_ packet: RobotMediaPacket) {
        robotImage = UIImage.robotRGB(packet)
        guard robotMirroring || following, !analysisBusy, let image = robotImage?.cgImage, let detector else { return }
        analysisBusy = true; let generation = faceGeneration, follow = following, frameID = packet.frameID, free = canAnswer?() ?? true
        analysisQueue.async { [weak self] in
            if follow { detector.robotFollowFrame(image, frameID: frameID, free: free) } else { detector.robotFrame(image) }
            Task { @MainActor in if let self, self.faceGeneration == generation { self.analysisBusy = false } }
        }
    }
    private func configureDetector(_ detector: RobotFaceDetector, generation: UUID) {
        detector.onPose = { [weak self] pose in Task { @MainActor in guard let self, self.mirroring, self.faceGeneration == generation else { return }; self.faceNote = "Viso rilevato"; self.onFace?(pose) } }
        detector.onFailure = { [weak self] in Task { @MainActor in guard let self, self.mirroring, self.faceGeneration == generation else { return }; self.faceNote = "Analisi del viso non disponibile." } }
        detector.onMissing = { [weak self] in Task { @MainActor in guard let self, self.mirroring, self.faceGeneration == generation else { return }; self.faceNote = "Viso non rilevato: guarda la camera e avvicinati." } }
    }
    /// «Segui il mio viso»: Vision looks for the face in each small frame of the robot camera.
    func startRobotFollow() {
        stopFace(); let generation = UUID(); faceGeneration = generation
        let detector = RobotFaceDetector()
        detector.onTarget = { [weak self] frameID, x, y in Task { @MainActor in guard let self, self.following, self.faceGeneration == generation else { return }; self.onTarget?(frameID, x, y) } }
        detector.onFailure = { [weak self] in Task { @MainActor in guard let self, self.following, self.faceGeneration == generation else { return }; self.faceNote = "Analisi del viso non disponibile." } }
        detector.onMissing = { [weak self] in Task { @MainActor in guard let self, self.following, self.faceGeneration == generation else { return }; self.faceNote = "Non ti vedo: mettiti davanti al robot. La testa resta dov’è." } }
        detector.onSearching = { [weak self] in Task { @MainActor in guard let self, self.following, self.faceGeneration == generation else { return }; self.faceNote = "Non ti vedo: ti cerco girando la testa." } }
        self.detector = detector; following = true
        faceNote = "Attendo le immagini della camera del robot…"
    }
    func startRobotFace() {
        stopFace(); let generation = UUID(); faceGeneration = generation
        let detector = RobotFaceDetector(); configureDetector(detector, generation: generation)
        self.detector = detector; mirroring = true; robotMirroring = true
        faceNote = "Attendo il viso nel video del robot…"
        // A fresh incoming frame is required. Never analyze a stale preview.
    }
    func startAudio() async throws {
        guard !calling else { return }
        let generation = UUID(); audioGeneration = generation
        guard await AVAudioApplication.requestRecordPermission() else { throw RobotLiveError.rejected("microfono non autorizzato") }
        guard audioGeneration == generation else { throw RobotLiveError.offline }
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try audioSession.setActive(true)
        let engine = AVAudioEngine(), player = AVAudioPlayerNode()
        var tapInstalled = false
        do {
            try engine.inputNode.setVoiceProcessingEnabled(true)
            let input = engine.inputNode.outputFormat(forBus: 0)
            guard input.sampleRate > 0, let pcm = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true), let converter = AVAudioConverter(from: input, to: pcm), let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16000, channels: 1, interleaved: false) else { throw RobotLiveError.invalid }
            engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: output)
            // The call's audio leaves as 8 kHz µ-law in pieces of a tenth of a second (RobotCallAudio). The packer is
            // used only here, on the microphone's thread, and a new call starts with a new one.
            let packer = RobotCallPackerBox(); callPlayer.clear()
            engine.inputNode.installTap(onBus: 0, bufferSize: 960, format: input) { [weak self] buffer, _ in
                let capacity = AVAudioFrameCount(Double(buffer.frameLength) * 16000 / input.sampleRate + 64)
                guard let converted = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: capacity) else { return }
                var supplied = false, error: NSError?
                converter.convert(to: converted, error: &error) { _, status in
                    if supplied { status.pointee = .noDataNow; return nil }
                    supplied = true; status.pointee = .haveData; return buffer
                }
                guard error == nil, let samples = converted.int16ChannelData?[0], converted.frameLength > 0 else { return }
                let pieces = packer.value.add(Data(bytes: samples, count: Int(converted.frameLength) * 2))
                guard !pieces.isEmpty else { return }
                Task { @MainActor in
                    guard let self, self.calling, self.audioGeneration == generation else { return }
                    for piece in pieces { self.onPCM?(piece) }
                }
            }
            tapInstalled = true
            self.engine = engine; self.player = player; outputFormat = output
            try engine.start(); player.play(); calling = true
            // iOS stops the engine and can drop the player's connection when the route changes: rewire and restart.
            audioObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.calling, self.audioGeneration == generation, let engine = self.engine, let player = self.player else { return }
                    engine.stop(); engine.connect(player, to: engine.mainMixerNode, format: self.outputFormat); engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
                    self.playingBuffers = 0
                    do { try engine.start(); player.play() } catch { self.stopAudio() }
                }
            }
        } catch { if tapInstalled { engine.inputNode.removeTap(onBus: 0) }; engine.stop(); self.engine = nil; self.player = nil; outputFormat = nil; try? audioSession.setActive(false); throw error }
    }
    /// The robot's voice: only call audio in the shared format (RobotCallAudio) is played, and at most six pieces
    /// (0.6 s) wait for the speaker; more are dropped, so the delay never grows.
    func receiveAudio(_ data: Data) {
        guard calling, playingBuffers < 6, let player, let outputFormat, let samples = callPlayer.samples(data), let buffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(samples.count)), let output = buffer.floatChannelData?[0] else { return }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        for i in 0..<samples.count { output[i] = Float(samples[i]) / 32768 }
        playingBuffers += 1; let generation = audioGeneration
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in if let self, self.audioGeneration == generation { self.playingBuffers = max(0, self.playingBuffers - 1) } }
        }
    }
    func stopAudio() {
        calling = false; audioGeneration = UUID(); playingBuffers = 0; callPlayer.clear()
        if let audioObserver { NotificationCenter.default.removeObserver(audioObserver) }; audioObserver = nil
        if let engine { engine.inputNode.removeTap(onBus: 0); engine.stop() }
        player?.stop(); engine = nil; player = nil; outputFormat = nil
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }
    func startFace() async throws {
        guard !mirroring else { return }
        let generation = UUID(); faceGeneration = generation
        #if targetEnvironment(simulator)
        try await startMacCamera(generation: generation); return
        #endif
        guard await AVCaptureDevice.requestAccess(for: .video), let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else { throw RobotLiveError.rejected("fotocamera frontale non autorizzata o assente") }
        guard faceGeneration == generation else { throw RobotLiveError.offline }
        let session = AVCaptureSession(), output = AVCaptureVideoDataOutput(), detector = RobotFaceDetector()
        session.beginConfiguration(); session.sessionPreset = .vga640x480
        let input = try AVCaptureDeviceInput(device: camera)
        guard session.canAddInput(input), session.canAddOutput(output) else { session.commitConfiguration(); throw RobotLiveError.invalid }
        session.addInput(input); session.addOutput(output); output.alwaysDiscardsLateVideoFrames = true
        configureDetector(detector, generation: generation)
        output.setSampleBufferDelegate(detector, queue: DispatchQueue(label: "robottino.face")); session.commitConfiguration()
        capture = session; self.detector = detector; mirroring = true; robotMirroring = false; faceNote = "Attendo il viso nella camera iPhone…"
        cameraQueue.async { session.startRunning() }
    }
    /// «Seguimi con la fotocamera dell’iPhone»: the front camera finds the face, the page sends the head there.
    func startPhoneFollow() async throws {
        guard !mirroring, !following, !phoneFollowing else { return }
        let generation = UUID(); faceGeneration = generation
        #if targetEnvironment(simulator)
        throw RobotLiveError.simulatorCamera
        #else
        guard await AVCaptureDevice.requestAccess(for: .video), let camera = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .front) else { throw RobotLiveError.rejected("fotocamera frontale non autorizzata o assente") }
        guard faceGeneration == generation else { throw RobotLiveError.offline }
        let session = AVCaptureSession(), output = AVCaptureVideoDataOutput(), detector = RobotFaceDetector()
        session.beginConfiguration(); session.sessionPreset = .vga640x480
        let input = try AVCaptureDeviceInput(device: camera)
        guard session.canAddInput(input), session.canAddOutput(output) else { session.commitConfiguration(); throw RobotLiveError.invalid }
        session.addInput(input); session.addOutput(output); output.alwaysDiscardsLateVideoFrames = true
        // The angle the camera sees along the long side of its image (vertical with the phone upright).
        let fieldOfView = Double(camera.activeFormat.videoFieldOfView)
        // The phone may stand upright or lie on its side (10 Nov 2026: on its side the head looked the wrong way):
        // the image is turned upright for Vision, and the wide angle goes to the side that is really the long one.
        // The camera turns its own image upright, whatever way the phone is held (10 Nov 2026: with a table of
        // orientations the face was not found with the phone on its side), and mirrors it like a mirror.
        let held = RobotOrientationBox(), rotation = AVCaptureDevice.RotationCoordinator(device: camera, previewLayer: nil), connection = output.connection(with: .video)
        let upright = { if let connection { let angle = rotation.videoRotationAngleForHorizonLevelCapture; if connection.isVideoRotationAngleSupported(angle), connection.videoRotationAngle != angle { connection.videoRotationAngle = angle } } }
        if let connection, connection.isVideoMirroringSupported { connection.automaticallyAdjustsVideoMirroring = false; connection.isVideoMirrored = true }
        upright()
        detector.onPhoneFace = { [weak self] box, landscape in
            guard let aim = RobotPhoneFollow.aim(x: box.minX, y: box.minY, width: box.width, height: box.height, fieldOfView: fieldOfView, landscape: landscape, tilt: held.tilt) else { return }
            Task { @MainActor in guard let self, self.phoneFollowing, self.faceGeneration == generation else { return }; upright(); self.faceNote = "Ti vedo: \(aim.yaw == 0 ? "dritto" : "\(abs(aim.yaw))° \(aim.yaw > 0 ? "a destra" : "a sinistra")"), \(-aim.pitch)° in su."; self.onAim?(aim.yaw, aim.pitch) }
        }
        detector.onFailure = { [weak self] in Task { @MainActor in guard let self, self.phoneFollowing, self.faceGeneration == generation else { return }; self.faceNote = "Analisi del viso non disponibile." } }
        detector.onMissing = { [weak self] in Task { @MainActor in guard let self, self.phoneFollowing, self.faceGeneration == generation else { return }; upright(); self.faceNote = "Non ti vedo nella fotocamera dell’iPhone: la testa resta dov’è." } }
        // How far back the phone leans: the front camera looks out of the screen, and gravity says where down is.
        if motion.isDeviceMotionAvailable {
            motion.deviceMotionUpdateInterval = 0.2
            motion.startDeviceMotionUpdates(to: .main) { data, _ in if let z = data?.gravity.z, z.isFinite { held.tilt = asin(min(1, max(-1, -z))) * 180 / .pi } }
        }
        output.setSampleBufferDelegate(detector, queue: DispatchQueue(label: "robottino.face.phone")); session.commitConfiguration()
        capture = session; self.detector = detector; phoneFollowing = true; faceNote = "Attendo il viso nella fotocamera dell’iPhone…"
        cameraQueue.async { session.startRunning() }
        #endif
    }
    /// The Simulator has no camera: it borrows the Mac's (or the iPhone's via Continuity Camera)
    /// from the local helper. Each frame is a 4-byte big-endian length followed by a JPEG.
    private func startMacCamera(generation: UUID) async throws {
        let detector = RobotFaceDetector(), faceQueue = DispatchQueue(label: "robottino.face")
        let connection = NWConnection(host: "127.0.0.1", port: 8765, using: .tcp)
        let ready: Bool = await withCheckedContinuation { continuation in
            let once = RobotOnce(continuation)
            connection.stateUpdateHandler = { state in
                switch state {
                case .ready: once.resume(true)
                case .failed, .waiting, .cancelled: once.resume(false)
                default: break
                }
            }
            connection.start(queue: faceQueue)
            faceQueue.asyncAfter(deadline: .now() + 2) { once.resume(false) }
        }
        guard ready, faceGeneration == generation else { connection.cancel(); throw RobotLiveError.simulatorCamera }
        connection.stateUpdateHandler = nil
        configureDetector(detector, generation: generation)
        macCamera = connection; self.detector = detector; mirroring = true; robotMirroring = false; faceNote = "Attendo il viso nella fotocamera del Mac…"
        Self.receiveMacFrames(connection, detector: detector)
    }
    private nonisolated static func receiveMacFrames(_ connection: NWConnection, detector: RobotFaceDetector) {
        connection.receive(minimumIncompleteLength: 4, maximumLength: 4) { header, _, _, error in
            guard error == nil, let header, header.count == 4 else { connection.cancel(); return }
            let length = header.reduce(0) { $0 << 8 | Int($1) }
            guard (1...2_000_000).contains(length) else { connection.cancel(); return }
            connection.receive(minimumIncompleteLength: length, maximumLength: length) { jpeg, _, _, error in
                guard error == nil, let jpeg, jpeg.count == length else { connection.cancel(); return }
                if let source = CGImageSourceCreateWithData(jpeg as CFData, nil), let image = CGImageSourceCreateImageAtIndex(source, 0, nil) { detector.macFrame(image) }
                receiveMacFrames(connection, detector: detector)
            }
        }
    }
    func stopFace() {
        macCamera?.cancel(); macCamera = nil
        if motion.isDeviceMotionActive { motion.stopDeviceMotionUpdates() }
        mirroring = false; robotMirroring = false; following = false; phoneFollowing = false; analysisBusy = false; faceNote = ""; faceGeneration = UUID(); detector = nil
        if let capture { cameraQueue.async { capture.stopRunning() } }; capture = nil
    }
    func stopAll() { stopAudio(); stopFace(); robotImage = nil }
}

struct RobotLivePanel: View {
    @EnvironmentObject var store: RobotStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var live = RobotLiveClient()
    @StateObject private var media = RobotPhoneMedia()
    @State private var faceSource = RobotFaceSource.robot
    @State private var cameraOn = false
    @State private var screenOn = false
    @State private var screenFrame: UInt32 = 0
    @State private var yaw = 0.0
    @State private var pitch = 0.0
    @State private var followHead = false
    @State private var mirrorBusy = false
    @State private var followBusy = false
    @State private var aimBusy = false
    @State private var lastAim: (yaw: Int, pitch: Int)?
    @State private var photo: PhotosPickerItem?
    @State private var operationRunning = false
    @State private var operationRevision = UUID()
    var body: some View {
        Form {
                Section("Collegamento reale · Robottino") {
                    Text(live.message)
                    if live.socketConnected { Button("Scollega") { stopEverything() } }
                    else { Button("Collega al robot") { live.connect(token: store.token) }.disabled(store.token.isEmpty) }
                    if live.status?.simulated == true { Label("Dispositivo virtuale di prova", systemImage: "testtube.2") }
                    Text("Il canale richiede il MOD Robottino configurato. Il firmware di fabbrica non usa questo protocollo. Nessuna camera o microfono si avvia all’apertura.").font(.caption)
                }
                Section("Segui il mio viso") {
                    Button(media.following ? "Ferma inseguimento" : "Avvia inseguimento") { run {
                        if media.following { media.stopFace(); try await live.command("track.stop") }
                        else {
                            if cameraOn { try await live.command("camera.stop"); cameraOn = false; media.robotImage = nil }
                            try await live.command("track.start"); media.startRobotFollow()
                        }
                    } }.disabled(!live.ready || live.status?.camera != true || live.status?.motionEnabled != true || media.mirroring || media.phoneFollowing || operationRunning)
                    if media.following, !media.faceNote.isEmpty { Text(media.faceNote) }
                    Text("La camera del robot manda all’iPhone piccole immagini (160×120); l’iPhone trova il tuo viso e dice al robot dove sei, e il robot gira la testa verso di te: fino a 90° ai lati e 85° in su, sempre alla stessa velocità. Il video compare qui sotto. Servono iPhone aperto, collegamento attivo e movimenti attivati sul robot. Il rilevamento non riconosce chi sei e le immagini non vengono salvate.").font(.caption)
                }
                Section("Seguimi con la fotocamera dell’iPhone") {
                    Button(media.phoneFollowing ? "Ferma" : "Avvia con la fotocamera dell’iPhone") { run {
                        if media.phoneFollowing { media.stopFace(); lastAim = nil }
                        else {
                            if media.following { media.stopFace(); try await live.command("track.stop") }
                            lastAim = nil; try await media.startPhoneFollow()
                            // Up first, where the face usually is; the camera then says exactly where.
                            if (try? await live.command("motion", values: RobotHeadJoystick.command(yaw: RobotPhoneFollow.start.yaw, pitch: RobotPhoneFollow.start.pitch))) != nil { lastAim = RobotPhoneFollow.start }
                        }
                    } }.disabled(!live.ready || live.status?.motionEnabled != true || media.mirroring || media.following || operationRunning)
                    if media.phoneFollowing, !media.faceNote.isEmpty { Text(media.faceNote) }
                    Text("Appoggia l’iPhone accanto o subito dietro al robot, in piedi o sul fianco, con lo schermo verso di te come il robot. La fotocamera frontale trova il tuo viso una decina di volte al secondo e la testa del robot va subito a quell’angolo: nessuna immagine viaggia dal robot. Più l’iPhone è vicino al robot, più lo sguardo è preciso. Le immagini restano sul telefono.").font(.caption)
                }
                Section("Imita il mio viso") {
                    Picker("Camera da usare", selection: $faceSource) {
                        Text("Camera del robot").tag(RobotFaceSource.robot)
                        Text("Camera iPhone").tag(RobotFaceSource.phone)
                    }.disabled(media.mirroring || media.following || operationRunning)
                    Toggle("Muovi anche la testa", isOn: $followHead).disabled(live.status?.motionEnabled != true)
                    Button(media.mirroring ? "Ferma imitazione" : "Avvia imitazione") { run {
                        if media.mirroring {
                            media.stopFace()
                            try await live.command("mirror", values: ["yaw":0,"pitch":0,"leftEye":1,"rightEye":1,"mouth":0,"followHead":false])
                        } else if faceSource == .robot {
                            guard live.status?.camera == true else { throw RobotLiveError.rejected("camera del robot non disponibile") }
                            if !cameraOn { try await live.command("camera.start"); cameraOn = true }
                            media.startRobotFace()
                        } else { try await media.startFace() }
                    } }.disabled(!live.ready || media.following || media.phoneFollowing || live.status?.hardwareVerified != true || live.status?.screen != true || (faceSource == .robot && live.status?.camera != true))
                    if !media.faceNote.isEmpty { Text(media.faceNote) }
                    Text(faceSource == .robot ? "La camera del robot ti riprende; l’iPhone analizza il video ricevuto e rimanda le espressioni. La camera iPhone resta spenta. Servono iPhone aperto e collegamento attivo." : "La camera frontale dell’iPhone analizza il tuo viso. I suoi fotogrammi restano sul telefono.").font(.caption)
                    Text("Occhi e bocca usano i sei ritratti disponibili. Precisione e direzione della testa richiedono prove sul robot; il rilevamento non identifica la persona.").font(.caption)
                }
                Section("Video dal robot") {
                    if let image = media.robotImage { Image(uiImage: image).resizable().aspectRatio(contentMode: .fit).accessibilityLabel("Video ricevuto dal robot") }
                    else { Label("Nessun fotogramma ricevuto", systemImage: "video.slash") }
                    Button(cameraOn ? "Ferma video" : "Avvia video live") { run {
                        if cameraOn && media.robotMirroring { media.stopFace(); try await live.command("mirror", values: ["yaw":0,"pitch":0,"leftEye":1,"rightEye":1,"mouth":0,"followHead":false]) }; try await live.command(cameraOn ? "camera.stop" : "camera.start"); cameraOn.toggle(); if !cameraOn { media.robotImage = nil }
                    } }.disabled(!live.ready || live.status?.camera != true || media.following)
                    Text("Prototipo: 160×120, circa un fotogramma al secondo. Nessuna registrazione cloud.").font(.caption)
                }
                Section("Controllo testa") {
                    Text("Orizzontale: \(yaw == 0 ? "dritta" : "\(Int(abs(yaw)))° \(yaw > 0 ? "a destra" : "a sinistra")") · In su: \(Int(-pitch))°")
                    Slider(value: $yaw, in: -Double(RobotHeadJoystick.yawLimit)...Double(RobotHeadJoystick.yawLimit), step: 1) { editing in if !editing { move() } }.accessibilityLabel("Testa orizzontale")
                    // In su only: the K151 head cannot look down from straight ahead (negative pitch = up).
                    Slider(value: $pitch, in: -Double(RobotHeadJoystick.upLimit)...0, step: 1) { editing in if !editing { move() } }.accessibilityLabel("Testa in su")
                    Button("Centro") { yaw = 0; pitch = 0; move() }
                    Text("Attivo solo dopo verifica hardware, calibrazione e attivazione locale dei movimenti sul robot.").font(.caption)
                }.disabled(!live.ready || live.status?.motionEnabled != true || media.mirroring || media.following || media.phoneFollowing || live.pendingCount > 0)
                Section("Chiamata iPhone ↔ robot") {
                    Button(media.calling ? "Termina chiamata" : "Avvia chiamata audio") { run {
                        if media.calling { media.stopAudio(); try await live.command("call.stop") }
                        else {
                            // Obtain local microphone permission before opening the robot microphone.
                            try await media.startAudio()
                            do { try await live.command("call.start") } catch { media.stopAudio(); throw error }
                        }
                    } }.disabled(!live.ready || live.status?.audio != true)
                    Text("Audio bidirezionale. Il microfono del robot è attenuato durante la sua riproduzione per ridurre l’eco: il parlato sovrapposto richiede prove hardware.").font(.caption)
                }
                Section("Immagine sullo schermo del robot") {
                    PhotosPicker("Scegli e invia immagine…", selection: $photo, matching: .images).disabled(!live.ready || live.status?.screen != true)
                    if screenOn { Button("Torna al volto Robottino") { run { try await live.command("screen.stop"); screenOn = false } } }
                    Text("Invio manuale, adattato allo schermo e privo dei metadati della foto.").font(.caption)
                }
                Section { Button("Ferma tutto e scollega", role: .destructive) { stopEverything() }; Text(media.note).font(.caption) }
            }.navigationTitle("Live Robottino")
        .onAppear {
            live.onAudio = { data in media.receiveAudio(data) }; live.onVideo = { packet in media.video(packet) }
            live.onDisconnect = { media.stopAll(); cameraOn = false; screenOn = false; followHead = false; followBusy = false; aimBusy = false; lastAim = nil }
            media.onPCM = { data in if media.calling { live.media(kind: 3, payload: data) } }
            media.onFace = { pose in
                guard !mirrorBusy, live.ready, live.pendingCount == 0 else { return }; mirrorBusy = true
                let faceSession = media.faceSessionID
                Task { defer { mirrorBusy = false }; guard media.mirroring, media.faceSessionID == faceSession else { return }; do { try await live.command("mirror", values: ["yaw":pose.yaw,"pitch":pose.pitch,"leftEye":pose.leftEye,"rightEye":pose.rightEye,"mouth":pose.mouth,"followHead":followHead && live.status?.motionEnabled == true]) } catch { media.note = error.localizedDescription } }
            }
            // One command at a time, and only for a change of 2° or more: the newest angle wins.
            media.onAim = { yaw, pitch in
                let next = (yaw: yaw, pitch: pitch)
                guard !aimBusy, live.ready, media.phoneFollowing, RobotPhoneFollow.moved(next, from: lastAim) else { return }; aimBusy = true
                let session = media.faceSessionID
                Task { defer { aimBusy = false }; guard media.phoneFollowing, media.faceSessionID == session else { return }
                    do { try await live.command("motion", values: RobotHeadJoystick.command(yaw: yaw, pitch: pitch)); lastAim = next }
                    catch { if media.phoneFollowing { media.note = "Il robot non ha eseguito il movimento: \(error.localizedDescription)" } } }
            }
            // One position at a time: while the robot confirms one, newer frames are looked at but not sent.
            media.canAnswer = { !followBusy && live.ready }
            media.onTarget = { frameID, x, y in
                guard !followBusy, live.ready, media.following else { return }; followBusy = true
                let session = media.faceSessionID
                Task { defer { followBusy = false }; guard media.following, media.faceSessionID == session else { return }
                    do { try await live.command("track", values: RobotFaceFollow.values(frameID: frameID, x: x, y: y)); if media.following { media.faceNote = "Ti sto seguendo." } }
                    catch { if media.following { media.faceNote = "Il robot non ha accettato la posizione: \(error.localizedDescription)" } } }
            }
        }.onDisappear { stopEverything(); live.onAudio = nil; live.onVideo = nil; live.onDisconnect = nil; media.onPCM = nil; media.onFace = nil; media.onTarget = nil; media.onAim = nil; media.canAnswer = nil }
            .onChange(of: scenePhase) { _, phase in if phase == .background { stopEverything() } }
            .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in if media.calling { stopEverything() } }
            .onChange(of: photo) { _, selection in
                guard let selection else { return }
                photo = nil
                guard !operationRunning else { media.note = "Attendi la fine dell’operazione in corso, poi scegli di nuovo l’immagine."; return }
                let sessionID = live.sessionID
                run(success: "Il robot ha attivato lo schermo; immagine inviata. La ricezione del fotogramma non è confermata.") {
                    guard let data = try await selection.loadTransferable(type: Data.self), data.count <= 20 * 1024 * 1024, let source = CGImageSourceCreateWithData(data as CFData, nil), let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceThumbnailMaxPixelSize:640,kCGImageSourceCreateThumbnailWithTransform:true] as CFDictionary), let pixels = UIImage(cgImage: thumbnail).robotPixels() else { throw RobotLiveError.invalid }
                    guard live.sessionID == sessionID, live.ready else { throw RobotLiveError.offline }
                    // Full screen resolution, sent in 5 pieces the robot reassembles.
                    try await live.command("screen.start"); screenFrame &+= 1
                    for piece in RobotMediaPacket.screenPieces(frameID: max(1, screenFrame), pixels: pixels) { live.media(kind: 5, width: 320, height: 240, payload: piece) }
                    screenOn = true
                }
            }
    }
    private func run(success: String = "Confermato: operazione completata.", _ operation: @escaping @MainActor () async throws -> Void) {
        guard !operationRunning else { return }; operationRunning = true
        let current = operationRevision
        Task { guard current == operationRevision else { return }; defer { if current == operationRevision { operationRunning = false } }; do { try await operation(); if current == operationRevision { media.note = success } } catch { if current == operationRevision { media.note = error.localizedDescription } } }
    }
    // Same directions as the Test page joystick.
    private func move() { run { try await live.command("motion", values: RobotHeadJoystick.command(yaw: Int(yaw), pitch: Int(pitch))) } }
    private func stopEverything() { operationRevision = UUID(); operationRunning = false; media.stopAll(); live.disconnect(); cameraOn = false; screenOn = false; mirrorBusy = false; followBusy = false; aimBusy = false; lastAim = nil }
}

// MARK: - Face following during a conversation with the robot

/// «Di default segue il mio viso quando parla», with the app open (owner, 9 Nov 2026). While the app is in the
/// foreground it asks the robot's state every few seconds; when the robot is in a conversation (long touch on its
/// head) with motions and camera ready, it opens the Live channel and starts the same following as «Segui il mio
/// viso»: the robot camera sends small frames, Vision finds the face here, the robot turns its head. It stops when
/// the conversation ends, the app leaves the foreground or a page opens the Live channel (one app at a time).
@MainActor final class RobotConversationFollow: ObservableObject {
    static let shared = RobotConversationFollow()
    static let enabledKey = "robot.follow.conversation"
    @Published var enabled: Bool { didSet { UserDefaults.standard.set(enabled, forKey: Self.enabledKey); if !enabled { Task { await end("Disattivato.") } } } }
    @Published private(set) var note = "Attivo quando l’app è aperta."
    private let live = RobotLiveClient(), media = RobotPhoneMedia()
    private var watcher: Task<Void,Never>?
    private var following = false, starting = false, aimBusy = false
    private var retryAfter = Date.distantPast
    private init() {
        enabled = UserDefaults.standard.object(forKey: Self.enabledKey) as? Bool ?? true
        live.automatic = true
        live.onVideo = { [weak self] packet in self?.media.video(packet) }
        live.onDisconnect = { [weak self] in guard let self else { return }; self.media.stopFace(); self.following = false }
        media.onTarget = { [weak self] frameID, x, y in self?.aim(frameID: frameID, x: x, y: y) }
        media.canAnswer = { [weak self] in guard let self else { return false }; return !self.aimBusy && self.live.ready }
        RobotLiveClient.beforePageConnect = { [weak self] in
            guard let self, self.live.socketConnected || self.following || self.starting else { return false }
            self.following = false; self.media.stopFace(); self.live.disconnect(); self.note = "In pausa: una pagina usa il collegamento Live."
            return true
        }
    }
    /// The app is in the foreground: watch the robot.
    func resume(store: RobotStore) {
        guard watcher == nil else { return }
        watcher = Task { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                await self.step(store: store)
                try? await Task.sleep(nanoseconds: self.following ? 1_000_000_000 : 4_000_000_000)
            }
        }
    }
    /// The app left the foreground: everything stops.
    func pause() { watcher?.cancel(); watcher = nil; Task { await end("Attivo quando l’app è aperta.") } }
    private func step(store: RobotStore) async {
        let pageOpen = RobotLiveClient.pageClients > 0
        if following || starting {
            if !starting, !live.ready || RobotConversationFollowRule.shouldStop(live.status, enabled: enabled, pageOpen: pageOpen) { await end(pageOpen ? "In pausa: una pagina usa il collegamento Live." : "Conversazione finita: inseguimento spento.") }
            return
        }
        guard enabled, !pageOpen, !store.token.isEmpty, Date() >= retryAfter,
              let data = try? await store.request("api/robot/status"), let status = try? JSONDecoder().decode(RobotLiveStatus.self, from: data),
              RobotConversationFollowRule.shouldStart(status, enabled: enabled, pageOpen: RobotLiveClient.pageClients > 0) else { return }
        await begin(token: store.token)
    }
    private func begin(token: String) async {
        starting = true; defer { starting = false }
        note = "Conversazione in corso: accendo la camera del robot…"
        live.connect(token: token)
        for _ in 0..<80 where !live.ready && RobotLiveClient.pageClients == 0 && enabled { try? await Task.sleep(nanoseconds: 100_000_000) }
        guard live.ready, let status = live.status, RobotConversationFollowRule.shouldStart(status, enabled: enabled, pageOpen: RobotLiveClient.pageClients > 0) else {
            live.disconnect(); retryAfter = Date().addingTimeInterval(20); note = "Il robot non era pronto: riprovo tra poco."; return
        }
        do { try await live.command("track.start") } catch {
            live.disconnect(); retryAfter = Date().addingTimeInterval(30); note = "Il robot non ha avviato l’inseguimento: \(error.localizedDescription)"; return
        }
        media.startRobotFollow(); following = true; note = "Ti seguo con lo sguardo mentre parliamo."
    }
    private func end(_ text: String) async {
        guard following || live.socketConnected else { note = text; return }
        following = false; media.stopFace()
        if live.ready { try? await live.command("track.stop") }
        live.disconnect(); note = text
    }
    /// One position at a time, as on the Live page: newer frames are looked at but not sent while the robot confirms.
    private func aim(frameID: UInt32, x: Double, y: Double) {
        guard following, !aimBusy, live.ready else { return }; aimBusy = true
        Task { defer { aimBusy = false }; try? await live.command("track", values: RobotFaceFollow.values(frameID: frameID, x: x, y: y)) }
    }
}

// MARK: - Conversation with Robottino on the iPhone

@MainActor final class RobotVoiceSession: ObservableObject {
    enum Phase { case idle, connecting, listening }
    static let maximumSeconds = 300
    @Published private(set) var phase = Phase.idle
    @Published private(set) var message = "Premi Inizia e parla: Robottino risponde con la voce scelta."
    @Published private(set) var transcript = RobotVoiceTranscript()
    @Published private(set) var mouth = 0.0
    /// Continuous mouth opening (0...1) of the piece that is playing, for smooth drawing.
    @Published private(set) var openness = 0.0
    private var openLevels: [Double] = []
    @Published private(set) var seconds = 0
    @Published var clearConfirmation: String?
    @Published private(set) var memoryNote = ""
    /// Reply mood: "happy", "sad" or "neutral"; `gestureCount` changes once per head gesture.
    @Published private(set) var mood = "neutral"
    @Published private(set) var gesture = "nod"
    @Published private(set) var gestureCount = 0
    @Published private(set) var timerNote = ""
    private var reply = ""
    private var gestured = false
    private var inputRate = 16000
    private var outputRate = 16000
    private var socket: URLSessionWebSocketTask?
    private var provider = RobotVoiceProvider.openai
    private var revision = UUID()
    private var engine: AVAudioEngine?
    private var player: AVAudioPlayerNode?
    private var outputFormat: AVAudioFormat?
    private var pendingInput = Data()
    private var inputChunk = 4800
    private var levels: [Double] = []
    private var playback = UUID()
    private var clock: Task<Void, Never>?
    private var configurationObserver: NSObjectProtocol?
    private let session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.urlCache = nil; configuration.httpCookieStorage = nil
        return URLSession(configuration: configuration)
    }()

    func start(token: String, provider name: String) async {
        guard phase == .idle else { return }
        let token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard token.count >= 32 else { message = "Collega prima il backend nella scheda Robot."; return }
        provider = RobotVoiceProvider(rawValue: name) ?? .openai
        let current = UUID(); revision = current
        phase = .connecting; message = "Richiesta del microfono…"; transcript = RobotVoiceTranscript(); memoryNote = ""; timerNote = ""; endReply(); seconds = 0
        guard await AVAudioApplication.requestRecordPermission() else { stop(); message = "Microfono non autorizzato. Abilitalo in Impostazioni → Robottino."; return }
        guard revision == current else { return }
        var components = URLComponents(string: "wss://robottino-stackchan.example.workers.dev/api/voice")!
        // The face chosen in the app (owner, 9 Nov 2026): the two girls speak in the feminine, the white robot in the masculine.
        components.queryItems = [URLQueryItem(name: "provider", value: provider.rawValue), URLQueryItem(name: "sessionId", value: "iphone"), URLQueryItem(name: "face", value: RobotFaceStyle.from(UserDefaults.standard.string(forKey: "robot.face.style") ?? "portrait").rawValue)]
        var request = URLRequest(url: components.url!)
        request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let task = session.webSocketTask(with: request); task.maximumMessageSize = 1_000_000
        socket = task; message = "Collegamento a \(provider.name)…"; task.resume()
        Task { [weak self] in
            do {
                while true {
                    let event = try await task.receive()
                    guard let self, self.revision == current else { return }
                    if case .string(let text) = event { self.handle(RobotVoiceProtocol.parse(text, provider: self.provider)) }
                }
            } catch {
                guard let self, self.revision == current else { return }
                let reached = self.seconds >= Self.maximumSeconds - 2
                self.stop()
                self.message = reached ? "Tempo massimo di 5 minuti raggiunto. Premi Inizia per continuare: Robottino ricorda la conversazione recente." : "Conversazione terminata. Se non è partita, controlla internet e il limite di conversazioni (6 al minuto, 100 al giorno)."
            }
        }
    }
    private func handle(_ actions: [RobotVoiceAction]) {
        for action in actions {
            switch action {
            case .ready(let input, let output):
                do { try startAudio(inputRate: input, outputRate: output); phase = .listening; message = "Ti ascolto. Parla pure."; startClock() }
                catch { stop(); message = "Audio dell’iPhone non disponibile: \(error.localizedDescription)" }
            case .audio(let pcm): play(pcm)
            case .interrupt: interruptPlayback(); endReply()
            case .pong(let id): send(RobotVoiceProtocol.pongMessage(id))
            case .memory(let note, let confirmation): memoryNote = note; clearConfirmation = confirmation
            case .failure(let note): message = note
            case .userText, .assistantText:
                if case .assistantText(let text) = action { follow(text) } else if !reply.isEmpty { endReply() }
                guard let sentence = transcript.apply(action) else { continue }
                // Timers stay on the iPhone (notifications); everything about memories goes to the server.
                if let timer = RobotTimerCommand.parse(sentence) { Task { timerNote = await RobotPhoneTimers.shared.apply(timer) } }
                else if RobotVoiceProtocol.isMemoryPhrase(sentence), let command = RobotVoiceProtocol.memoryMessage(text: sentence) { send(command) }
            }
        }
    }
    /// Face and head follow the words of the reply: one gesture per reply.
    private func follow(_ text: String) {
        reply = String((reply + text).suffix(400))
        guard let next = RobotReplyMood.from(reply) else { return }
        mood = next.expression
        if let kind = next.gesture, !gestured { gestured = true; gesture = kind; gestureCount += 1 }
    }
    private func endReply() { reply = ""; gestured = false; mood = "neutral" }
    func confirmClear() {
        guard let token = clearConfirmation, let command = RobotVoiceProtocol.clearMessage(confirmation: token) else { return }
        clearConfirmation = nil; send(command)
    }
    private func send(_ text: String) {
        guard let socket else { return }
        let current = revision
        Task { [weak self] in
            do { try await socket.send(.string(text)) }
            catch { guard let self, self.revision == current else { return }; self.stop(); self.message = "Collegamento vocale interrotto." }
        }
    }
    private func startAudio(inputRate: Int, outputRate: Int) throws {
        guard engine == nil else { return }
        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.defaultToSpeaker, .allowBluetoothHFP])
        try audioSession.setActive(true)
        let engine = AVAudioEngine(), player = AVAudioPlayerNode()
        do {
            try engine.inputNode.setVoiceProcessingEnabled(true)
            let input = engine.inputNode.outputFormat(forBus: 0)
            guard input.sampleRate > 0, let pcm = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: Double(inputRate), channels: 1, interleaved: true), let converter = AVAudioConverter(from: input, to: pcm), let output = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(outputRate), channels: 1, interleaved: false) else { throw RobotLiveError.invalid }
            engine.attach(player); engine.connect(player, to: engine.mainMixerNode, format: output)
            // 100 ms per message keeps well under the server's 30 events/s limit.
            inputChunk = inputRate / 10 * 2
            let current = revision
            engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: input) { [weak self] buffer, _ in
                let capacity = AVAudioFrameCount(Double(buffer.frameLength) * Double(inputRate) / input.sampleRate + 64)
                guard let converted = AVAudioPCMBuffer(pcmFormat: pcm, frameCapacity: capacity) else { return }
                var supplied = false, error: NSError?
                converter.convert(to: converted, error: &error) { _, status in
                    if supplied { status.pointee = .noDataNow; return nil }
                    supplied = true; status.pointee = .haveData; return buffer
                }
                guard error == nil, let samples = converted.int16ChannelData?[0], converted.frameLength > 0 else { return }
                let data = Data(bytes: samples, count: Int(converted.frameLength) * 2)
                Task { @MainActor in guard let self, self.revision == current, self.phase == .listening else { return }; self.capture(data) }
            }
            self.engine = engine; self.player = player; outputFormat = output
            try engine.start(); player.play()
            self.inputRate = inputRate; self.outputRate = outputRate
            // iOS stops the engine when the route or format changes (e.g. switching to the speaker): restart it.
            configurationObserver = NotificationCenter.default.addObserver(forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.revision == current, let engine = self.engine, let player = self.player else { return }
                    // The new route can drop the player's connection: rewire it, then restart.
                    engine.stop(); engine.connect(player, to: engine.mainMixerNode, format: self.outputFormat); engine.connect(engine.mainMixerNode, to: engine.outputNode, format: nil)
                    self.playback = UUID(); self.levels = []; self.mouth = 0; self.openLevels = []; self.openness = 0
                    do { try engine.start(); player.play() } catch { self.stop(); self.message = "Audio dell’iPhone interrotto: \(error.localizedDescription)" }
                }
            }
        } catch { engine.inputNode.removeTap(onBus: 0); engine.stop(); self.engine = nil; self.player = nil; outputFormat = nil; try? audioSession.setActive(false); throw error }
    }
    private func capture(_ data: Data) {
        pendingInput.append(data)
        while pendingInput.count >= inputChunk {
            send(RobotVoiceProtocol.audioMessage(pendingInput.prefix(inputChunk), provider: provider))
            pendingInput.removeFirst(inputChunk)
        }
    }
    private func play(_ pcm: Data) {
        guard let player, let outputFormat else { return }
        if !player.isPlaying, engine?.isRunning == true { player.play() }
        // Providers send long chunks: 60 ms pieces let the mouth follow the voice smoothly.
        let piece = max(2, outputRate * 6 / 100 * 2)
        for offset in stride(from: 0, to: pcm.count, by: piece) {
            let part = pcm.subdata(in: pcm.startIndex + offset..<pcm.startIndex + min(offset + piece, pcm.count))
            guard let buffer = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: AVAudioFrameCount(part.count / 2)), let samples = buffer.floatChannelData?[0] else { return }
            buffer.frameLength = AVAudioFrameCount(part.count / 2)
            part.withUnsafeBytes { raw in for i in 0..<Int(buffer.frameLength) { samples[i] = Float(Int16(littleEndian: raw.loadUnaligned(fromByteOffset: i * 2, as: Int16.self))) / 32768 } }
            // The mouth follows the piece that is actually playing, not the one just received.
            let level = RobotVoiceProtocol.mouthLevel(part), open = RobotVoiceProtocol.mouthOpenness(part)
            if levels.isEmpty { mouth = level; openness = open }
            levels.append(level); openLevels.append(open)
            let current = playback
            player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.playback == current, !self.levels.isEmpty else { return }
                    self.levels.removeFirst(); self.mouth = self.levels.first ?? 0
                    if !self.openLevels.isEmpty { self.openLevels.removeFirst() }; self.openness = self.openLevels.first ?? 0
                    // Played to the end: the face goes back to normal, even after "mi dispiace".
                    if self.levels.isEmpty && self.mood == "sad" { self.mood = "neutral" }
                }
            }
        }
    }
    private func interruptPlayback() {
        // Stopping the player fires the old completions: a new generation ignores them.
        playback = UUID(); levels = []; mouth = 0; openLevels = []; openness = 0
        player?.stop(); player?.play()
    }
    private func startClock() {
        clock?.cancel(); let current = revision
        clock = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                guard let self, self.revision == current else { return }
                self.seconds += 1
            }
        }
    }
    func stop() {
        revision = UUID(); playback = UUID(); clock?.cancel(); clock = nil
        if let configurationObserver { NotificationCenter.default.removeObserver(configurationObserver) }; configurationObserver = nil
        socket?.cancel(with: .normalClosure, reason: nil); socket = nil
        if let engine { engine.inputNode.removeTap(onBus: 0); engine.stop() }
        player?.stop(); engine = nil; player = nil; outputFormat = nil; pendingInput = Data(); levels = []; mouth = 0; openLevels = []; openness = 0
        if phase != .idle { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        phase = .idle; clearConfirmation = nil; endReply()
        message = "Conversazione chiusa."
    }
}

/// Reference holder so the smoother can advance inside TimelineView without re-rendering state.
final class MouthSmootherBox {
    var smoothed = RobotMouthSmoother()
    func step(toward target: Double, at now: Double) -> Double { smoothed.step(toward: target, at: now) }
}

struct RobotVoicePanel: View {
    @EnvironmentObject var store: RobotStore
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("robot.face.style") private var faceStyle = "portrait"
    @StateObject private var voice = RobotVoiceSession()
    @State private var blinking = false
    @State private var smoother = MouthSmootherBox()
    /// The silent face; while speaking the mouth frames fade over it (see `talkingFace`).
    private var restingImage: String {
        let style = RobotFaceStyle.from(faceStyle)
        if voice.openness > 0.02 || voice.mouth > 0 || smoother.smoothed.value > 0.02 { return style.image("neutral") }
        // Listening keeps the serene face; the smile only comes when the reply laughs.
        let frame = voice.mood == "sad" ? "sad" : voice.mood == "happy" ? "happy" : "neutral"
        return style.image(frame)
    }
    /// Mouth frames cross-fade with the voice instead of switching: half-open from the first sound, open above 40%.
    private var talkingFace: some View {
        let style = RobotFaceStyle.from(faceStyle), target = voice.openness, band = style.eyeBand
        let top = band.lowerBound / 240, bottom = band.upperBound / 240, soft = 6.0 / 240
        return TimelineView(.animation) { context in
            // A slow breath: the head rises and falls by about a pixel every 4.5 s.
            let now = context.date.timeIntervalSinceReferenceDate, breath = sin(now * 2 * .pi / 4.5)
            let open = smoother.step(toward: target, at: now)
            ZStack {
                Image(restingImage).resizable()
                // Wide, smoothed fades: the mouth parts gradually, then opens.
                Image(style.image("talk-small")).resizable().opacity(min(1, max(0, (open - 0.03) / 0.3)))
                Image(style.image("talk-open")).resizable().opacity(min(1, max(0, (open - 0.35) / 0.45)))
                // Blink: only the eye band of the closed-eyes frame, softened at its edges.
                Image(style.image("blink")).resizable()
                    .mask(LinearGradient(stops: [.init(color: .clear, location: top - soft), .init(color: .black, location: top),
                                                 .init(color: .black, location: bottom), .init(color: .clear, location: bottom + soft)],
                                         startPoint: .top, endPoint: .bottom))
                    .opacity(blinking ? 1 : 0)
            }
            .scaleEffect(1.012 + 0.004 * breath)
            .offset(y: -1.2 * breath)
        }
        .clipped()
        .animation(.easeInOut(duration: 0.05), value: blinking)
        .aspectRatio(4 / 3, contentMode: .fit)
        .task {
            // Irregular blinks (every 2.5-6.5 s, sometimes double), as on the robot.
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(Double.random(in: 2.5...6.5) * 1e9))
                for _ in 0..<(Double.random(in: 0...1) < 0.15 ? 2 : 1) {
                    blinking = true; try? await Task.sleep(nanoseconds: 120_000_000)
                    blinking = false; try? await Task.sleep(nanoseconds: 130_000_000)
                }
            }
        }
    }
    private var voiceName: String {
        let option = store.voices[store.provider]?.first { $0.id == store.voice }
        return option?.name ?? store.voice
    }
    var body: some View {
        Form {
            Section {
                talkingFace
                    // Same head gestures as the robot: nod, shake, tilt.
                    .keyframeAnimator(initialValue: RobotHeadPose(), trigger: voice.gestureCount) { content, pose in
                        content.rotationEffect(.degrees(pose.roll)).offset(x: pose.x, y: pose.y)
                    } keyframes: { _ in
                        let k = RobotHeadPose.amplitude(voice.gesture)
                        KeyframeTrack(\.y) { CubicKeyframe(10 * k.y, duration: 0.2); CubicKeyframe(-3 * k.y, duration: 0.2); CubicKeyframe(6 * k.y, duration: 0.2); CubicKeyframe(0, duration: 0.25) }
                        KeyframeTrack(\.x) { CubicKeyframe(12 * k.x, duration: 0.2); CubicKeyframe(-12 * k.x, duration: 0.25); CubicKeyframe(8 * k.x, duration: 0.2); CubicKeyframe(0, duration: 0.2) }
                        KeyframeTrack(\.roll) { CubicKeyframe(8 * k.roll, duration: 0.35); CubicKeyframe(8 * k.roll, duration: 0.4); CubicKeyframe(0, duration: 0.3) }
                    }
                    .clipShape(RoundedRectangle(cornerRadius: 22))
                    .accessibilityLabel(voice.mouth > 0 ? "Robottino sta parlando" : "Robottino in ascolto")
                Text(voice.message)
                if voice.phase == .listening {
                    Text("Tempo: \(voice.seconds / 60):\(String(format: "%02d", voice.seconds % 60)) di 5:00").font(.caption).monospacedDigit()
                }
                if voice.phase == .idle {
                    Button("Inizia a parlare") { Task { await voice.start(token: store.token, provider: store.provider) } }.disabled(!store.connected)
                } else {
                    Button("Termina conversazione", role: .destructive) { voice.stop() }
                }
                if voice.phase == .connecting { ProgressView() }
                Text("\(RobotVoiceProvider(rawValue: store.provider)?.name ?? store.provider) · voce \(voiceName). Si cambia nella scheda Aspetto.").font(.caption).foregroundStyle(.secondary)
            }
            if !voice.memoryNote.isEmpty { Section("Ricordi") { Text(voice.memoryNote) } }
            if !voice.timerNote.isEmpty { Section("Timer") { Text(voice.timerNote) } }
            Section("Conversazione") {
                if voice.transcript.lines.isEmpty { Text("Le frasi riconosciute compariranno qui.").foregroundStyle(.secondary) }
                ForEach(voice.transcript.lines) { line in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(line.user ? "Tu" : "Robottino").font(.caption.bold()).foregroundStyle(line.user ? Color.secondary : Color.accentColor)
                        Text(line.text)
                    }
                }
            }
            Section("Come funziona") {
                Text("Usa microfono e altoparlante dell’iPhone; il robot non è coinvolto. Ogni conversazione dura al massimo 5 minuti. L’audio non viene salvato: restano solo le ultime frasi trascritte come contesto.").font(.caption)
                Text("Comandi per i ricordi: «Ricorda che…», «Dimentica che…», «Cosa ricordi di me?», «Cosa ricordi di…?», «Dimentica tutto» (chiede conferma qui).").font(.caption)
                Text("Timer: «Avvisami tra 10 minuti», «Ricordami tra mezz’ora di…», «Facciamo un pomodoro» (25 minuti di lavoro e 5 di pausa, per 4 giri), «Quanto manca?», «Annulla il timer». Arrivano come notifiche anche ad app chiusa.").font(.caption)
            }
        }.navigationTitle("Parla con Robottino")
            .onDisappear { voice.stop() }
            .onChange(of: scenePhase) { _, phase in if phase == .background { voice.stop() } }
            .onReceive(NotificationCenter.default.publisher(for: AVAudioSession.interruptionNotification)) { _ in if voice.phase != .idle { voice.stop() } }
            .confirmationDialog("Cancellare tutti i ricordi permanenti?", isPresented: Binding(get: { voice.clearConfirmation != nil }, set: { if !$0 { voice.clearConfirmation = nil } }), titleVisibility: .visible) {
                Button("Cancella tutti", role: .destructive) { voice.confirmClear() }
            } message: { Text("Richiesta a voce. La cronologia recente delle conversazioni non viene cancellata.") }
    }
}

struct RobotHeadPose {
    var x = 0.0, y = 0.0, roll = 0.0
    static func amplitude(_ gesture: String) -> (x: Double, y: Double, roll: Double) {
        gesture == "nod" ? (0, 1, 0) : gesture == "shake" ? (1, 0, 0) : (0, 0, 1)
    }
}

/// Spoken timers on the iPhone: local notifications, so they ring even with the app closed.
@MainActor final class RobotPhoneTimers: NSObject, UNUserNotificationCenterDelegate {
    static let shared = RobotPhoneTimers()
    private let center = UNUserNotificationCenter.current()
    private let prefix = "robottino.timer."
    func install() { center.delegate = self }
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification) async -> UNNotificationPresentationOptions { [.banner, .sound, .list] }
    func apply(_ command: RobotTimerCommand) async -> String {
        let pending = await center.pendingNotificationRequests().filter { $0.identifier.hasPrefix(prefix) }
        switch command {
        case .invalid: return "Posso impostare timer da 10 secondi a 6 ore."
        case .cancel:
            center.removePendingNotificationRequests(withIdentifiers: pending.map(\.identifier))
            return pending.isEmpty ? "Nessun timer attivo." : "Timer annullati."
        case .status:
            let next = pending.compactMap { request in (request.trigger as? UNTimeIntervalNotificationTrigger)?.nextTriggerDate().map { (request, $0) } }.min { $0.1 < $1.1 }
            guard let (request, date) = next else { return "Nessun timer attivo." }
            let left = RobotTimerCommand.duration(max(1, Int(date.timeIntervalSinceNow.rounded(.up)))), info = request.content.userInfo
            if let phase = info["phase"] as? String { return "Pomodoro, \(phase == "work" ? "lavoro" : "pausa"): mancano \(left)." }
            let label = info["label"] as? String ?? ""
            return "Mancano \(left)\(label.isEmpty ? "" : " per: " + label)."
        case .set(let seconds, let label):
            guard await allowed() else { return denied }
            guard pending.filter({ $0.content.userInfo["phase"] == nil }).count < 4 else { return "Ho già 4 timer attivi: annullali prima." }
            guard await schedule(after: seconds, text: label.isEmpty ? "Tempo scaduto!" : "Tempo scaduto: \(label)!", info: ["label": label]) else { return failed }
            return "Timer di \(RobotTimerCommand.duration(seconds)) impostato\(label.isEmpty ? "" : ": " + label)."
        case .pomodoro:
            guard await allowed() else { return denied }
            center.removePendingNotificationRequests(withIdentifiers: pending.filter { $0.content.userInfo["phase"] != nil }.map(\.identifier))
            // 4 rounds: 25 minutes of work, then 5 of rest.
            var scheduled = true
            for round in 1...4 {
                let start = (round - 1) * 30 * 60
                scheduled = await schedule(after: start + 25 * 60, text: round < 4 ? "Pausa! 5 minuti di riposo." : "Pomodoro completato: 4 giri, bravo!", info: ["phase": "work"]) && scheduled
                if round < 4 { scheduled = await schedule(after: start + 30 * 60, text: "Si riparte: giro \(round + 1) di 4, 25 minuti.", info: ["phase": "rest"]) && scheduled }
            }
            guard scheduled else { center.removePendingNotificationRequests(withIdentifiers: await center.pendingNotificationRequests().filter { $0.content.userInfo["phase"] != nil }.map(\.identifier)); return failed }
            return "Pomodoro: 25 minuti di lavoro, poi ti avviso per la pausa."
        }
    }
    private let failed = "Timer non impostato: iOS ha rifiutato la notifica."
    private let denied = "Notifiche non autorizzate: abilitale in Impostazioni → Robottino → Notifiche."
    private func allowed() async -> Bool {
        switch await center.notificationSettings().authorizationStatus {
        case .authorized, .provisional, .ephemeral: return true
        case .notDetermined: return (try? await center.requestAuthorization(options: [.alert, .sound])) ?? false
        default: return false
        }
    }
    private func schedule(after seconds: Int, text: String, info: [String: String]) async -> Bool {
        let content = UNMutableNotificationContent()
        content.title = "Robottino"; content.body = text; content.sound = .default; content.userInfo = info
        let trigger = UNTimeIntervalNotificationTrigger(timeInterval: TimeInterval(seconds), repeats: false)
        do { try await center.add(UNNotificationRequest(identifier: prefix + UUID().uuidString, content: content, trigger: trigger)); return true } catch { return false }
    }
}

/// Resumes a continuation exactly once, whichever callback comes first.
final class RobotOnce<T: Sendable>: @unchecked Sendable {
    private var continuation: CheckedContinuation<T, Never>?
    private let lock = NSLock()
    init(_ continuation: CheckedContinuation<T, Never>) { self.continuation = continuation }
    func resume(_ value: T) {
        lock.lock(); let pending = continuation; continuation = nil; lock.unlock()
        pending?.resume(returning: value)
    }
}

// MARK: - Studio dance on the real robot

@MainActor final class RobotDanceSender: ObservableObject {
    @Published private(set) var running = false
    @Published private(set) var message = "Serve il robot acceso, verificato, calibrato e con i movimenti attivati sul robot."
    private let client = RobotLiveClient()
    private var task: Task<Void, Never>?
    /// The relay link must stay open: closing it stops the dance on the robot.
    func play(_ dance: StudioDance, token: String) {
        guard !running else { return }
        do { try dance.validate() } catch { message = error.localizedDescription; return }
        running = true; message = "Collegamento al robot…"
        let steps: [[String: Any]] = dance.frames.map { ["yaw": $0.yaw, "pitch": $0.pitch, "durationMs": $0.durationMs, "expression": $0.expression.rawValue] }
        task = Task { [weak self] in
            guard let self else { return }
            defer { self.client.disconnect(); self.running = false; self.task = nil }
            self.client.connect(token: token)
            do {
                for _ in 0..<50 where !self.client.ready { try await Task.sleep(nanoseconds: 100_000_000) }
                guard self.client.ready, let status = self.client.status else { throw RobotLiveError.offline }
                guard status.hardwareVerified, status.motionEnabled else { throw RobotLiveError.rejected("movimenti non abilitati sul robot") }
                try await self.client.command("dance", values: ["steps": steps])
                let virtual = status.simulated == true
                self.message = virtual ? "Il robot virtuale ha iniziato la danza." : "Confermato: il robot ha iniziato la danza. La luce dei passi resta solo nell’anteprima."
                try await Task.sleep(nanoseconds: UInt64(dance.durationMs + 1000) * 1_000_000)
                self.message = "Tempo della danza trascorso. Il robot non conferma la fine: controlla che sia fermo."
            } catch is CancellationError {
                self.message = "Danza interrotta."
            } catch {
                self.message = "Danza non avviata: \(error.localizedDescription)"
            }
        }
    }
    func stop() {
        guard running else { return }
        message = "Invio STOP al robot…"
        Task {
            do { try await client.command("stop"); message = "Confermato: il robot ha fermato la danza." }
            catch { message = "STOP non confermato: il collegamento viene chiuso e il robot interrompe la danza." }
            task?.cancel()
        }
    }
}

// MARK: - Wi-Fi to the robot over Bluetooth (Stack-chan Settings window)

@MainActor final class RobotWiFiSender: NSObject, ObservableObject, @preconcurrency CBCentralManagerDelegate, @preconcurrency CBPeripheralDelegate {
    @Published private(set) var running = false
    @Published private(set) var message = "Sul robot apri Impostazioni: per 5 minuti accetta la rete via Bluetooth."
    private var central: CBCentralManager?
    private var peripheral: CBPeripheral?
    private var rx: CBCharacteristic?
    private var pending: [Data] = []
    private var ssid = "", password = ""
    /// Networks still to send in this Bluetooth session, and the ones the robot confirmed.
    private var queue: [(ssid: String, password: String)] = []
    private var saved: [String] = []
    private var confirmed: Set<String> = []
    private var initial: [String: String] = [:]
    private var writing = false
    private var deadline: Task<Void, Never>?
    private let service = CBUUID(string: RobotWiFiBluetooth.service)

    /// Sends the networks in order over one Bluetooth session: the robot keeps the last one active
    /// and remembers the previous one as a spare (MOD `wifi-switch.js`).
    func send(_ networks: [(ssid: String, password: String)]) {
        guard !running else { return }
        let valid = networks.filter { RobotWiFiBluetooth.payload(ssid: $0.ssid, password: $0.password) != nil }
        guard let first = valid.first else { message = "Rete non valida."; return }
        queue = Array(valid.dropFirst()); saved = []; load(first)
        initial = [:]; writing = false; running = true
        message = "Cerco il robot via Bluetooth…"
        timeout(after: 20, "Robot non trovato o non confermato. Controlla che sul robot sia aperto Impostazioni e riprova.")
        if let central, central.state == .poweredOn { scan() } else { central = CBCentralManager(delegate: self, queue: .main) }
    }
    func cancel() { finish("Invio annullato.") }
    private func load(_ network: (ssid: String, password: String)) {
        ssid = network.ssid; password = network.password; confirmed = []
        pending = RobotWiFiBluetooth.payload(ssid: ssid, password: password).map { RobotWiFiBluetooth.chunks($0) } ?? []
    }
    private func timeout(after seconds: UInt64, _ text: String) {
        deadline?.cancel()
        deadline = Task { [weak self] in
            try? await Task.sleep(nanoseconds: seconds * 1_000_000_000)
            guard !Task.isCancelled, let self, self.running else { return }
            self.finish(text)
        }
    }
    private func finish(_ text: String) {
        deadline?.cancel(); deadline = nil
        central?.stopScan()
        if let peripheral { central?.cancelPeripheralConnection(peripheral) }
        peripheral = nil; rx = nil; pending = []; password = ""; queue = []; running = false; message = text
    }
    private func scan() { central?.scanForPeripherals(withServices: [service]) }

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        guard running else { return }
        switch central.state {
        case .poweredOn: scan()
        case .unauthorized: finish("Bluetooth non autorizzato. Abilitalo in Impostazioni → Robottino.")
        case .poweredOff: finish("Accendi il Bluetooth dell’iPhone e riprova.")
        case .unsupported: finish("Questo dispositivo non supporta il Bluetooth LE.")
        default: break
        }
    }
    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral, advertisementData: [String: Any], rssi RSSI: NSNumber) {
        guard running, self.peripheral == nil else { return }
        central.stopScan(); self.peripheral = peripheral; peripheral.delegate = self
        message = "Robot trovato (\(peripheral.name ?? "STK")). Collegamento…"
        central.connect(peripheral)
    }
    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) { peripheral.discoverServices([service]) }
    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) { finish("Collegamento Bluetooth non riuscito. Riprova vicino al robot.") }
    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        if running { finish("Il robot ha chiuso il Bluetooth prima di confermare. Riapri Impostazioni sul robot e riprova.") }
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard let service = peripheral.services?.first(where: { $0.uuid == self.service }) else { finish("Il robot non espone il servizio impostazioni."); return }
        peripheral.discoverCharacteristics([CBUUID(string: RobotWiFiBluetooth.rx), CBUUID(string: RobotWiFiBluetooth.tx)], for: service)
    }
    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        let items = service.characteristics ?? []
        guard let rx = items.first(where: { $0.uuid == CBUUID(string: RobotWiFiBluetooth.rx) }), let tx = items.first(where: { $0.uuid == CBUUID(string: RobotWiFiBluetooth.tx) }) else { finish("Servizio impostazioni del robot incompleto."); return }
        self.rx = rx
        // Enabling notifications makes the robot report its current values; then write.
        peripheral.setNotifyValue(true, for: tx)
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateNotificationStateFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, characteristic.isNotifying else { finish("Il robot non accetta notifiche Bluetooth."); return }
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 700_000_000) // let the current values arrive first
            guard let self, self.running, !self.writing else { return }
            self.writing = true; self.message = "Invio della rete «\(self.ssid)»…"
            self.timeout(after: 8, "Il robot non ha confermato. Probabilmente la finestra di 5 minuti di Impostazioni è chiusa: riaprila e riprova.")
            self.writeNext()
        }
    }
    private func writeNext() {
        guard let peripheral, let rx else { return }
        guard !pending.isEmpty else { checkAlreadySet(); return }
        peripheral.writeValue(pending.removeFirst(), for: rx, type: .withResponse)
    }
    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil else { finish("Scrittura Bluetooth rifiutata dal robot."); return }
        writeNext()
    }
    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard let data = characteristic.value, let (prop, value) = RobotWiFiBluetooth.notification(data) else { return }
        if !writing { initial[prop] = value; return }
        if (prop == "wifi.ssid" && value == ssid) || (prop == "wifi.password" && value == password) { confirmed.insert(prop) }
        if confirmed.count == 2 { done() }
    }
    /// The robot only notifies changed values: unchanged ones were confirmed by its initial report.
    private func checkAlreadySet() {
        if initial["wifi.ssid"] == ssid { confirmed.insert("wifi.ssid") }
        if initial["wifi.password"] == password { confirmed.insert("wifi.password") }
        if confirmed.count == 2 { done() }
    }
    private func done() {
        saved.append(ssid)
        guard !queue.isEmpty else {
            let names = saved.map { "«\($0)»" }.joined(separator: " e ")
            finish(saved.count > 1 ? "Confermato: il robot ha salvato \(names). All’accensione usa da solo «\(saved.last!)» se la trova, altrimenti l’altra. Esci da Impostazioni sul robot." : "Confermato: il robot ha salvato la rete \(names). Esci da Impostazioni sul robot per collegarlo.")
            return
        }
        // The robot's MOD polls every 300 ms: pause so it remembers this network before the next one.
        initial = ["wifi.ssid": ssid, "wifi.password": password]; load(queue.removeFirst())
        message = "Invio della rete «\(ssid)»…"
        Task { @MainActor [weak self] in
            try? await Task.sleep(nanoseconds: 1_500_000_000)
            guard let self, self.running else { return }
            self.timeout(after: 8, "Il robot non ha confermato la seconda rete. Riapri Impostazioni sul robot e riprova.")
            self.writeNext()
        }
    }
}
