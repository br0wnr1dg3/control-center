import Foundation
import SwiftUI

enum TaskKind: String, Codable, CaseIterable {
    case human, agent, either

    var label: String {
        switch self {
        case .human: "Me"
        case .agent: "Agent"
        case .either: "Either"
        }
    }

    var symbol: String {
        switch self {
        case .human: "person.fill"
        case .agent: "sparkles"
        case .either: "circle.dashed"
        }
    }
}

enum TaskStatus: String, Codable, CaseIterable {
    case new, ready, in_progress, needs_you, done, cancelled

    var label: String {
        switch self {
        case .new: "New"
        case .ready: "Ready"
        case .in_progress: "In progress"
        case .needs_you: "Needs you"
        case .done: "Done"
        case .cancelled: "Cancelled"
        }
    }

    var color: Color {
        switch self {
        case .new: .gray
        case .ready: .blue
        case .in_progress: .purple
        case .needs_you: .orange
        case .done: .green
        case .cancelled: .gray
        }
    }

    var isOpen: Bool { self != .done && self != .cancelled }
}

/// Linear's scale: 0 none, 1 urgent, 2 high, 3 medium, 4 low.
enum Priority: Int, CaseIterable {
    case none = 0, urgent, high, medium, low

    var label: String {
        switch self {
        case .none: "No priority"
        case .urgent: "Urgent"
        case .high: "High"
        case .medium: "Medium"
        case .low: "Low"
        }
    }

    /// Sort key: urgent first, none last.
    var rank: Int { self == .none ? 5 : rawValue }
}

/// A question an agent is waiting on, with its choices (from ask_human, or Claude's picker in a session).
struct AgentQuestion: Codable, Equatable {
    struct Option: Codable, Equatable, Hashable {
        var label: String
        var description: String?
    }

    var question: String
    var header: String?
    var multiSelect: Bool
    var options: [Option]
}

struct TaskLink: Codable, Equatable, Hashable {
    var title: String
    var url: String
}

struct BoardTask: Codable, Identifiable, Equatable {
    let id: Int
    var title: String
    var description: String?
    var kind: TaskKind
    var status: TaskStatus
    var priority: Int
    var teamId: Int?
    var project: String?
    var labels: [String]
    var links: [TaskLink]
    var scheduledOn: String?  // YYYY-MM-DD: the day to do it
    var due: String?          // YYYY-MM-DD: deadline
    var today: Bool
    var sortOrder: Double
    var parentId: Int?
    var source: String?
    var question: String?
    var questionOptions: [AgentQuestion]?
    var sessionId: String?
    var worktree: String?  // agent's git worktree, until the runner removes it
    var repo: String?      // repo the agent session starts in; empty = runner decides
    var externalRef: ExternalRef?  // where it lives in the app that sent it (inbound events)
    var requestedBy: Requester?    // who asked for it in that app
    // Only fetchTasks embeds these. Each carries its own details: finished tasks may not be loaded.
    var blockers: [Dependency]?
    var blocks: [Dependency]?
    var waitingOn: [Int]?  // blockers still open, as the runner sees them (waiting_on in SQL)
    var awaitingReview: Bool?  // its latest published output is undecided (awaiting_review in SQL)
    var attachments: [FileAttachment]?  // screenshots and files added when the task was written
    var completedAt: String?
    var updatedAt: String?

    enum CodingKeys: String, CodingKey {
        case id, title, description, kind, status, priority, project, labels, links, due, today, source, question, worktree, repo, attachments, blockers, blocks
        case waitingOn = "waiting_on"
        case awaitingReview = "awaiting_review"
        case externalRef = "external_ref"
        case requestedBy = "requested_by"
        case teamId = "team_id"
        case scheduledOn = "scheduled_on"
        case sortOrder = "sort_order"
        case parentId = "parent_id"
        case sessionId = "session_id"
        case questionOptions = "question_options"
        case completedAt = "completed_at"
        case updatedAt = "updated_at"
    }

    struct ExternalRef: Codable, Equatable {
        let source: String
        let id: String
        var url: String?
    }

    struct Requester: Codable, Equatable {
        var name: String?
        var email: String?

