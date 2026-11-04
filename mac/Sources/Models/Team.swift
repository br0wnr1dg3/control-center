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
    var linearTeams: [String]?       // Linear team keys whose delegated issues come here
    var linearReviewState: String?   // status for an open PR; nil finds one with "review" in its name
    var linearDoneState: String?     // status for finished work; nil never marks it done
    var linearAssignee: String?      // email: also show this person's issues, read-only; nil is off

    enum CodingKeys: String, CodingKey {
        case id, key, name, kind, color, context, repos, workdir, github
        case baseBranch = "base_branch"
        case linearTeams = "linear_teams"
        case linearReviewState = "linear_review_state"
        case linearDoneState = "linear_done_state"
        case linearAssignee = "linear_assignee"
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
    var prReview: String?   // owner | agent: who takes agents' PRs to merged

    enum CodingKeys: String, CodingKey {
        case id, name, description, repos
        case teamId = "team_id"
        case prReview = "pr_review"
    }
}

/// A subscriber to a team's (or one project's) events. See README, "Outbound webhooks".
struct Webhook: Codable, Identifiable, Equatable {
    /// `optIn` events aren't on by default, because they're noisy.
    static let events: [(id: String, label: String, optIn: Bool)] = [
        ("task.created", "Task created", false),
        ("task.status", "Status changed", false),
        ("review.published", "Review published", false),
        ("review.decided", "Review decided", false),
        ("comment.added", "Comment added", true),
    ]

    let id: Int
    var teamId: Int
    var projectId: Int?
    var project: String?
    var url: String
    var events: [String]
    var scope: String      // external | all
    var active: Bool
    var pausedReason: String?
    var lastDeliveryAt: String?
    var lastDeliveryOk: Bool?
    var lastDeliveryHttp: Int?
    var lastDeliveryError: String?
    var pending: Int

    enum CodingKeys: String, CodingKey {
        case id, project, url, events, scope, active, pending
        case teamId = "team_id"
        case projectId = "project_id"
        case pausedReason = "paused_reason"
        case lastDeliveryAt = "last_delivery_at"
        case lastDeliveryOk = "last_delivery_ok"
        case lastDeliveryHttp = "last_delivery_http"
        case lastDeliveryError = "last_delivery_error"
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
    var hidden: Bool

    enum CodingKeys: String, CodingKey {
        case id, name, path, description, aliases, hidden
        case teamId = "team_id"
        case githubUrl = "github_url"
        case baseBranch = "base_branch"
    }
}
