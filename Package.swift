// swift-tools-version: 6.0
import PackageDescription

// PolyRead — personal iOS/iPadOS PDF reader with word-level TTS highlighting.
//
// The app shell lives in App/ as an Xcode target; everything with logic in it
// lives here so it is unit-testable without a simulator.
//
// MisakiSwift is deliberately NOT a hard dependency. The G2P adapter is behind
// `#if canImport(MisakiSwift)` so the package resolves and builds before the
// §0.3 gate question is answered. See Sources/PolyReadLinguistics/Phonemizer.swift.

let package = Package(
    name: "PolyRead",
    platforms: [.iOS(.v18)],
    products: [
        .library(name: "PolyReadCore", targets: ["PolyReadCore"]),
        .library(name: "PolyReadExtraction", targets: ["PolyReadExtraction"]),
        .library(name: "PolyReadLinguistics", targets: ["PolyReadLinguistics"]),
        .library(name: "PolyReadSynthesis", targets: ["PolyReadSynthesis"]),
        .library(name: "PolyReadPlayback", targets: ["PolyReadPlayback"]),
        .library(name: "PolyReadUI", targets: ["PolyReadUI"]),
        .library(name: "PolyReadBench", targets: ["PolyReadBench"]),
    ],
    targets: [
        // §3 — frozen interface types. The only module every agent shares.
        .target(name: "PolyReadCore"),

        // Agent A — §4
        .target(name: "PolyReadExtraction", dependencies: ["PolyReadCore"]),

        // Agent B — §5, §6
        .target(name: "PolyReadLinguistics", dependencies: ["PolyReadCore"]),

        // Agent C — §7
        .target(name: "PolyReadSynthesis", dependencies: ["PolyReadCore", "PolyReadLinguistics"]),

        // Agent D — §8, §9, §10
        .target(name: "PolyReadPlayback", dependencies: ["PolyReadCore"]),
        .target(
            name: "PolyReadUI",
            dependencies: [
                "PolyReadCore", "PolyReadExtraction", "PolyReadLinguistics",
                "PolyReadSynthesis", "PolyReadPlayback", "PolyReadBench",
            ]
        ),

        // §0 — the gate. Runs on device, answers all three questions.
        .target(name: "PolyReadBench", dependencies: ["PolyReadCore", "PolyReadLinguistics", "PolyReadSynthesis"]),

        .testTarget(name: "PolyReadCoreTests", dependencies: ["PolyReadCore"]),
        .testTarget(name: "PolyReadLinguisticsTests", dependencies: ["PolyReadLinguistics", "PolyReadCore"]),
        .testTarget(name: "PolyReadExtractionTests", dependencies: ["PolyReadExtraction", "PolyReadCore"]),
        .testTarget(name: "PolyReadSynthesisTests", dependencies: ["PolyReadSynthesis", "PolyReadCore"]),
    ]
)