        var label: String? {
            switch (name, email) {
            case let (name?, email?): "\(name) <\(email)>"
            case let (name?, nil): name
            case let (nil, email?): email
            case (nil, nil): nil
            }
        }
    }

    struct Dependency: Codable, Equatable {
        let task: LinkedTask
    }

    /// What a dependency needs to show, whichever side of it this task is on.
    struct LinkedTask: Codable, Equatable, Identifiable {
        let id: Int
        let title: String
        let status: TaskStatus
        let kind: TaskKind

        var key: String { "CC-\(id)" }
    }

    /// Approved or untriaged, but its blockers aren't finished yet. Once started, a blocker no longer holds it.
    var isWaiting: Bool { (status == .ready || status == .new) && !(waitingOn ?? []).isEmpty }
    var waitingLabel: String { "Waiting on " + (waitingOn ?? []).map { "CC-\($0)" }.joined(separator: ", ") }

    /// The agent has published and is waiting for the decision: started, but nobody is working on it.
    var isAwaitingReview: Bool { status == .in_progress && awaitingReview == true }
    /// Its session window closed mid-task (runner.mjs): parked in Needs you to resume, not a question for you.
    var isStopped: Bool { status == .needs_you && question?.hasPrefix("The session window closed") == true }

    var key: String { "CC-\(id)" }
    var priorityLevel: Priority { Priority(rawValue: priority) ?? .none }

    /// The calendar day this task sits on: when it's scheduled, else its deadline.
    var calendarDay: String? { scheduledOn ?? due }

    /// On the given day's list: scheduled/due that day, or (for today) anything flagged, overdue or carried over.
    func isOn(day: String) -> Bool {
        guard status.isOpen else { return false }
        let today = Day.today
        if day == today {
            // Approved work for the owner that can't be done yet isn't for today; the inbox says when it can.
            if status == .ready && kind != .agent && isWaiting { return false }
            if self.today { return true }
            if let s = scheduledOn, s <= today { return true }
            if let d = due, d <= today { return true }
            return false
        }
        return scheduledOn == day || (scheduledOn == nil && due == day)
    }

    var completedDay: String? {
        guard status == .done, let completedAt, let date = Day.parseTimestamp(completedAt) else { return nil }
        return Day.string(date)
    }

    var isOverdue: Bool {
        guard status.isOpen, let due else { return false }
        return due < Day.today
    }
}

/// Dates on the board are local "YYYY-MM-DD" strings, which sort correctly as text.
enum Day {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.calendar = Calendar(identifier: .gregorian)
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f
    }()

    static var today: String { string(Date()) }
    static func string(_ date: Date) -> String { formatter.string(from: date) }
    static func date(_ day: String) -> Date { formatter.date(from: day) ?? Date() }

    static func adding(_ days: Int, to day: String) -> String {
        string(Calendar.current.date(byAdding: .day, value: days, to: date(day))!)
    }

    /// Monday of the week containing `day`.
    static func weekStart(_ day: String) -> String {
        var cal = Calendar(identifier: .gregorian)
        cal.firstWeekday = 2
        let d = date(day)
        return string(cal.dateInterval(of: .weekOfYear, for: d)?.start ?? d)
    }

    static func title(_ day: String) -> String {
        if day == today { return "Today" }
        if day == adding(1, to: today) { return "Tomorrow" }
        if day == adding(-1, to: today) { return "Yesterday" }
        return date(day).formatted(.dateTime.weekday(.wide).month().day())
    }

    /// Compact form for rows: "Today", "Tomorrow", "Wed, Nov 4".
    static func shortTitle(_ day: String) -> String {
        if [today, adding(1, to: today), adding(-1, to: today)].contains(day) { return title(day) }
        return date(day).formatted(.dateTime.weekday(.abbreviated).month().day())
    }

    /// Postgres returns microsecond precision ("2026-10-29T23:13:02.307123+00:00"), which
    /// ISO8601DateFormatter rejects, so drop the fractional part first.
    static func parseTimestamp(_ value: String) -> Date? {
        let trimmed = value.replacingOccurrences(of: #"\.\d+"#, with: "", options: .regularExpression)
        return ISO8601DateFormatter().date(from: trimmed)
    }
}

