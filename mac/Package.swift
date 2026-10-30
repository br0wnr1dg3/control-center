// swift-tools-version: 5.10
import PackageDescription

let package = Package(
    name: "ControlCenterBoard",
    platforms: [.macOS(.v14)],
    targets: [
        .executableTarget(
            name: "ControlCenterBoard",
            path: "Sources",
            exclude: ["Info.plist"]
        )
    ]
)
