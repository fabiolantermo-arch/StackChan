import SwiftUI
import Security
import UniformTypeIdentifiers
import AVFAudio

struct RobotMemoryItem: Codable, Identifiable {
    let id: String; var text: String; let kind: String
    var kindName: String { ["profile": "Profilo", "fact": "Detto a voce", "preference": "Preferenza"][kind] ?? kind }
}
struct VoiceOption: Codable, Identifiable {
    let id: String; let name: String
    var displayName: String {
        let descriptions = [
            "Sami":"Energica, espressiva e sorridente", "Eric":"Voce maschile",
            "Elettra":"Matura, profonda ed espressiva", "Giulia Pro":"Chiara, vivace e ricca di sfumature",
            "Giulia":"Animata e appassionata", "Mia":"Delicata e leggera", "Stella":"Calda, espressiva e dinamica",
            "Samanta":"Calda, profonda e rassicurante", "Aida":"Profonda, morbida e vellutata",
            "Alessandro":"Calda e rassicurante, per assistenti vocali", "Chiara":"Morbida, vellutata e accogliente",
            "Violetta":"Squillante, brillante e gioiosa", "Matteo":"Calda, fluida e autentica",
            "Lorenzo":"Giovane, espressiva e coinvolgente", "Ginevra":"Ricca, allegra e rassicurante",
            "Giusy":"Vendite e assistenza clienti"
        ]
        return descriptions[name].map { name + " — " + $0 } ?? name
    }
}
// language: "it" or "en" (owner, 11 Nov 2026); older servers send none, and that is Italian.
struct VoicePreferences: Codable { var provider: String; var voice: String; var language: String? }
struct PreferencesResponse: Codable { let preferences: VoicePreferences; let voices: [String: [VoiceOption]] }
struct MemoryResponse: Codable { let memories: [RobotMemoryItem] }
struct ClearChallenge: Codable { let confirmation: String }

enum TokenVault {
    static let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "Robottino", kSecAttrAccount as String: "backend-token"]
    static func load() -> String {
        var q = query; q[kSecReturnData as String] = true
        var result: CFTypeRef?
        guard SecItemCopyMatching(q as CFDictionary, &result) == errSecSuccess, let data = result as? Data else { return "" }
        return String(data: data, encoding: .utf8) ?? ""
    }
    static func save(_ token: String) throws {
        let data = Data(token.utf8)
        let status = SecItemUpdate(query as CFDictionary, [kSecValueData as String: data] as CFDictionary)
        if status == errSecItemNotFound {
            var q = query; q[kSecValueData as String] = data; q[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(q as CFDictionary, nil) == errSecSuccess else { throw URLError(.cannotWriteToFile) }
        } else if status != errSecSuccess { throw URLError(.cannotWriteToFile) }
    }
}

@MainActor final class RobotStore: ObservableObject {
    @Published var token: String
    @Published var memories: [RobotMemoryItem] = []
    @Published var provider = "elevenlabs"
    @Published var voice = "kAzI34nYjizE0zON6rXv"
    @Published var language = "it"
    @Published var voices: [String: [VoiceOption]] = [:]
    @Published var status: String
    @Published var connected = false
    @Published var busy = false
    @Published var lastSucceeded = false
    private let base = URL(string: "https://robottino-stackchan.example.workers.dev")!
    private let session: URLSession
    private let saveToken: (String) throws -> Void
    init(loadToken: () -> String = TokenVault.load, saveToken: @escaping (String) throws -> Void = TokenVault.save, session: URLSession = .shared) {
        self.session = session
        self.saveToken = saveToken
        let savedToken = loadToken().trimmingCharacters(in: .whitespacesAndNewlines)
        token = savedToken
        status = savedToken.isEmpty ? "Inserisci il token Robottino per collegarti." : "Collegamento automatico al backend…"
    }
    func request(_ path: String, body: [String: String]? = nil) async throws -> Data {
        var request = URLRequest(url: base.appendingPathComponent(path))
        request.setValue("Bearer \(token.trimmingCharacters(in: .whitespacesAndNewlines))", forHTTPHeaderField: "Authorization")
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.timeoutInterval = 20
        if let body { request.httpMethod = "POST"; request.setValue("application/json", forHTTPHeaderField: "Content-Type"); request.httpBody = try JSONEncoder().encode(body) }
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else { throw URLError(.badServerResponse) }
        guard (200..<300).contains(http.statusCode) else {
            let code = (try? JSONDecoder().decode([String: String].self, from: data))?["error"]
            throw NSError(domain: "Robottino", code: http.statusCode, userInfo: [NSLocalizedDescriptionKey: http.statusCode == 401 ? "Token non valido. Controlla il collegamento." : Self.describe(code) ?? "Operazione non riuscita (\(http.statusCode))."])
        }
        return data
    }
    static func describe(_ code: String?) -> String? {
        switch code {
        case "secret_not_allowed": return "Ricordo non salvato: sembra contenere una password, una chiave o un codice. Questi dati non vengono memorizzati."
        case "invalid_text": return "Ricordo non salvato: scrivi un testo di massimo 500 caratteri."
        case "memory_limit": return "Ricordo non salvato: hai raggiunto il limite di 100 ricordi. Eliminane qualcuno."
        case "not_found": return "Il ricordo da modificare non esiste più. Aggiorna l’elenco."
        case "confirmation_invalid", "confirmation_required": return "Conferma scaduta: riprova la cancellazione."
        case "voice_update_failed", "voice_update_unverified": return "La voce non è stata aggiornata su ElevenLabs. Riprova più tardi."
        case "invalid_preferences": return "Modello o voce non validi."
        case "language_unavailable": return "L’inglese non è ancora disponibile per questa voce. Riprova più tardi."
        case "memory_unavailable": return "Archivio ricordi momentaneamente non disponibile."
        case "unknown_code": return "Codice non valido o scaduto. Controlla le 6 cifre sullo schermo del robot."
        case "too_many_attempts": return "Troppi codici sbagliati: riprova tra un’ora."
        case "robot_not_confirmed": return "Il robot non ha confermato il salvataggio. Dal menu del robot scegli «Abbina con l’app» e riprova."
        case "pairing_in_progress": return "Abbinamento già in corso con questo codice: attendi qualche secondo."
        case "not_configured": return "Il server non ha ancora la credenziale del robot."
        default: return nil
        }
    }
    func refresh() async throws {
        let preferences = try JSONDecoder().decode(PreferencesResponse.self, from: await request("api/preferences"))
        let list = try JSONDecoder().decode(MemoryResponse.self, from: await request("api/memories"))
        provider = preferences.preferences.provider; voice = preferences.preferences.voice; language = preferences.preferences.language == "en" ? "en" : "it"; voices = preferences.voices; memories = list.memories
    }
    func run(_ action: () async throws -> Void) async {
        // A refused call must never leave a previous success visible as its result.
        lastSucceeded = false
        guard !busy else { status = "Attendi: un’altra operazione è in corso."; return }; busy = true; defer { busy = false }
        do { try await action(); lastSucceeded = true; connected = true; status = "Backend collegato. Lo stato del robot è indicato sotto." }
        catch { connected = false; status = error.localizedDescription }
    }
    func connect() async {
        token = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !token.isEmpty else { connected = false; status = "Inserisci il token Robottino per collegarti."; return }
        await run { try await refresh(); try saveToken(token) }
    }
    func restoreConnection() async {
        guard !busy else { return }
        guard !token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            connected = false; status = "Inserisci il token Robottino per collegarti."; return
        }
        status = "Verifica collegamento al backend…"
        await run { try await refresh() }
    }
    func saveVoice() async { await run { _ = try await request("api/preferences", body: ["provider": provider, "voice": voice, "language": language]); try await refresh() } }
    func saveMemory(_ text: String, id: String? = nil) async {
        await run { var body = ["action": id == nil ? "remember" : "update", "text": text, "kind": "profile"]; if let id { body["id"] = id }; _ = try await request("api/memories", body: body); try await refresh() }
    }
    func forget(_ id: String) async { await run { _ = try await request("api/memories", body: ["action": "forget", "id": id]); try await refresh() } }
    func clearAll() async { await run {
        let challenge = try JSONDecoder().decode(ClearChallenge.self, from: await request("api/memories", body: ["action": "prepare_clear"]))
        _ = try await request("api/memories", body: ["action": "clear", "confirmation": challenge.confirmation]); try await refresh()
    } }
}

struct RobotTestCapabilities: Decodable {
    let connected: Bool
    let hardwareVerified: Bool
    let calibrated: Bool
    let motion: Bool
    let camera: Bool
    let motionEnabled: Bool?
}

