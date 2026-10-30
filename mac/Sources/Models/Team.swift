import SwiftUI

struct Repo: Codable, Equatable, Hashable {
    var name: String
    var url: String?
    var path: String?
}

/// A company, or Personal. Its context and repos are handed to agents working on its tasks.
struct Team: Codable, Identifiable, Equatable, Hashable {
    let id: Int
    var key: String
    var name: String
    var kind: String       // company | personal
    var color: String?     // hex
    var context: String?   // markdown briefing
    var repos: [Repo]
    var workdir: String?
    var github: String?
    var baseBranch: String?  // default branch agent work starts from; per-repo settings override it
    var sortOrder: Double

    enum CodingKeys: String, CodingKey {
        case id, key, name, kind, color, context, repos, workdir, github
        case baseBranch = "base_branch"
        case sortOrder = "sort_order"
    }

    var tint: Color { color.flatMap(Color.init(hex:)) ?? ProjectColor.of(name) }
    var symbol: String { kind == "personal" ? "person.fill" : "building.2.fill" }

    /// "Brownridge Labs" -> "brownridge-labs"
    static func slug(_ name: String) -> String {
        name.lowercased()
            .replacingOccurrences(of: #"[^a-z0-9]+"#, with: "-", options: .regularExpression)
            .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
    }
}

struct ProjectSpec: Codable, Identifiable, Equatable {
    let id: Int
    var name: String
    var teamId: Int?
    var description: String?
    var repos: [Repo]

    enum CodingKeys: String, CodingKey {
        case id, name, description, repos
        case teamId = "team_id"
    }
}

extension Color {
    init?(hex: String) {
        let digits = hex.trimmingCharacters(in: CharacterSet(charactersIn: "#"))
        guard digits.count == 6, let value = Int(digits, radix: 16) else { return nil }
        self.init(red: Double((value >> 16) & 0xFF) / 255, green: Double((value >> 8) & 0xFF) / 255,
                  blue: Double(value & 0xFF) / 255)
    }
}

/// A repo the runner found under a team's working folder (see runner syncRepos).
struct LocalRepo: Codable, Identifiable, Equatable {
    let id: Int
    var teamId: Int
    var name: String
    var path: String
    var githubUrl: String?
    var description: String?
    var aliases: [String]
    var baseBranch: String?

    enum CodingKeys: String, CodingKey {
        case id, name, path, description, aliases
        case teamId = "team_id"
        case githubUrl = "github_url"
        case baseBranch = "base_branch"
    }
}
