import Foundation
import PolyReadCore

/// Phoneme symbol → Kokoro token id.
///
/// ## Read this before trusting the built-in table
///
/// `Fallback.table` below is a reconstruction of Kokoro's symbol list. It has
/// **not** been checked against the Core ML package that ships with this app,
/// and a vocabulary that is off by one produces confident, fluent nonsense
/// rather than an error. So:
///
/// 1. If the app bundle contains `kokoro_vocab.json` (a flat
///    `{"symbol": id}` map, which is what the upstream repo emits), that is
///    used and the built-in table is ignored.
/// 2. Otherwise the fallback is used and `isVerified` reports false, which the
///    §0 benchmark screen surfaces.
///
/// `BenchmarkRunner.checkVocabulary()` round-trips a known phrase so a mismatch
/// shows up at the gate rather than three hours into a listening session.
public struct KokoroVocabulary: Sendable {

    public let symbolToID: [String: Int32]
    public let source: String
    public let isVerified: Bool

    public static let shared: KokoroVocabulary = load()

    public init(symbolToID: [String: Int32], source: String, isVerified: Bool) {
        self.symbolToID = symbolToID
        self.source = source
        self.isVerified = isVerified
    }

    public static func load(bundle: Bundle = .main) -> KokoroVocabulary {
        if let url = bundle.url(forResource: "kokoro_vocab", withExtension: "json"),
           let data = try? Data(contentsOf: url),
           let decoded = try? JSONDecoder().decode([String: Int32].self, from: data),
           !decoded.isEmpty {
            return KokoroVocabulary(symbolToID: decoded, source: "kokoro_vocab.json", isVerified: true)
        }
        return KokoroVocabulary(
            symbolToID: Fallback.table,
            source: "built-in reconstruction (UNVERIFIED)",
            isVerified: false
        )
    }

    /// Encodes a phoneme string to token ids. Unknown symbols are dropped and
    /// reported rather than silently mapped to the pad id — a pad in the middle
    /// of a word would shift every duration after it.
    public func encode(_ phonemes: String) -> (tokens: [Int32], unknown: [String]) {
        var tokens: [Int32] = []
        var unknown: [String] = []
        for character in phonemes {
            let symbol = String(character)
            if let id = symbolToID[symbol] {
                tokens.append(id)
            } else {
                unknown.append(symbol)
            }
        }
        return (tokens, unknown)
    }

    public func contains(_ phonemes: String) -> Bool {
        phonemes.allSatisfy { symbolToID[String($0)] != nil }
    }

    /// §7.1 — "Token 0 at both ends."
    public static func framed(_ tokens: [Int32]) -> [Int32] {
        [0] + tokens + [0]
    }

    public enum Fallback {
        static let pad = "$"
        static let punctuation = #";:,.!?¡¿—…"«»“” "#
        static let letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz"
        /// The IPA inventory, in the order the upstream symbol list builds it.
        static let lettersIPA =
            "ɑɐɒæɓʙβɔɕçɗɖðʤəɘɚɛɜɝɞɟʄɡɠɢʛɦɧħɥʜɨɪʝɭɬɫɮʟɱɯɰŋɳɲɴøɵɸθœɶʘɹɺɾɻʀʁɽʂʃʈʧʉʊʋⱱʌɣɤʍχʎʏʑʐʒʔʡʕʢǀǁǂǃˈˌːˑʼʴʰʱʲʷˠˤ˞↓↑→↗↘ᵻ"

        nonisolated(unsafe) static let table: [String: Int32] = {
            var table: [String: Int32] = [:]
            var next: Int32 = 0
            for symbol in ([pad] + punctuation.map(String.init) + letters.map(String.init) + lettersIPA.map(String.init)) {
                if table[symbol] == nil {
                    table[symbol] = next
                }
                next += 1
            }
            return table
        }()
    }
}