/// The Test page works on the real robot (9 Nov 2026, owner: «pensavo che la pagina test operasse sul
/// robot reale»): it reads the robot's real state and, when its motions are on, the joystick moves the head
/// through the same relay as Live, one command at a time.
@MainActor final class RobotTests: ObservableObject {
    @Published var simulation = false
    @Published var yaw = 0
    @Published var pitch = 0
    @Published var status = "Verifica del robot in corso…"
    @Published var busy = false
    @Published private(set) var caps: RobotTestCapabilities?
    @Published private(set) var driving = false
    let live = RobotLiveClient()
    private var wanted = (yaw: 0, pitch: 0), sent = (yaw: 0, pitch: 0), sending = false
    var canDrive: Bool { caps?.connected == true && caps?.motionEnabled == true }
    func check(using store: RobotStore) async {
        guard !busy else { return }
        busy = true; defer { busy = false }
        await readStatus(using: store)
    }
    private func readStatus(using store: RobotStore) async {
        guard !store.token.isEmpty else { caps = nil; status = "Collega prima il backend dalla scheda Robot."; return }
        do {
            let caps = try JSONDecoder().decode(RobotTestCapabilities.self, from: await store.request("api/robot/status"))
            self.caps = caps; status = Self.describe(caps)
        } catch { caps = nil; status = "Verifica robot non riuscita: \(error.localizedDescription)" }
    }
    static func describe(_ caps: RobotTestCapabilities) -> String {
        guard caps.connected else { return "Il robot non è collegato al servizio. Controlla che sia acceso e in rete; dopo ogni uso dell’app si ricollega da solo in pochi secondi, poi riprova." }
        let yes = { (value: Bool) in value ? "sì" : "no" }
        var text = "Robot collegato. Hardware verificato: \(yes(caps.hardwareVerified)) · Calibrazione: \(yes(caps.calibrated)) · Movimenti attivi: \(yes(caps.motionEnabled == true)) · Camera: \(yes(caps.camera))."
        if caps.motionEnabled != true { text += " Per muovere la testa: sul robot apri il menu (☰) e attiva Hardware, Calibrazione e Movimenti, poi premi «Muovi il robot vero»." }
        return text
    }
    /// «Muovi il robot vero» reads the robot's state again by itself (owner, 9 Nov 2026); the page reads it on entry.
    func startDriving(using store: RobotStore, active: @escaping () -> Bool) async {
        guard !driving, !busy, !simulation else { return }
        busy = true; defer { busy = false }
        status = "Verifica del robot in corso…"; await readStatus(using: store)
        guard canDrive, active() else { return }
        status = "Collegamento al robot in corso…"; live.connect(token: store.token)
        for _ in 0..<150 where !live.ready && active() { try? await Task.sleep(nanoseconds: 100_000_000) }
        guard live.ready, live.status?.motionEnabled == true, active() else { live.disconnect(); status = "Il robot non ha accettato il collegamento o i movimenti non sono attivi. Riprova tra qualche secondo."; return }
        wanted = (0, 0); sent = (0, 0); yaw = 0; pitch = 0; driving = true
        status = "Muovi il joystick: la testa del robot segue, fino a 90° ai lati e 85° in su."
    }
    func stopDriving() {
        guard driving else { live.disconnect(); return }
        driving = false; wanted = (0, 0); yaw = 0; pitch = 0
        let live = self.live, needsCentre = sent != (0, 0)
        Task { @MainActor in
            if needsCentre, live.ready { try? await live.command("motion", values: RobotHeadJoystick.command(yaw: 0, pitch: 0)) }
            live.disconnect()
        }
        sent = (0, 0); status = "Robot fermo. Puoi riprendere i movimenti quando vuoi."
    }
    func move(x: Double, y: Double) {
        if simulation {
            // Same range as the real head: 90° sideways, 85° up (negative pitch); the K151 cannot look down.
            let limit = RobotHeadJoystick.yawLimit, up = RobotHeadJoystick.upLimit
            yaw = min(limit, max(-limit, Int((x * Double(limit)).rounded()))); pitch = min(0, max(-up, Int((min(0, y) * Double(up)).rounded())))
            status = "Simulazione: testa \(yaw)°, inclinazione \(pitch)°. Nessun comando inviato al robot."
        } else if driving {
            let target = RobotHeadJoystick.target(x: x, y: y); wanted = target; yaw = target.yaw; pitch = target.pitch; pump()
        }
    }
    /// One command at a time: the robot answers when the move is done; meanwhile only the latest target is kept.
    private func pump() {
        guard driving, !sending, wanted != sent else { return }
        sending = true; let target = wanted
        Task { @MainActor in
            defer { sending = false; pump() }
            do { try await live.command("motion", values: RobotHeadJoystick.command(yaw: target.yaw, pitch: target.pitch)); sent = target }
            catch { driving = false; live.disconnect(); status = "Il robot non ha eseguito il movimento (\(error.localizedDescription)). Riprova con «Muovi il robot vero»." }
        }
    }
    func stop() {
        if driving { stopDriving(); return }
        // This is a local simulation reset, never an emergency stop for hardware.
        guard simulation else { return }
        yaw = 0; pitch = 0; status = "Simulazione fermata. Nessun comando inviato al robot."
    }
    func reset() { yaw = 0; pitch = 0 }
}

enum StudioError: LocalizedError {
    case invalidDance, invalidAudio, disconnected, busy, rejected, timeout, cancelled, storage
    var errorDescription: String? {
        switch self {
        case .invalidDance: return "Controlla nome, passi e durata della danza (massimo 60 secondi e 32 passi)."
        case .invalidAudio: return "Scegli un file audio leggibile MP3, M4A, WAV, AAC o CAF, entro 20 MB e 10 minuti."
        case .disconnected: return "Collega prima il simulatore."
        case .busy: return "Attendi la conferma del comando precedente."
        case .rejected: return "Il robot simulato ha rifiutato il comando."
        case .timeout: return "Tempo scaduto: nessuna conferma dal robot simulato."
        case .cancelled: return "Prova interrotta. Nessun comando fisico inviato."
        case .storage: return "Archivio danze non leggibile. Il file originale è stato conservato."
        }
    }
}
enum StudioExpression: String, Codable, CaseIterable, Identifiable {
    case neutral, happy, sad, blink, talkSmall = "talk-small", talkOpen = "talk-open"
    var id: String { rawValue }
    var name: String {
        switch self {
        case .neutral: return "Serena"
        case .happy: return "Felice"
        case .sad: return "Pensierosa"
        case .blink: return "Ammiccamento"
        case .talkSmall: return "Bocca socchiusa"
        case .talkOpen: return "Bocca aperta"
        }
    }
}
enum StudioLight: String, Codable, CaseIterable, Identifiable {
    case off, pink, blue, mint, orange, white
    var id: String { rawValue }
    var name: String {
        switch self { case .off: return "Spento"; case .pink: return "Rosa"; case .blue: return "Blu"; case .mint: return "Menta"; case .orange: return "Arancio"; case .white: return "Bianco" }
    }
    var color: Color {
        switch self { case .off: return .gray.opacity(0.25); case .pink: return .pink; case .blue: return .blue; case .mint: return .mint; case .orange: return .orange; case .white: return .white }
    }
}
struct StudioFrame: Codable, Identifiable, Equatable {
    var id = UUID()
    var yaw = 0.0
    var pitch = 0.0
    var durationMs = 800
    var expression = StudioExpression.neutral
    var leftLight = StudioLight.mint
    var rightLight = StudioLight.mint
    func validate() throws {
        guard yaw.isFinite, pitch.isFinite, abs(yaw) <= 10, abs(pitch) <= 10, (300...5000).contains(durationMs) else { throw StudioError.invalidDance }
    }
}
struct StudioDance: Codable, Identifiable, Equatable {
    static let builtInMusic = "danza-robottino.mp3"
    static let builtInTracks: [(file: String, title: String)] = [
        (builtInMusic, "Danza Robottino"), ("danza-allegra.mp3", "Danza allegra"),
        ("danza-dolce.mp3", "Danza dolce"), ("danza-spaziale.mp3", "Danza spaziale")
    ]
    var id = UUID()
    var name = "Nuova danza"
    var frames = [StudioFrame()]
    var musicFile: String?
    var musicName: String?
    var durationMs: Int { frames.reduce(0) { $0 + $1.durationMs } }
    func validate() throws {
        guard !name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty, name.count <= 60,
              (1...32).contains(frames.count), Set(frames.map(\.id)).count == frames.count else { throw StudioError.invalidDance }
        for frame in frames { try frame.validate() }
        guard durationMs <= 60000 else { throw StudioError.invalidDance }
        if let musicFile {
            let name = (musicFile as NSString).deletingPathExtension
            guard (Self.builtInTracks.contains(where: { $0.file == musicFile }) || UUID(uuidString: name) != nil), ["mp3", "m4a", "wav", "aac", "caf"].contains((musicFile as NSString).pathExtension), (musicName?.count ?? 0) <= 120 else { throw StudioError.invalidDance }
        }
    }
    static var example: StudioDance {
        StudioDance(name: "Saluto felice", frames: [
            StudioFrame(durationMs: 500, expression: .happy),
            StudioFrame(yaw: -8, durationMs: 800, expression: .happy, leftLight: .pink, rightLight: .blue),
            StudioFrame(yaw: 8, durationMs: 800, expression: .happy, leftLight: .blue, rightLight: .pink),
            StudioFrame(durationMs: 800, expression: .blink),
            StudioFrame(durationMs: 500, expression: .happy)
        ])
    }
}
struct StudioLibrary: Codable { var version = 1; var dances: [StudioDance] }
struct StudioExport: Codable { var version = 1; var dance: StudioDance }
struct StudioAck: Equatable { let commandID: UUID; let sequence: Int }

