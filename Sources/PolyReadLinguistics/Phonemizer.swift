import Foundation
import NaturalLanguage
import PolyReadCore

/// One spoken token and the phonemes it maps to.
///
/// §6.1 — "G2P **must** return per-word phoneme grouping. That grouping *is*
/// `wordPhonemeRanges`, and it is the only thing making word-level highlighting
/// possible." So this type, not a flat string, is the phonemizer's output.
public struct PhonemizedWord: Sendable, Equatable {
    public let token: String
    public let phonemes: String

    public init(token: String, phonemes: String) {
        self.token = token
        self.phonemes = phonemes
    }
}

public struct PhonemizerCapabilities: Sendable, Equatable {
    /// §0.3, the gate question. False means word-level highlighting is impossible
    /// with this backend and the import must refuse rather than mislead.
    public let providesWordGrouping: Bool
    /// §6.1 — if the backend does not do POS-based homograph resolution,
    /// `HomographResolver` wires `NLTagger` in front of it.
    public let resolvesHomographs: Bool
    public let expandsNumbers: Bool

    public init(providesWordGrouping: Bool, resolvesHomographs: Bool, expandsNumbers: Bool) {
        self.providesWordGrouping = providesWordGrouping
        self.resolvesHomographs = resolvesHomographs
        self.expandsNumbers = expandsNumbers
    }
}

public protocol Phonemizer: Sendable {
    var name: String { get }
    var capabilities: PhonemizerCapabilities { get }
    /// `posTags` is index-aligned with `tokens`, empty when tagging was skipped.
    func phonemize(tokens: [String], posTags: [POSTag]) throws -> [PhonemizedWord]
}

public enum POSTag: String, Sendable {
    case noun, verb, adjective, adverb, other
}

/// §6.1 — "If `MisakiSwift` lacks POS tagging, wire `NLTagger`
/// (`.lexicalClass`) as the tagger."
public struct POSTagger: Sendable {
    public init() {}

    public func tag(tokens: [String]) -> [POSTag] {
        guard !tokens.isEmpty else { return [] }
        let text = tokens.joined(separator: " ")
        let tagger = NLTagger(tagSchemes: [.lexicalClass])
        tagger.string = text

        // Walk the tagger's ranges in step with our own tokens. Our tokenization
        // is authoritative — it is what the span invariant is defined over — so
        // where NLTagger disagrees about boundaries we take its tag for whichever
        // of our tokens the range starts inside.
        var tags = [POSTag](repeating: .other, count: tokens.count)
        var tokenStarts: [Int] = []
        var offset = 0
        for token in tokens {
            tokenStarts.append(offset)
            offset += token.utf16.count + 1
        }

        tagger.enumerateTags(
            in: text.startIndex..<text.endIndex,
            unit: .word,
            scheme: .lexicalClass,
            options: [.omitWhitespace, .omitPunctuation]
        ) { tag, range in
            guard let tag else { return true }
            let start = text.utf16.distance(from: text.startIndex, to: range.lowerBound)
            // Last token whose start is <= this range's start.
            var lo = 0
            var hi = tokenStarts.count - 1
            while lo < hi {
                let mid = (lo + hi + 1) / 2
                if tokenStarts[mid] <= start { lo = mid } else { hi = mid - 1 }
            }
            tags[lo] = Self.map(tag)
            return true
        }
        return tags
    }

    static func map(_ tag: NLTag) -> POSTag {
        switch tag {
        case .noun, .pronoun, .personalName, .placeName, .organizationName: return .noun
        case .verb: return .verb
        case .adjective: return .adjective
        case .adverb: return .adverb
        default: return .other
        }
    }
}

// MARK: - MisakiSwift adapter

/// §6.1 — the intended backend. `MisakiSwift` is deliberately not a hard package
/// dependency: §0.3 has to be answered before anyone can know whether this
/// adapter is a patch or a rewrite, and the rest of the app should build either
/// way.
///
/// ## When MisakiSwift is added
///
/// Add it to `Package.swift` as a dependency of `PolyReadLinguistics`. The
/// `#if canImport` block below then compiles, and **the two marked lines are the
/// only ones that need to match its real API.** Everything else in the app is
/// written against `PhonemizedWord`.
///
/// If its output turns out to be a flat phoneme string with no per-word
/// grouping, do not paper over it here — §0.3 says "stop and raise it — that's a
/// module, not a patch."
public struct MisakiPhonemizer: Phonemizer {
    public let name = "MisakiSwift"
    public let capabilities: PhonemizerCapabilities

    public init(resolvesHomographs: Bool = false, expandsNumbers: Bool = true) {
        self.capabilities = PhonemizerCapabilities(
            providesWordGrouping: true,
            resolvesHomographs: resolvesHomographs,
            expandsNumbers: expandsNumbers
        )
    }

    /// True when the adapter below is actually compiled in.
    public static var isAvailable: Bool {
        #if canImport(MisakiSwift)
        return true
        #else
        return false
        #endif
    }

    public func phonemize(tokens: [String], posTags: [POSTag]) throws -> [PhonemizedWord] {
        #if canImport(MisakiSwift)
        // ─── INTEGRATION POINT (1 of 2) ──────────────────────────────────────
        // Replace the body of this block with the real MisakiSwift call. It must
        // return one entry per element of `tokens`, in order. If it cannot, that
        // is the §0.3 failure and it must throw `.phonemizerLacksWordGrouping`
        // rather than guess at an alignment.
        throw PolyReadError.phonemizerUnavailable(
            "MisakiSwift is linked but the adapter in MisakiPhonemizer.phonemize is not wired up yet."
        )
        // ─────────────────────────────────────────────────────────────────────
        #else
        throw PolyReadError.phonemizerUnavailable("MisakiSwift is not linked into this build.")
        #endif
    }
}

/// Picks the best phonemizer available and says so out loud.
public enum PhonemizerFactory {
    public static func make() -> any Phonemizer {
        if MisakiPhonemizer.isAvailable {
            return MisakiPhonemizer()
        }
        return FallbackPhonemizer()
    }
}
