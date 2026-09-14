import Foundation

extension FallbackPhonemizer {

    /// §6.1 puts number expansion in misaki. This exists only so the fallback
    /// does not spell "1993" out letter by letter while the real phonemizer is
    /// still behind the §0.3 gate. §11's "no number-expansion layer beyond §5"
    /// is about the *normalization* stage, which this is not part of.
    enum NumberReader {
        static func phonemes(for token: String) -> String {
            let digits = token.filter(\.isNumber)
            guard !digits.isEmpty else { return FallbackPhonemizer.convertWord(token) }

            // A four-digit number in this corpus is a year far more often than a
            // quantity, and years are read in pairs: "nineteen ninety-three".
            if token.count == 4, digits.count == 4, let value = Int(digits),
               value >= 1100, value <= 2099 {
                return words(forYear: value).map(word(_:)).joined(separator: " ")
            }
            if let value = Int(digits), value < 1_000_000_000 {
                return words(for: value).map(word(_:)).joined(separator: " ")
            }
            return digits.compactMap { ones[Int(String($0)) ?? 0] }.map(word(_:)).joined(separator: " ")
        }

        static func word(_ text: String) -> String {
            FallbackPhonemizer.Lexicon.exceptions[text]
                ?? FallbackPhonemizer.Stress.assign(
                    FallbackPhonemizer.applyRules(Array(text)),
                    spelling: text
                )
        }

        static let ones = [
            "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
            "nine", "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen",
            "sixteen", "seventeen", "eighteen", "nineteen",
        ]
        static let tens = [
            "", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy",
            "eighty", "ninety",
        ]

        static func words(for value: Int) -> [String] {
            if value < 0 { return ["minus"] + words(for: -value) }
            if value < 20 { return [ones[value]] }
            if value < 100 {
                let unit = value % 10
                return unit == 0 ? [tens[value / 10]] : [tens[value / 10], ones[unit]]
            }
            if value < 1000 {
                let rest = value % 100
                let head = [ones[value / 100], "hundred"]
                return rest == 0 ? head : head + words(for: rest)
            }
            if value < 1_000_000 {
                let rest = value % 1000
                let head = words(for: value / 1000) + ["thousand"]
                return rest == 0 ? head : head + words(for: rest)
            }
            let rest = value % 1_000_000
            let head = words(for: value / 1_000_000) + ["million"]
            return rest == 0 ? head : head + words(for: rest)
        }

        static func words(forYear value: Int) -> [String] {
            let century = value / 100
            let rest = value % 100
            if rest == 0 { return words(for: century) + ["hundred"] }
            if century % 10 == 0 && rest < 10 {
                // 2005 → "two thousand five", not "twenty oh five".
                return words(for: value)
            }
            if rest < 10 { return words(for: century) + ["oh", ones[rest]] }
            return words(for: century) + words(for: rest)
        }
    }
}