@MainActor final class StudioSimulator: ObservableObject {
    enum Link: String { case disconnected = "Scollegato", connecting = "Collegamento…", connected = "Collegato", fault = "Errore simulato" }
    enum Failure: String, CaseIterable, Identifiable {
        case none = "Nessun guasto", timeout = "Mancata risposta", reject = "Comando rifiutato"
        var id: String { rawValue }
    }
    @Published private(set) var link = Link.disconnected
    @Published private(set) var pose = StudioFrame()
    @Published private(set) var pending = false
    @Published private(set) var lastAck: StudioAck?
    @Published private(set) var log: [String] = []
    @Published var latencyMs = 150
    @Published var failure = Failure.none
    private var revision = UUID()
    private var acknowledgements: [UUID: StudioAck] = [:]
    private var acknowledgedFrames: [UUID: StudioFrame] = [:]
    private var ackOrder: [UUID] = []
    private var sequence = 0
    private let delay: (Int) async throws -> Void
    init(delay: @escaping (Int) async throws -> Void = { milliseconds in try await Task.sleep(nanoseconds: UInt64(max(0, milliseconds)) * 1_000_000) }) { self.delay = delay }
    private func record(_ value: String) { log.append(value); if log.count > 40 { log.removeFirst(log.count - 40) } }
    var connected: Bool { link == .connected }
    func connect() async {
        guard link != .connecting else { return }
        revision = UUID(); let current = revision
        pending = false; lastAck = nil; acknowledgements = [:]; acknowledgedFrames = [:]; ackOrder = []; sequence = 0
        link = .connecting; record("Apertura collegamento simulato")
        do {
            try await delay(min(1000, max(0, latencyMs)))
            guard revision == current, !Task.isCancelled else { return }
            link = .connected; record("Robot virtuale collegato · nessuna rete utilizzata")
        } catch { if revision == current { link = .disconnected; record("Collegamento annullato") } }
    }
    func stop() {
        revision = UUID(); pending = false
        if link == .connecting { link = .disconnected }
        record("STOP locale: comandi in attesa invalidati, posa mantenuta")
    }
    func disconnect() { stop(); link = .disconnected; acknowledgements = [:]; acknowledgedFrames = [:]; ackOrder = []; lastAck = nil; record("Robot virtuale scollegato") }
    func send(_ frame: StudioFrame, commandID: UUID = UUID()) async throws -> StudioAck {
        try frame.validate()
        guard connected else { throw StudioError.disconnected }
        if let previous = acknowledgements[commandID] {
            guard acknowledgedFrames[commandID] == frame else { throw StudioError.rejected }
            return previous
        }
        guard !pending else { throw StudioError.busy }
        let current = revision, fault = failure
        pending = true; record("Passo inviato al simulatore")
        defer { if revision == current { pending = false } }
        try await delay(min(1000, max(0, latencyMs)) + (fault == .timeout ? 600 : 0))
        guard revision == current, connected, !Task.isCancelled else { throw StudioError.cancelled }
        if fault == .timeout { link = .fault; record("Nessuna conferma: timeout simulato"); throw StudioError.timeout }
        if fault == .reject { record("Passo rifiutato: posa invariata"); throw StudioError.rejected }
        pose = frame; sequence += 1
        let ack = StudioAck(commandID: commandID, sequence: sequence)
        lastAck = ack; acknowledgements[commandID] = ack; acknowledgedFrames[commandID] = frame; ackOrder.append(commandID)
        if ackOrder.count > 128 { let oldest = ackOrder.removeFirst(); acknowledgements.removeValue(forKey: oldest); acknowledgedFrames.removeValue(forKey: oldest) }
        record("Conferma ricevuta · passo \(sequence)")
        return ack
    }
    func wait(_ milliseconds: Int) async throws {
        let current = revision
        try await delay(milliseconds)
        guard revision == current, connected, !Task.isCancelled else { throw StudioError.cancelled }
    }
}

@MainActor final class RobotStudio: ObservableObject {
    @Published var draft = StudioDance.example
    @Published private(set) var library: [StudioDance] = []
    @Published private(set) var playing = false
    @Published private(set) var currentStep: Int?
    @Published var message = "Crea una danza o carica quella di esempio. Le prove sono solo sul simulatore."
    let simulator: StudioSimulator
    private let storageURL: URL
    private var unreadable = false
    private var playback: Task<Void, Never>?
    private var runID = UUID()
    private var musicPlayer: AVAudioPlayer?
    private let defaultMusicURL: URL?
    init(storageURL: URL? = nil, simulator: StudioSimulator? = nil, defaultMusicURL: URL? = Bundle.main.url(forResource: "danza-robottino", withExtension: "mp3")) {
        self.simulator = simulator ?? StudioSimulator()
        self.defaultMusicURL = defaultMusicURL
        self.storageURL = storageURL ?? FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0].appendingPathComponent("Robottino/dances-v1.json")
        applyDefaultMusic()
        guard FileManager.default.fileExists(atPath: self.storageURL.path) else { return }
        do {
            let data = try Data(contentsOf: self.storageURL)
            guard data.count <= 262144 else { throw StudioError.storage }
            let document = try JSONDecoder().decode(StudioLibrary.self, from: data)
            guard document.version == 1, document.dances.count <= 50, Set(document.dances.map(\.id)).count == document.dances.count else { throw StudioError.storage }
            for dance in document.dances { try dance.validate() }
            library = document.dances
        } catch { unreadable = true; message = StudioError.storage.localizedDescription }
    }
    private func persist(_ dances: [StudioDance]) throws {
        guard !unreadable, dances.count <= 50 else { throw StudioError.storage }
        let data = try JSONEncoder().encode(StudioLibrary(dances: dances))
        guard data.count <= 262144 else { throw StudioError.storage }
        try FileManager.default.createDirectory(at: storageURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try data.write(to: storageURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: storageURL.path)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: storageURL.path)
        #endif
    }
    func save() {
        do {
            try draft.validate(); var next = library
            if let index = next.firstIndex(where: { $0.id == draft.id }) { next[index] = draft } else { next.append(draft) }
            try persist(next); library = next; message = "Confermato: danza salvata su questo iPhone."
        } catch { message = error.localizedDescription }
    }
    func delete(_ dance: StudioDance) {
        do { let next = library.filter { $0.id != dance.id }; try persist(next); library = next; message = "Confermato: danza rimossa dalla libreria locale." }
        catch { message = error.localizedDescription }
    }
    func load(_ dance: StudioDance) { stop(); draft = dance; message = "Confermato: danza caricata nell’editor." }
    private func applyDefaultMusic() { if defaultMusicURL != nil { draft.musicFile = StudioDance.builtInMusic; draft.musicName = "Danza Robottino · predefinita" } }
    func useDefaultMusic() { stop(); applyDefaultMusic(); message = defaultMusicURL == nil ? "Traccia predefinita non disponibile." : "Traccia predefinita selezionata. Premi Salva per conservarla." }
    private func builtInURL(_ filename: String) -> URL? {
        guard StudioDance.builtInTracks.contains(where: { $0.file == filename }) else { return nil }
        if filename == StudioDance.builtInMusic { return defaultMusicURL }
        return Bundle.main.url(forResource: (filename as NSString).deletingPathExtension, withExtension: "mp3")
    }
    func useBuiltInMusic(_ filename: String) {
        guard let track = StudioDance.builtInTracks.first(where: { $0.file == filename }), builtInURL(filename) != nil else { message = "Traccia non disponibile."; return }
        stop(); draft.musicFile = track.file; draft.musicName = track.title; message = "Confermato: traccia selezionata. Premi Salva per conservarla."
    }
    func newDance() { stop(); draft = StudioDance(); applyDefaultMusic(); message = "Confermato: nuova danza pronta da modificare." }
    func duplicate() {
        stop(); draft.id = UUID(); draft.name = String((draft.name + " copia").prefix(60))
        for index in draft.frames.indices { draft.frames[index].id = UUID() }
        message = "Confermato: copia pronta. Premi Salva per aggiungerla alla libreria."
    }
    func exportDraft() throws -> Data { try draft.validate(); return try JSONEncoder().encode(StudioExport(dance: draft)) }
    func importDance(_ data: Data) throws {
        guard data.count <= 65536 else { throw StudioError.invalidDance }
        let document = try JSONDecoder().decode(StudioExport.self, from: data)
        guard document.version == 1 else { throw StudioError.invalidDance }
        try document.dance.validate(); stop(); draft = document.dance; draft.id = UUID(); draft.musicFile = nil; draft.musicName = nil
        for index in draft.frames.indices { draft.frames[index].id = UUID() }
        message = "Confermato: danza importata nell’editor. Premi Salva per conservarla. L’eventuale musica va scelta di nuovo su questo iPhone."
    }
    func importMusic(from url: URL) throws {
        let type = url.pathExtension.lowercased()
        guard ["mp3", "m4a", "wav", "aac", "caf"].contains(type) else { throw StudioError.invalidAudio }
        let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0, size <= 20 * 1024 * 1024 else { throw StudioError.invalidAudio }
        let audio = try AVAudioPlayer(contentsOf: url)
        guard audio.duration.isFinite, audio.duration > 0, audio.duration <= 600 else { throw StudioError.invalidAudio }
        let folder = storageURL.deletingLastPathComponent().appendingPathComponent("music")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let filename = UUID().uuidString + "." + type, destination = folder.appendingPathComponent(filename)
        try FileManager.default.copyItem(at: url, to: destination)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
        #if os(iOS)
        try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: destination.path)
        #endif
        stop(); draft.musicFile = filename; draft.musicName = String(url.lastPathComponent.prefix(120))
        message = "Confermato: musica aggiunta localmente. Premi Salva per conservarla con la danza."
    }
    func removeMusic() { stop(); draft.musicFile = nil; draft.musicName = nil; message = "Confermato: traccia scollegata dalla danza. Premi Salva per confermare." }
    func addFrame() { guard draft.frames.count < 32 else { message = StudioError.invalidDance.localizedDescription; return }; draft.frames.append(StudioFrame()); message = "Confermato: passo aggiunto. Premi Salva per conservarlo." }
    func removeFrames(_ offsets: IndexSet) {
        guard draft.frames.count > offsets.count else { message = "Mantieni almeno un passo."; return }
        draft.frames.remove(atOffsets: offsets)
    }
    func reorder(from offsets: IndexSet, to destination: Int) { draft.frames.move(fromOffsets: offsets, toOffset: destination) }
    func stop() {
        if playing { message = "Riproduzione interrotta. Ultima posa mantenuta." }
        runID = UUID(); playback?.cancel(); playback = nil; playing = false; currentStep = nil; simulator.stop()
        musicPlayer?.stop(); musicPlayer = nil
    }
    func leave() { stop(); simulator.disconnect() }
    func play() {
        guard !playing else { return }
        musicPlayer?.stop(); musicPlayer = nil
        do {
            try draft.validate(); guard simulator.connected else { throw StudioError.disconnected }
            if let filename = draft.musicFile {
                let audioURL: URL
                if StudioDance.builtInTracks.contains(where: { $0.file == filename }) { guard let resource = builtInURL(filename) else { throw StudioError.invalidAudio }; audioURL = resource }
                else { audioURL = storageURL.deletingLastPathComponent().appendingPathComponent("music").appendingPathComponent(filename) }
                musicPlayer = try AVAudioPlayer(contentsOf: audioURL)
                if StudioDance.builtInTracks.contains(where: { $0.file == filename }) { musicPlayer?.numberOfLoops = -1 }
                guard musicPlayer?.prepareToPlay() == true else { throw StudioError.invalidAudio }
            }
        }
        catch { musicPlayer?.stop(); musicPlayer = nil; message = error.localizedDescription; return }
        let frames = draft.frames, currentRun = UUID(); runID = currentRun; playing = true; message = "Riproduzione nel simulatore…"
        playback = Task { [weak self] in
            guard let self else { return }
            do {
                for (index, frame) in frames.enumerated() {
                    try Task.checkCancellation(); guard self.runID == currentRun else { return }
                    self.currentStep = index
                    _ = try await self.simulator.send(frame)
                    if index == 0, let audio = self.musicPlayer, !audio.play() { throw StudioError.invalidAudio }
                    try await self.simulator.wait(frame.durationMs)
                }
                if self.runID == currentRun { self.message = "Danza completata nel simulatore." }
            } catch { if self.runID == currentRun { self.message = error.localizedDescription } }
            if self.runID == currentRun { self.musicPlayer?.stop(); self.musicPlayer = nil; self.playing = false; self.currentStep = nil; self.playback = nil }
        }
    }
    @discardableResult func tryExpression(_ expression: StudioExpression) async -> Bool {
        guard !playing else { message = "Ferma prima la danza in riproduzione."; return false }
        var frame = simulator.pose; frame.expression = expression
        do { _ = try await simulator.send(frame); message = "Espressione confermata dal simulatore."; return true }
        catch { message = error.localizedDescription; return false }
    }
}