struct TaskComment: Codable, Identifiable, Equatable {
    let id: Int
    let author: String
    let body: String
    let createdAt: String
    var reviewer: String?   // name on review-page notes and decisions
    var timecode: Double?   // seconds into the video a review note is about
    var stillUrl: String?   // the commented frame
    var quote: String?      // the passage a review note on a text output is about
    var attachments: [FileAttachment]?   // pasted screenshots and files, in the comment-attachments bucket

    enum CodingKeys: String, CodingKey {
        case id, author, body, timecode, attachments, quote
        case createdAt = "created_at"
        case reviewer = "author_name"
        case stillUrl = "still_url"
    }

    var authorName: String {
        switch author {
        case "me": "You"
        case "agent": "Agent"
        case "reviewer": reviewer ?? "Reviewer"
        case "external": reviewer ?? "External"
        default: "Claude"
        }
    }

    var timecodeLabel: String? {
        timecode.map { String(format: "%d:%04.1f", Int($0) / 60, $0.truncatingRemainder(dividingBy: 60)) }
    }
}

/// A stored file on a task or comment: `path` is its key in the comment-attachments bucket.
struct FileAttachment: Codable, Hashable {
    let path: String
    let name: String
    let type: String

    var json: [String: String] { ["path": path, "name": name, "type": type] }
    var isImage: Bool { type.hasPrefix("image/") }
}

/// A screenshot or file picked for a task or comment that hasn't been uploaded yet.
struct PendingFile: Identifiable {
    let id = UUID()
    let data: Data
    let type: String        // MIME type
    let ext: String
    let name: String
    let preview: NSImage    // the image itself, or the file's Finder icon
    var isImage: Bool { type.hasPrefix("image/") }
}

struct ActivityEvent: Codable, Identifiable, Equatable {
    let id: Int
    let kind: String
    let body: String
    let actor: String?
    let createdAt: String

    enum CodingKeys: String, CodingKey {
        case id, kind, body, actor
        case createdAt = "created_at"
    }
}

struct InboxItem: Codable, Identifiable, Equatable {
    struct TaskRef: Codable, Equatable {
        let id: Int
        let title: String
        let status: TaskStatus
    }

    let id: Int
    let kind: String   // question | comment | handoff | done | stalled
    let body: String
    /// Who wrote it, for comments (me | claude | agent | reviewer | external); nil otherwise.
    var author: String? = nil
    let readAt: String?
    let createdAt: String
    let task: TaskRef

    enum CodingKeys: String, CodingKey {
        case id, kind, body, task, author
        case readAt = "read_at"
        case createdAt = "created_at"
    }

    var isUnread: Bool { readAt == nil }

    /// Something for you to act on or read: not an agent finishing (anything left for you comes back as a
    /// hand-off), a session stopping, or the notes agents and Claude post as they work.
    var needsYou: Bool {
        kind != "done" && kind != "stalled" && !(kind == "comment" && (author == "agent" || author == "claude"))
    }

    var symbol: String {
        switch kind {
        case "question": "questionmark.bubble.fill"
        case "comment": "text.bubble.fill"
        case "handoff": "person.crop.circle.badge.plus"
        case "done": "checkmark.circle.fill"
        default: "exclamationmark.triangle.fill"
        }
    }

    var color: Color {
        switch kind {
        case "question", "stalled": .orange
        case "comment": .blue
        case "handoff": .purple
        default: .green
        }
    }

    var headline: String {
        switch kind {
        case "question": "Agent needs an answer"
        case "comment":
            body.hasPrefix("Changes requested") ? "Changes requested" : body.hasPrefix("Approved") ? "Approved" : "New comment"
        case "handoff": "Handed to you"
        case "done": "Agent finished"
        default: "Session stopped"
        }
    }
}

extension String {
    /// "3m", "2h", "Oct 29" style relative time for a Postgres timestamp.
    func relativeTime(now: Date = Date()) -> String {
        guard let date = Day.parseTimestamp(self) else { return "" }
        let seconds = now.timeIntervalSince(date)
        if seconds < 60 { return "now" }
        if seconds < 3600 { return "\(Int(seconds / 60))m" }
        if seconds < 86400 { return "\(Int(seconds / 3600))h" }
        return date.formatted(.dateTime.month(.abbreviated).day())
    }
}
