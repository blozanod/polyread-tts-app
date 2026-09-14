import Foundation
import CoreML
import PolyReadCore

/// §0.2's answer lives here. It is a setting rather than a constant because the
/// question — "Does `KokoroAcoustic` run with `.cpuOnly`?" — is empirical, the
/// model card contradicts itself about it, and the answer changes §7.3
/// wholesale. The benchmark screen writes it after measuring.
public enum AcousticPlacement: String, Codable, CaseIterable, Sendable {
    case all
    case cpuAndNeuralEngine
    case cpuOnly

    public var mlComputeUnits: MLComputeUnits {
        switch self {
        case .all: return .all
        case .cpuAndNeuralEngine: return .cpuAndNeuralEngine
        case .cpuOnly: return .cpuOnly
        }
    }

    public var label: String {
        switch self {
        case .all: return "All (GPU + ANE + CPU)"
        case .cpuAndNeuralEngine: return "CPU + Neural Engine"
        case .cpuOnly: return "CPU only"
        }
    }

    /// §7.3 — "If §0.2 shows acoustic runs `.cpuOnly`, none of the above is
    /// needed — Phase B submits no Metal work and keeps rendering while
    /// backgrounded."
    public var keepsRenderingInBackground: Bool { self == .cpuOnly }
}

public struct AppSettings: Codable, Equatable, Sendable {
    /// §7.1 — "**Voice:** hardcode one for v1. Picker is v1.1."
    public var voiceName: String
    public var acousticComputeUnits: AcousticPlacement
    /// §7.3 — "~60 s of audio exists."
    public var initialAudioLead: TimeInterval
    /// §7.4 — "a size cap (default ~4 GB)".
    public var cacheByteLimit: Int
    public var playbackRate: Float

    public static let `default` = AppSettings(
        voiceName: "af_heart",
        acousticComputeUnits: .all,
        initialAudioLead: 60,
        cacheByteLimit: 4 * 1024 * 1024 * 1024,
        playbackRate: 1.0
    )

    static let storageKey = "PolyRead.settings"

    public static func load() -> AppSettings {
        guard let data = UserDefaults.standard.data(forKey: storageKey),
              let settings = try? JSONDecoder().decode(AppSettings.self, from: data)
        else { return .default }
        return settings
    }

    public func save() {
        guard let data = try? JSONEncoder().encode(self) else { return }
        UserDefaults.standard.set(data, forKey: Self.storageKey)
    }
}