struct RobotWiFiProfile: Codable, Equatable {
    var ssid = ""
    var password = ""
    var empty: Bool { ssid.isEmpty && password.isEmpty }
    var valid: Bool {
        let name = Array(ssid.utf8), secret = Array(password.utf8)
        let ordinary = (8...63).contains(secret.count) && secret.allSatisfy { (32...126).contains($0) }
        let hex = secret.count == 64 && secret.allSatisfy { (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) }
        return !name.isEmpty && name.count <= 32 && !name.contains(0) && (ordinary || hex)
    }
}
struct RobotWiFiProfiles: Codable, Equatable {
    static let defaultHotspot = "iPhone 17 Pro Max"
    var home = RobotWiFiProfile()
    var hotspot = RobotWiFiProfile()
    var valid: Bool {
        let hotspotEmpty = hotspot.empty || (hotspot.ssid == Self.defaultHotspot && hotspot.password.isEmpty)
        return (!home.empty || !hotspotEmpty) && (home.empty || home.valid) && (hotspotEmpty || hotspot.valid) && (home.empty || hotspotEmpty || home.ssid != hotspot.ssid)
    }
}
enum WiFiVault {
    private static let query: [String:Any] = [kSecClass as String:kSecClassGenericPassword,kSecAttrService as String:"Robottino-WiFi",kSecAttrAccount as String:"network-profiles-v1"]
    static func load() throws -> RobotWiFiProfiles {
        var query = Self.query; query[kSecReturnData as String] = true
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return RobotWiFiProfiles() }
        guard status == errSecSuccess, let data = result as? Data else { throw URLError(.cannotOpenFile) }
        return try JSONDecoder().decode(RobotWiFiProfiles.self, from: data)
    }
    static func save(_ profiles: RobotWiFiProfiles) throws {
        let data = try JSONEncoder().encode(profiles)
        let status = SecItemUpdate(query as CFDictionary,[kSecValueData as String:data] as CFDictionary)
        if status == errSecItemNotFound {
            var query = Self.query; query[kSecValueData as String] = data; query[kSecAttrAccessible as String] = kSecAttrAccessibleWhenUnlockedThisDeviceOnly
            guard SecItemAdd(query as CFDictionary,nil) == errSecSuccess else { throw URLError(.cannotWriteToFile) }
        } else if status != errSecSuccess { throw URLError(.cannotWriteToFile) }
    }
    static func remove() throws {
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw URLError(.cannotWriteToFile) }
    }
}
@MainActor final class RobotNetworkSetup: ObservableObject {
    @Published var profiles = RobotWiFiProfiles()
    @Published private(set) var message = "Prepara le due reti. Il robot deve ancora essere configurato."
    @Published private(set) var onlineMessage = "Robot non ancora verificato."
    @Published private(set) var busy = false
    @Published private(set) var online = false
    /// Result of the last robot check, for the one-sentence status at the top of the Robot tab.
    enum Reach { case unchecked, online, virtual, unreachable, failed }
    @Published private(set) var reach = Reach.unchecked
    /// Backend and robot state in a single sentence.
    func summary(for store: RobotStore) -> String {
        if store.token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "Non collegato: inserisci il token Robottino in Collegamento sicuro, in fondo alla scheda." }
        guard store.connected else { return store.status }
        switch reach {
        case .unchecked: return "Servizio collegato; il robot non è ancora stato controllato."
        case .online: return "Servizio collegato e robot raggiungibile via internet."
        case .virtual: return "Servizio collegato; è online solo il robot virtuale di prova."
        case .unreachable: return "Servizio collegato, ma il robot non è raggiungibile: verifica che sia acceso, configurato e in rete."
        case .failed: return "Servizio collegato, ma il controllo del robot non è riuscito: verifica la connessione internet."
        }
    }
    var canSendToRobot: Bool { false } // Never through the cloud; the local Bluetooth path is RobotWiFiSender.
    private let load: () throws -> RobotWiFiProfiles
    private let save: (RobotWiFiProfiles) throws -> Void
    private let remove: () throws -> Void
    private var revision = UUID()
    init(load: @escaping () throws -> RobotWiFiProfiles = WiFiVault.load, save: @escaping (RobotWiFiProfiles) throws -> Void = WiFiVault.save, remove: @escaping () throws -> Void = WiFiVault.remove) {
        self.load = load; self.save = save; self.remove = remove
        do { profiles = try load(); if profiles.hotspot.ssid.isEmpty && profiles.hotspot.password.isEmpty { profiles.hotspot.ssid = RobotWiFiProfiles.defaultHotspot } } catch { message = "Impossibile leggere i profili dal Portachiavi. Riprova quando l’iPhone è sbloccato." }
    }
    @discardableResult func saveOnPhone() -> Bool {
        guard profiles.valid else { message = "Controlla nome rete e password. Usa password di almeno 8 caratteri e nomi diversi per casa e hotspot."; return false }
        do { try save(profiles); message = "Profili salvati nel Portachiavi dell’iPhone. Non ancora inviati al robot."; return true }
        catch { message = "Salvataggio nel Portachiavi non riuscito."; return false }
    }
    func clearOnPhone() {
        do { try remove(); profiles = RobotWiFiProfiles(); profiles.hotspot.ssid = RobotWiFiProfiles.defaultHotspot; message = "Profili rimossi da questo iPhone. Nessuna rete del robot modificata." }
        catch { message = "Rimozione dal Portachiavi non riuscita." }
    }
    // Hides draft passwords only; an online check in progress still reports its result.
    func concealDraft() { profiles.home.password = ""; profiles.hotspot.password = "" }
    func restorePasswords() {
        do {
            let saved = try load()
            if profiles.home.ssid == saved.home.ssid { profiles.home.password = saved.home.password }
            if profiles.hotspot.ssid == saved.hotspot.ssid { profiles.hotspot.password = saved.hotspot.password }
        } catch { message = "Sblocca l’iPhone per recuperare le password salvate." }
    }
    func check(using store: RobotStore) async {
        guard !busy else { return }
        guard !store.token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { onlineMessage = "Configura il token in Collegamento sicuro, in fondo alla scheda."; return }
        busy = true; let current = revision
        defer { if revision == current { busy = false } }
        struct Status: Decodable { var connected: Bool; var simulated: Bool? }
        do {
            let status = try JSONDecoder().decode(Status.self, from: await store.request("api/robot/status"))
            guard revision == current else { return }
            online = status.connected && status.simulated != true
            reach = status.simulated == true ? .virtual : online ? .online : .unreachable
            onlineMessage = status.simulated == true ? "È online un dispositivo virtuale di prova." : online ? "Robot raggiungibile via internet. Il nome della rete usata non è ancora verificabile." : "Robot non raggiungibile dal servizio. Verifica alimentazione, configurazione e rete."
        } catch { guard revision == current else { return }; online = false; reach = .failed; onlineMessage = "Controllo robot non riuscito. Verifica il collegamento sicuro e internet." }
    }
}

@main struct RobottinoApp: App {
    @StateObject private var store = RobotStore()
    // Timer notifications also show while the app is open.
    init() { RobotPhoneTimers.shared.install() }
    var body: some Scene { WindowGroup { RobotHome().environmentObject(store) } }
}
struct RobotHome: View {
    @EnvironmentObject var store: RobotStore
    @Environment(\.scenePhase) private var scenePhase
    private enum InputField: Hashable { case token, memory }
    @FocusState private var focusedField: InputField?
    @AppStorage("robot.face.style") private var selectedFaceStyle = "portrait"
    @State private var selectedTab = 0
    @State private var memoryText = ""
    @State private var editingID: String?
    @State private var showClear = false
    @StateObject private var networkSetup = RobotNetworkSetup()
    @ObservedObject private var conversationFollow = RobotConversationFollow.shared
    @State private var actionMessage = ""
    var body: some View {
        TabView(selection: $selectedTab) {
            NavigationStack { Form {
                Section("Stato") {
                    Text(networkSetup.summary(for: store))
                    Button("Controlla robot online") { Task { await networkSetup.check(using: store) } }.disabled(networkSetup.busy)
                    if networkSetup.busy || store.busy { ProgressView() }
                }
                Section("Conversazione") {
                    Toggle("Segui il mio viso mentre parliamo", isOn: $conversationFollow.enabled)
                    Text(conversationFollow.note).font(.caption)
                    Text("Con l’app aperta, quando parli con il robot la sua camera manda piccole immagini all’iPhone, che trova il tuo viso e gli dice dove girare la testa. Le immagini non vengono salvate. Si ferma a fine conversazione, chiudendo l’app o aprendo Live e Test.").font(.caption)
                }
                RobotPairingSection()
                RobotNetworkSection(setup: networkSetup)
                Section("Collegamento sicuro") {
                    SecureField("Token Robottino", text: $store.token).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focusedField, equals: .token)
                    Button(store.connected ? "Aggiorna collegamento" : "Collega e salva token") { focusedField = nil; Task { await store.connect(); actionMessage = store.lastSucceeded ? "Confermato: collegamento aggiornato." : store.status } }
                    if !actionMessage.isEmpty { Text(actionMessage).font(.caption) }
                    Text("Il token resta nel Portachiavi di questo iPhone. Le chiavi OpenAI ed ElevenLabs restano sul server.").font(.caption)
                }
            }.disabled(store.busy).scrollDismissesKeyboard(.interactively).navigationTitle("Robottino")
                .toolbar { ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Chiudi tastiera") { focusedField = nil; UIApplication.shared.sendAction(#selector(UIResponder.resignFirstResponder), to: nil, from: nil, for: nil) } } }
            }.tabItem { Label("Robot", systemImage: "face.smiling") }.tag(0)
            RobotAppearancePanel()
                .tabItem { Label("Aspetto", systemImage: "paintpalette") }.tag(4)
            RobotStudioPanel()
                .tabItem { Label("Studio", systemImage: "sparkles") }.tag(3)
            RobotTestPanel()
                .tabItem { Label("Test", systemImage: "slider.horizontal.3") }.tag(2)
        }.onChange(of: selectedTab) { focusedField = nil }
            .task { if RobotFaceStyle(rawValue: selectedFaceStyle) == nil { selectedFaceStyle = RobotFaceStyle.portrait.rawValue }; conversationFollow.resume(store: store); await store.restoreConnection(); if store.connected { await networkSetup.check(using: store) } }
            .onChange(of: scenePhase) { _, phase in
                if phase == .active { conversationFollow.resume(store: store); Task { await store.restoreConnection(); if store.connected { await networkSetup.check(using: store) } } }
                if phase == .background { conversationFollow.pause() }
            }
    }
}

/// Face style and voice model, moved out of the Robot tab into their own tab.
struct RobotAppearancePanel: View {
    @EnvironmentObject var store: RobotStore
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("robot.face.style") private var selectedFaceStyle = "portrait"
    @StateObject private var faceClient = RobotLiveClient()
    @State private var faceApplying = false
    @State private var faceMessage = "Scegli un volto e applicalo al robot quando è acceso."
    @State private var voiceMessage = ""
    var body: some View {
        NavigationStack {
            Form {
                Section("Aspetto del volto") {
                    LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())]) {
                        ForEach(RobotFaceStyle.allCases) { style in
                            faceChoice(style.rawValue, title: style.title, image: style.image(style == .white ? "happy" : "neutral"))
                        }
                    }
                    if faceApplying { ProgressView("Collegamento al robot…") }
                    Text(faceMessage).font(.caption)
                    Text("La scelta è salvata su questo iPhone. L’applicazione richiede robot acceso, collegato e firmware verificato.").font(.caption)
                }
                Section("Modello, voce e lingua") {
                    Picker("Modello vocale", selection: Binding(get: { store.provider }, set: { value in store.provider = value; if let first = store.voices[value]?.first { store.voice = first.id } })) { Text("OpenAI Live 1").tag("openai"); Text("ElevenLabs V1 Max").tag("elevenlabs") }
                    Picker("Voce", selection: $store.voice) { ForEach(store.voices[store.provider] ?? []) { Text(store.provider == "elevenlabs" ? $0.displayName : $0.name).tag($0.id) } }
                    Picker("Lingua", selection: $store.language) { Text("Italiano").tag("it"); Text("English").tag("en") }
                    Button("Salva modello, voce e lingua") { Task { await store.saveVoice(); voiceMessage = store.lastSucceeded ? "Confermato: modello, voce e lingua salvati." : store.status } }
                    if !voiceMessage.isEmpty { Text(voiceMessage).font(.caption) }
                    Text("La scelta vale per le nuove sessioni. La lingua è quella in cui Robottino ti capisce e ti parla; i comandi a voce funzionano in tutte e due.").font(.caption)
                }
            }.disabled(store.busy).navigationTitle("Aspetto")
        }
        .onChange(of: scenePhase) { _, phase in if phase == .background { faceClient.disconnect() } }
    }
    @ViewBuilder private func faceChoice(_ style: String, title: String, image: String) -> some View {
        Button {
            selectedFaceStyle = style
            if store.token.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { faceMessage = "Scelta salvata su iPhone. Collega prima il backend per applicarla al robot." }
            else { Task { await applyFaceToRobot() } }
        } label: {
            VStack {
                Image(image).resizable().aspectRatio(contentMode: .fit)
                Label(title, systemImage: selectedFaceStyle == style ? "checkmark.circle.fill" : "circle")
            }.padding(5).overlay(RoundedRectangle(cornerRadius: 12).stroke(selectedFaceStyle == style ? Color.accentColor : Color.clear, lineWidth: 3))
        }.buttonStyle(.plain).disabled(faceApplying)
            .accessibilityAddTraits(selectedFaceStyle == style ? .isSelected : [])
    }
    @MainActor private func applyFaceToRobot() async {
        guard !faceApplying else { return }
        faceApplying = true; defer { faceApplying = false; faceClient.disconnect() }
        let selected = selectedFaceStyle
        faceMessage = "Collegamento al robot in corso…"
        faceClient.connect(token: store.token)
        do {
            // Up to 15 s: after each use of the app the robot needs a few seconds to reconnect (9 Nov 2026:
            // a second choice right after the first one never reached it).
            for step in 0..<150 {
                if faceClient.ready { break }
                if step == 30 { faceMessage = "Attendo che il robot si ricolleghi…" }
                try await Task.sleep(nanoseconds: 100_000_000)
                guard scenePhase == .active else { throw RobotLiveError.offline }
            }
            guard faceClient.ready, faceClient.status?.screen == true, faceClient.status?.hardwareVerified == true, faceClient.status?.simulated != true else { throw RobotLiveError.offline }
            try await faceClient.command("face.style", values: ["style":selected])
            faceMessage = selected == selectedFaceStyle ? "Confermato: volto applicato al robot." : "Volto applicato; la nuova scelta su iPhone non è ancora applicata."
        } catch { faceMessage = "Scelta salvata su iPhone; non ancora applicata al robot. Verifica che sia acceso, collegato e configurato." }
    }
}

struct RobotMemoriesPanel: View {
    @EnvironmentObject var store: RobotStore
    @FocusState private var memoryFocused: Bool
    @State private var memoryText = ""
    @State private var editingID: String?
    @State private var showClear = false
    @State private var actionMessage = ""
    var body: some View {
        List {
                Section(editingID == nil ? "Nuovo ricordo" : "Correggi ricordo") {
                    TextField("Informazione da ricordare", text: $memoryText, axis: .vertical).focused($memoryFocused)
                    Button("Salva ricordo") { memoryFocused = false; let text = memoryText, id = editingID; Task { await store.saveMemory(text, id: id); if store.lastSucceeded { memoryText = ""; editingID = nil; actionMessage = "Confermato: ricordo salvato." } else { actionMessage = store.status } } }.disabled(memoryText.trimmingCharacters(in: .whitespaces).isEmpty || memoryText.count > 500)
                    if editingID != nil { Button("Annulla modifica") { memoryFocused = false; editingID = nil; memoryText = "" } }
                }
                Section("Ricordi permanenti") { ForEach(store.memories) { item in
                    VStack(alignment: .leading) { Text(item.text); Text(item.kindName).font(.caption).foregroundStyle(.secondary) }
                        .swipeActions { Button("Dimentica", role: .destructive) { Task { await store.forget(item.id); actionMessage = store.lastSucceeded ? "Confermato: ricordo eliminato." : store.status } }; Button("Modifica") { editingID = item.id; memoryText = item.text } }
                } }
                Section { Button("Cancella tutti i ricordi", role: .destructive) { showClear = true }.disabled(store.memories.isEmpty) }
                Section { Text(actionMessage.isEmpty ? store.status : actionMessage).font(.caption) }
            }.disabled(store.busy).scrollDismissesKeyboard(.interactively).navigationTitle("Ricordi").refreshable { await store.connect() }
                .toolbar {
                    ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Chiudi tastiera") { memoryFocused = false } }
                }
                .confirmationDialog("Cancellare tutti i ricordi permanenti?", isPresented: $showClear, titleVisibility: .visible) { Button("Cancella tutti", role: .destructive) { Task { await store.clearAll(); actionMessage = store.lastSucceeded ? "Confermato: ricordi eliminati." : store.status } } } message: { Text("La cronologia recente delle conversazioni non viene cancellata.") }
    }
}

struct StudioPortrait: View {
    @AppStorage("robot.face.style") private var faceStyle = "portrait"
    let frame: StudioFrame
    var body: some View {
        VStack(spacing: 10) {
            Image(RobotFaceStyle.from(faceStyle).image(frame.expression.rawValue)).resizable().aspectRatio(4 / 3, contentMode: .fit)
                .clipShape(RoundedRectangle(cornerRadius: 22))
                .rotation3DEffect(.degrees(frame.yaw), axis: (x: 0, y: 1, z: 0))
                .rotation3DEffect(.degrees(frame.pitch), axis: (x: 1, y: 0, z: 0))
                .animation(.easeInOut(duration: Double(frame.durationMs) / 1000), value: frame.yaw)
                .animation(.easeInOut(duration: Double(frame.durationMs) / 1000), value: frame.pitch)
                .accessibilityLabel("Anteprima: \(frame.expression.name), orizzontale \(Int(frame.yaw)) gradi, verticale \(Int(frame.pitch)) gradi")
            HStack {
                Capsule().fill(frame.leftLight.color).frame(height: 8)
                Capsule().fill(frame.rightLight.color).frame(height: 8)
            }.accessibilityLabel("Luci simulate: \(frame.leftLight.name), \(frame.rightLight.name)")
        }.padding(.vertical, 8)
    }
}
struct StudioLivePreview: View {
    @ObservedObject var simulator: StudioSimulator
    var caption = "ANTEPRIMA SIMULATA"
    var body: some View {
        VStack { StudioPortrait(frame: simulator.pose); Text(caption).font(.caption2).foregroundStyle(.secondary) }
    }
}
struct StudioConnectionBar: View {
    @ObservedObject var simulator: StudioSimulator
    var body: some View {
        HStack {
            Label(simulator.link.rawValue, systemImage: simulator.connected ? "checkmark.circle.fill" : "circle.dashed")
                .foregroundStyle(simulator.connected ? Color.mint : Color.secondary)
            Spacer()
            if simulator.link == .disconnected || simulator.link == .fault {
                Button("Collega simulatore") { Task { await simulator.connect() } }
            } else {
                Button("Scollega") { simulator.disconnect() }
            }
        }.font(.callout).buttonStyle(.bordered)
    }
}
struct RobotStudioPanel: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var studio = RobotStudio()
    var body: some View {
        NavigationStack {
            List {
                Section {
                    Text("Crea e prova il carattere di Robottino").font(.headline)
                    Text("Danze, espressioni e simulatore funzionano in locale. Live permette il collegamento al robot.").font(.caption).foregroundStyle(.secondary)
                }
                NavigationLink { StudioDanceEditor() } label: { Label("Editor danze", systemImage: "music.note.list") }
                NavigationLink { StudioExpressionLibrary() } label: { Label("Espressioni", systemImage: "face.smiling") }
                NavigationLink { StudioConnectionSimulator() } label: { Label("Simulatore collegamento", systemImage: "point.3.connected.trianglepath.dotted") }
                NavigationLink { RobotLivePanel() } label: { Label("Live", systemImage: "video") }
                NavigationLink { RobotMemoriesPanel() } label: { Label("Ricordi", systemImage: "brain.head.profile") }
                Section("Parla con Robottino") {
                    NavigationLink { RobotVoicePanel() } label: { Label("Conversazione vocale", systemImage: "waveform") }
                    Text("Con microfono e altoparlante dell’iPhone, anche senza robot.").font(.caption)
                }
            }.navigationTitle("Studio Robottino")
        }.environmentObject(studio)
            .onDisappear { studio.leave() }
            .onChange(of: scenePhase) { _, phase in if phase != .active { studio.leave() } }
    }
}
struct StudioDanceFile: FileDocument {
    static var readableContentTypes: [UTType] { [.json] }
    var data: Data
    init(data: Data = Data()) { self.data = data }
    init(configuration: ReadConfiguration) throws { data = configuration.file.regularFileContents ?? Data() }
    func fileWrapper(configuration: WriteConfiguration) throws -> FileWrapper { FileWrapper(regularFileWithContents: data) }
}
struct StudioPlaybackControls: View {
    @EnvironmentObject var studio: RobotStudio
    @ObservedObject var simulator: StudioSimulator
    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            StudioConnectionBar(simulator: simulator)
            HStack {
                Button(studio.playing ? "Riproduzione…" : "Prova danza") { studio.play() }
                    .disabled(studio.playing || !simulator.connected || simulator.pending)
                Spacer()
                Button("Ferma", role: .destructive) { studio.stop() }
            }.buttonStyle(.bordered)
            if let step = studio.currentStep { Text("Passo \(step + 1) di \(studio.draft.frames.count)").font(.caption) }
            Text(studio.message).font(.caption).foregroundStyle(.secondary)
        }
    }
}
struct StudioDanceEditor: View {
    @EnvironmentObject var studio: RobotStudio
    @EnvironmentObject var store: RobotStore
    @StateObject private var robotDance = RobotDanceSender()
    @AppStorage("robot.face.style") private var faceStyle = "portrait"
    @FocusState private var nameFocused: Bool
    @State private var importing = false
    @State private var importingMusic = false
    @State private var exporting = false
    @State private var exportFile = StudioDanceFile()
    @State private var removing: StudioDance?
    var body: some View {
        List {
            Section("Robot virtuale") {
                StudioLivePreview(simulator: studio.simulator)
                StudioPlaybackControls(simulator: studio.simulator)
            }
            Section("Danza nell’editor") {
                TextField("Nome della danza", text: $studio.draft.name).focused($nameFocused).disabled(studio.playing)
                Text("\(studio.draft.frames.count) passi · \(Double(studio.draft.durationMs) / 1000, specifier: "%.1f") secondi").font(.caption)
                HStack {
                    Button("Salva") { nameFocused = false; studio.save() }
                    Spacer()
                    Button("Nuova") { nameFocused = false; studio.newDance() }
                    Button("Duplica") { studio.duplicate() }
                }.disabled(studio.playing)
            }
            Section("Passi · modifica l’ordine con Modifica") {
                ForEach($studio.draft.frames) { $frame in
                    NavigationLink { StudioFrameEditor(frame: $frame) } label: {
                        HStack {
                            Image(RobotFaceStyle.from(faceStyle).image(frame.expression.rawValue)).resizable().scaledToFit().frame(width: 58, height: 44).clipShape(RoundedRectangle(cornerRadius: 8))
                            VStack(alignment: .leading) {
                                Text(frame.expression.name)
                                Text("\(Int(frame.yaw))° / \(Int(frame.pitch))° · \(Double(frame.durationMs) / 1000, specifier: "%.1f") s").font(.caption).foregroundStyle(.secondary)
                            }
                        }
                    }
                }.onDelete { studio.removeFrames($0) }.onMove { studio.reorder(from: $0, to: $1) }.disabled(studio.playing)
                Button("Aggiungi passo", systemImage: "plus") { studio.addFrame() }.disabled(studio.playing || studio.draft.frames.count >= 32)
                Text("Limiti dell’anteprima: ±10°, massimo 32 passi e 60 secondi. Non sono una calibrazione del robot.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Robot vero") {
                if robotDance.running { Button("Ferma sul robot", role: .destructive) { robotDance.stop() } }
                else { Button("Esegui sul robot") { nameFocused = false; studio.stop(); robotDance.play(studio.draft, token: store.token) }.disabled(studio.playing || store.token.isEmpty) }
                if robotDance.running { ProgressView() }
                Text(robotDance.message).font(.caption)
                Text("Invia i passi così come sono nell’editor (anche se non salvati). Musica e luci restano sull’iPhone. Chiudere la pagina o l’app ferma la danza.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Musica facoltativa · solo iPhone") {
                Text(studio.draft.musicName ?? "Nessuna traccia scelta").font(.callout)
                Button("Usa traccia predefinita") { studio.useDefaultMusic() }.disabled(studio.playing)
                Menu("Scegli musica Robottino") {
                    ForEach(StudioDance.builtInTracks.indices, id: \.self) { index in
                        Button(StudioDance.builtInTracks[index].title) { studio.useBuiltInMusic(StudioDance.builtInTracks[index].file) }
                    }
                }.disabled(studio.playing)
                Button("Scegli un file audio…") { nameFocused = false; importingMusic = true }.disabled(studio.playing)
                if studio.draft.musicFile != nil { Button("Rimuovi traccia") { studio.removeMusic() }.disabled(studio.playing) }
                Text("MP3, M4A, WAV, AAC o CAF · massimo 20 MB e 10 minuti. Parte dal primo passo confermato e si ferma alla fine o allo stop. Il file JSON esportato contiene i passi, non l’audio.").font(.caption).foregroundStyle(.secondary)
            }
            Section("Danze salvate su questo iPhone") {
                if studio.library.isEmpty { Text("Nessuna danza salvata.").foregroundStyle(.secondary) }
                ForEach(studio.library) { dance in
                    Button { nameFocused = false; studio.load(dance) } label: {
                        HStack { Text(dance.name); Spacer(); Text("\(dance.frames.count) passi").font(.caption).foregroundStyle(.secondary) }
                    }.swipeActions { Button("Elimina", role: .destructive) { removing = dance } }
                }
            }
            Section("File danza") {
                Button("Esporta danza…") {
                    nameFocused = false
                    do { exportFile = StudioDanceFile(data: try studio.exportDraft()); exporting = true }
                    catch { studio.message = error.localizedDescription }
                }.disabled(studio.playing)
                Button("Importa danza…") { nameFocused = false; importing = true }.disabled(studio.playing)
            }
        }.navigationTitle("Editor danze").scrollDismissesKeyboard(.interactively)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) { EditButton().disabled(studio.playing) }
                ToolbarItemGroup(placement: .keyboard) { Spacer(); Button("Chiudi tastiera") { nameFocused = false } }
            }
            .onDisappear { studio.stop(); robotDance.stop() }
            .confirmationDialog("Eliminare questa danza dalla libreria locale?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), titleVisibility: .visible) {
                Button("Elimina danza", role: .destructive) { if let dance = removing { studio.delete(dance) }; removing = nil }
            }
            .fileExporter(isPresented: $exporting, document: exportFile, contentType: .json, defaultFilename: "danza-robottino") { result in
                if case .failure(let error) = result { studio.message = error.localizedDescription }
            }
            .fileImporter(isPresented: $importing, allowedContentTypes: [.json]) { result in
                do {
                    let url = try result.get(), access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    let size = try url.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
                    guard size <= 65536 else { throw StudioError.invalidDance }
                    try studio.importDance(Data(contentsOf: url))
                } catch { studio.message = error.localizedDescription }
            }
            .fileImporter(isPresented: $importingMusic, allowedContentTypes: [.audio]) { result in
                do {
                    let url = try result.get(), access = url.startAccessingSecurityScopedResource()
                    defer { if access { url.stopAccessingSecurityScopedResource() } }
                    try studio.importMusic(from: url)
                } catch { studio.message = "Traccia non caricata: \(error.localizedDescription)" }
            }
    }
}
struct StudioFrameEditor: View {
    @Binding var frame: StudioFrame
    var body: some View {
        Form {
            Section("Anteprima del passo · simulazione") { StudioPortrait(frame: frame) }
            Section("Movimento") {
                Text("Orizzontale: \(Int(frame.yaw))°")
                Slider(value: $frame.yaw, in: -10...10, step: 1).accessibilityLabel("Angolo orizzontale")
                Text("Verticale: \(Int(frame.pitch))°")
                Slider(value: $frame.pitch, in: -10...10, step: 1).accessibilityLabel("Angolo verticale")
                Stepper("Durata: \(Double(frame.durationMs) / 1000, specifier: "%.1f") s", value: $frame.durationMs, in: 300...5000, step: 100)
            }
            Section("Volto e luci") {
                Picker("Espressione", selection: $frame.expression) { ForEach(StudioExpression.allCases) { Text($0.name).tag($0) } }
                Picker("Luce sinistra", selection: $frame.leftLight) { ForEach(StudioLight.allCases) { Text($0.name).tag($0) } }
                Picker("Luce destra", selection: $frame.rightLight) { ForEach(StudioLight.allCases) { Text($0.name).tag($0) } }
            }
        }.navigationTitle("Modifica passo")
    }
}
struct StudioExpressionLibrary: View {
    enum Outcome: Equatable { case sending, confirmed, failed, added }
    @EnvironmentObject var studio: RobotStudio
    @State private var attempted: StudioExpression?
    @State private var outcome = Outcome.sending
    @State private var result = ""
    var body: some View {
        List {
            Section("Robot virtuale") {
                StudioConnectionBar(simulator: studio.simulator)
                Text("Premi «Prova nel simulatore» sotto un’espressione: il risultato confermato appare direttamente in quella sezione, al posto del campione. Tutto resta sull’iPhone, il robot non riceve nulla.").font(.caption)
            }
            ForEach(StudioExpression.allCases) { expression in
                Section(expression.name) {
                    if attempted == expression && outcome == .confirmed {
                        StudioLivePreview(simulator: studio.simulator, caption: "RISULTATO NEL SIMULATORE")
                    } else {
                        StudioPortrait(frame: StudioFrame(expression: expression))
                            .overlay { if attempted == expression && outcome == .sending { ProgressView().controlSize(.large) } }
                            .overlay(alignment: .topLeading) {
                                Text("CAMPIONE").font(.caption2.bold()).padding(.horizontal, 8).padding(.vertical, 4)
                                    .background(.ultraThinMaterial, in: Capsule()).padding(16)
                            }
                    }
                    if attempted == expression && !result.isEmpty {
                        Label(result, systemImage: outcome == .failed ? "exclamationmark.triangle.fill" : outcome == .sending ? "hourglass" : "checkmark.circle.fill")
                            .font(.caption).foregroundStyle(outcome == .failed ? .red : outcome == .sending ? .secondary : .green)
                            .accessibilityIdentifier("expression.result")
                    }
                    Button("Prova nel simulatore") {
                        attempted = expression; outcome = .sending; result = "Invio al simulatore…"
                        Task {
                            let ok = await studio.tryExpression(expression)
                            guard attempted == expression else { return }
                            outcome = ok ? .confirmed : .failed
                            result = ok ? "Confermato dal simulatore: questa è la posa attuale del robot virtuale." : studio.message
                        }
                    }.disabled(studio.playing || (attempted == expression && outcome == .sending))
                    Button("Aggiungi alla danza") {
                        attempted = expression
                        guard studio.draft.frames.count < 32 else { studio.message = StudioError.invalidDance.localizedDescription; outcome = .failed; result = studio.message; return }
                        studio.draft.frames.append(StudioFrame(expression: expression)); studio.message = "Espressione aggiunta come nuovo passo."
                        outcome = .added; result = "Confermato: espressione aggiunta alla danza. Premi Salva nell’editor."
                    }.disabled(studio.playing)
                }
            }
            Section { Text("Bocca aperta e socchiusa sono pose grafiche. Non producono audio e non rappresentano una conversazione reale.").font(.caption) }
        }.navigationTitle("Espressioni")
    }
}
struct StudioConnectionSimulator: View {
    @EnvironmentObject var studio: RobotStudio
    var body: some View { StudioSimulatorDetails(simulator: studio.simulator).navigationTitle("Collegamento simulato") }
}
struct StudioSimulatorDetails: View {
    @ObservedObject var simulator: StudioSimulator
    var body: some View {
        List {
            Section("Collegamento virtuale · nessuna rete") {
                StudioConnectionBar(simulator: simulator)
                Stepper("Ritardo: \(simulator.latencyMs) ms", value: $simulator.latencyMs, in: 0...1000, step: 50)
                Picker("Prova un guasto", selection: $simulator.failure) { ForEach(StudioSimulator.Failure.allCases) { Text($0.rawValue).tag($0) } }
                Text("Il guasto scelto si applica al prossimo passo o alla prossima espressione inviata. Per riprovare dopo un timeout, scegli Nessun guasto e ricollega.").font(.caption)
                Button("Interrompi i comandi in attesa", role: .destructive) { simulator.disconnect() }
            }
            Section("Ultima posa confermata") {
                StudioLivePreview(simulator: simulator)
                if let ack = simulator.lastAck { Text("Conferma numero \(ack.sequence)").font(.caption) }
                if simulator.pending { ProgressView("In attesa della conferma…") }
            }
            Section("Eventi · ultimi 40") {
                if simulator.log.isEmpty { Text("Nessun evento.").foregroundStyle(.secondary) }
                ForEach(Array(simulator.log.enumerated()), id: \.offset) { _, entry in Text(entry).font(.caption) }
            }
        }
    }
}

struct RobotTestPanel: View {
    @EnvironmentObject var store: RobotStore
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var tests = RobotTests()
    @State private var knob = CGSize.zero
    var body: some View {
        NavigationStack {
            Form {
                Section("Collegamento al robot") {
                    if let caps = tests.caps, caps.connected {
                        Label(caps.hardwareVerified ? "Hardware verificato" : "Hardware non ancora verificato (dal menu del robot)", systemImage: caps.hardwareVerified ? "checkmark.seal.fill" : "exclamationmark.triangle")
                    } else {
                        Label(tests.caps == nil ? "Stato del robot non ancora letto" : "Robot non collegato", systemImage: "antenna.radiowaves.left.and.right.slash")
                    }
                    Text(tests.status).font(.callout)
                    // Read on entering the page (owner, 9 Nov 2026: no «Verifica il robot» button).
                    if tests.busy { ProgressView(tests.driving ? "Collegamento…" : "Verifica in corso…") }
                }
                Section("Modalità di prova") {
                    Toggle("Simulazione dei movimenti", isOn: $tests.simulation).disabled(tests.driving)
                    if tests.driving {
                        Button("Ferma il robot", role: .destructive) { tests.stopDriving() }
                    } else {
                        Button("Muovi il robot vero") { Task { await tests.startDriving(using: store) { scenePhase == .active } } }
                            .disabled(tests.simulation || tests.busy || store.token.isEmpty)
                    }
                    Text(tests.simulation ? "Anteprima sul telefono. Non muove il robot e non usa la sua telecamera." : tests.canDrive ? "Il joystick muove la testa del robot vero, un comando alla volta, con la stessa conferma di Live." : "«Muovi il robot vero» verifica da solo il robot; servono hardware verificato, calibrazione e movimenti attivi sul robot.").font(.caption)
                }
                Section("Movimenti della testa") {
                    VStack(spacing: 18) {
                        Image(systemName: "face.smiling.fill")
                            .font(.system(size: 64)).foregroundStyle(.teal)
                            .rotation3DEffect(.degrees(Double(tests.yaw)), axis: (x: 0, y: 1, z: 0))
                            .rotation3DEffect(.degrees(Double(-tests.pitch)), axis: (x: 1, y: 0, z: 0)) // negative pitch looks up
                            .animation(.easeInOut(duration: 0.4), value: tests.yaw)
                            .animation(.easeInOut(duration: 0.4), value: tests.pitch)
                            .accessibilityLabel(tests.driving ? "Posizione chiesta alla testa del robot" : "Anteprima simulata della testa")
                        Text("Testa: \(tests.yaw == 0 ? "dritta" : "\(abs(tests.yaw))° \(tests.yaw > 0 ? "a destra" : "a sinistra")") · \(tests.pitch == 0 ? "non alzata" : "\(abs(tests.pitch))° in su")").monospacedDigit().font(.caption)
                        // Up on the stick lifts the head (negative pitch, as on the robot).
                        // The knob stays where it is let go (owner, 9 Nov 2026); «Testa dritta» brings it back.
                        RobotJoystick(enabled: tests.simulation || tests.driving, knob: $knob) { x, y in tests.move(x: x, y: y) }
                    }.frame(maxWidth: .infinity)
                    Button(tests.driving ? "Testa dritta" : "Ferma simulazione", role: .destructive) { knob = .zero; if tests.driving { tests.move(x: 0, y: 0) } else { tests.stop() } }.disabled(!tests.simulation && !tests.driving)
                    Text(tests.driving ? "Trascina il pallino nel semicerchio: la testa del robot gira fino a 90° a destra o sinistra e si alza fino a 85°, sempre dentro la calibrazione del robot, a velocità costante. Lasciandolo, la testa resta lì; «Testa dritta» la rimette al centro." : tests.simulation ? "Trascina il pallino nel semicerchio: la testa simulata gira fino a 90° a destra o sinistra e si alza fino a 85°; in giù il K151 non scende. Lasciandolo resta lì. Sono gli stessi limiti del robot, non una calibrazione." : "Attiva «Simulazione dei movimenti» o «Muovi il robot vero» per usare il joystick.").font(.caption)
                }
            }.navigationTitle("Test robot")
        }.onChange(of: tests.simulation) { _, _ in tests.reset(); knob = .zero }
            .onChange(of: tests.driving) { _, driving in if !driving { knob = .zero } }
            .onAppear { Task { await tests.check(using: store) } }
            .onDisappear { tests.stopDriving(); tests.reset(); tests.simulation = false; knob = .zero }
            .onChange(of: scenePhase) { _, phase in if phase == .active { Task { await tests.check(using: store) } } else { tests.stopDriving(); tests.reset(); tests.simulation = false; knob = .zero } }
    }
}

/// Half-moon joystick (owner, 9 Nov 2026: the head cannot look down, so only the upper half): the middle of the
/// base is the head straight ahead, up lifts it, the sides turn it. The knob stays where it is let go.
/// Reports x (right positive) and y (down positive, never above 0), each -1...1.
struct RobotJoystick: View {
    var enabled: Bool
    @Binding var knob: CGSize
    var onMove: (Double, Double) -> Void
    private let width = 260.0, knobSize = 64.0
    private var radius: Double { width / 2 }
    private var reach: Double { radius - knobSize / 2 }
    private var height: Double { radius + knobSize / 2 }
    var body: some View {
        ZStack {
            RobotJoystickArch(radius: radius).fill(Color.secondary.opacity(0.12))
            RobotJoystickArch(radius: radius).stroke(Color.secondary.opacity(0.35), lineWidth: 2)
            Path { p in p.move(to: CGPoint(x: radius, y: radius)); p.addLine(to: CGPoint(x: radius, y: 18)); p.move(to: CGPoint(x: 18, y: radius)); p.addLine(to: CGPoint(x: width - 18, y: radius)) }
                .stroke(Color.secondary.opacity(0.25), style: StrokeStyle(lineWidth: 1, dash: [4, 4]))
            Image(systemName: "chevron.up").position(x: radius, y: 12)
            Image(systemName: "chevron.left").position(x: 12, y: radius - 14)
            Image(systemName: "chevron.right").position(x: width - 12, y: radius - 14)
            Circle().fill(Color.teal.gradient).frame(width: knobSize, height: knobSize)
                .shadow(color: .black.opacity(0.25), radius: 6, y: 3)
                .position(x: radius + knob.width, y: radius + knob.height)
        }
        .foregroundStyle(.secondary)
        .frame(width: width, height: height)
        .contentShape(RobotJoystickArch(radius: radius))
        .gesture(DragGesture(minimumDistance: 0)
            .onChanged { value in
                var dx = value.location.x - radius, dy = min(0, value.location.y - radius)
                let distance = hypot(dx, dy)
                if distance > reach { dx *= reach / distance; dy *= reach / distance }
                knob = CGSize(width: dx, height: dy)
                onMove(dx / reach, dy / reach)
            }
            )
        .opacity(enabled ? 1 : 0.4)
        .allowsHitTesting(enabled)
        .accessibilityElement()
        .accessibilityLabel("Joystick della testa")
        .accessibilityHint("Trascina in su per alzare la testa, ai lati per girarla")
    }
}

/// Upper half of a disc on a short base that holds the knob when the head is straight.
struct RobotJoystickArch: Shape {
    var radius: Double
    func path(in rect: CGRect) -> Path {
        var p = Path(), centre = CGPoint(x: rect.minX + radius, y: rect.minY + radius)
        p.move(to: CGPoint(x: rect.minX, y: rect.maxY - 12))
        p.addLine(to: CGPoint(x: rect.minX, y: centre.y))
        p.addArc(center: centre, radius: radius, startAngle: .degrees(180), endAngle: .degrees(360), clockwise: false)
        p.addLine(to: CGPoint(x: rect.maxX, y: rect.maxY - 12))
        p.addQuadCurve(to: CGPoint(x: rect.maxX - 12, y: rect.maxY), control: CGPoint(x: rect.maxX, y: rect.maxY))
        p.addLine(to: CGPoint(x: rect.minX + 12, y: rect.maxY))
        p.addQuadCurve(to: CGPoint(x: rect.minX, y: rect.maxY - 12), control: CGPoint(x: rect.minX, y: rect.maxY))
        p.closeSubpath(); return p
    }
}

/// First pairing: the robot shows a 6-digit code; the server gives it its credential only after
/// the owner types that code here, and success comes only after the robot confirms it saved it.
struct RobotPairingSection: View {
    @EnvironmentObject var store: RobotStore
    @State private var code = ""
    @State private var running = false
    @State private var message = ""
    var body: some View {
        Section("Abbina robot") {
            TextField("Codice di 6 cifre", text: $code).keyboardType(.numberPad).textContentType(.oneTimeCode)
                .onChange(of: code) { _, value in let digits = String(value.filter(\.isNumber).prefix(6)); if digits != value { code = digits } }
            if running { ProgressView("Attendo la conferma del robot…") }
            else { Button("Abbina") { pair() }.disabled(code.count != 6 || !store.connected) }
            if !message.isEmpty { Text(message).font(.caption) }
            Text("Serve solo la prima volta o dopo un reset: il robot senza credenziale mostra il codice sullo schermo (anche dal suo menu, «Abbina con l’app»). Il codice dura 5 minuti.").font(.caption)
        }
    }
    private func pair() {
        running = true; message = ""
        Task {
            do { _ = try await store.request("api/robot/pair", body: ["code": code]); message = "Confermato: il robot ha salvato la sua credenziale e si collega."; code = "" }
            catch { message = error.localizedDescription }
            running = false
        }
    }
}

struct RobotNetworkSection: View {
    @EnvironmentObject var store: RobotStore
    @Environment(\.scenePhase) private var scenePhase
    @ObservedObject var setup: RobotNetworkSetup
    @State private var clearing = false
    @State private var showSaveResult = false
    @State private var saveSucceeded = false
    @State private var bluetoothNote = ""
    @StateObject private var wifiSender = RobotWiFiSender()
    @FocusState private var focused: Bool
    private func sendToRobot() {
        // Hotspot first, home last: the robot keeps home as its main network and the hotspot as spare.
        let networks = [setup.profiles.hotspot, setup.profiles.home].filter(\.valid).map { (ssid: $0.ssid, password: $0.password) }
        if networks.isEmpty { bluetoothNote = "Profili salvati. Per l’invio completa nome e password di almeno una rete." }
        else { bluetoothNote = ""; wifiSender.send(networks) }
    }
    var body: some View {
        Section("Wi-Fi del robot") {
            DisclosureGroup("Wi-Fi di casa") {
                TextField("Nome rete di casa", text: $setup.profiles.home.ssid).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused)
                SecureField("Password rete di casa", text: $setup.profiles.home.password).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused)
            }
            DisclosureGroup("Hotspot dell’iPhone") {
                TextField("Nome hotspot (nome dell’iPhone)", text: $setup.profiles.hotspot.ssid).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused)
                SecureField("Password hotspot", text: $setup.profiles.hotspot.password).textInputAutocapitalization(.never).autocorrectionDisabled().focused($focused)
                Text("In Impostazioni → Hotspot personale attiva Consenti agli altri di accedere e Ottimizza la compatibilità. Copia qui il nome e la password indicati dall’iPhone. La rete deve essere a2,4GHz.").font(.caption)
            }
            Text("Il robot ricorda entrambe le reti e all’accensione usa da solo quella che trova: casa se c’è, altrimenti l’hotspot.").font(.caption)
            // Saving also sends the chosen network to the robot over Bluetooth, automatically.
            Button("Salva e invia al robot") {
                focused = false; saveSucceeded = setup.saveOnPhone()
                if saveSucceeded { sendToRobot() } else { showSaveResult = true }
            }.disabled(wifiSender.running)
            Text(setup.message).font(.caption)
            if wifiSender.running { Button("Annulla invio", role: .destructive) { wifiSender.cancel() }; ProgressView() }
            Text(bluetoothNote.isEmpty || wifiSender.running ? wifiSender.message : bluetoothNote).font(.caption)
            Button("Rimuovi profili da questo iPhone", role: .destructive) { focused = false; clearing = true }
            Text("Fuori casa l’hotspot usa i dati cellulare. Non si attiva automaticamente dall’app. Il controllo online non rivela quale delle due reti sta usando il robot.").font(.caption)
        }.alert(saveSucceeded ? "Profili salvati" : "Salvataggio non riuscito", isPresented: $showSaveResult) {
            Button("OK", role: .cancel) {}
        } message: { Text(setup.message) }
        .confirmationDialog("Rimuovere i due profili dal Portachiavi dell’iPhone?", isPresented: $clearing, titleVisibility: .visible) {
            Button("Rimuovi profili", role: .destructive) { setup.clearOnPhone() }
        }.onDisappear { focused = false; setup.concealDraft() }
            .onAppear { setup.restorePasswords() }
            .onChange(of: scenePhase) { _, phase in
                if phase == .background { focused = false; setup.concealDraft() }
                if phase == .active { setup.restorePasswords() }
            }

    }
}
