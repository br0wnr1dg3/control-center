import Foundation

/// Thin PostgREST client for the Control Center Supabase project.
/// The service key comes from the login Keychain via /usr/bin/security, which is already on the
/// item's access list, so ad-hoc-signed rebuilds of this app never trigger Keychain prompts.
struct BoardAPI {
    /// CC_SUPABASE_URL / CC_SERVICE_KEY override the defaults (e.g. to run against a local Supabase).
    static let baseURL = URL(string: (ProcessInfo.processInfo.environment["CC_SUPABASE_URL"]
        ?? "https://lkjjphjscavzibalgqhh.supabase.co") + "/rest/v1/")!

    enum APIError: LocalizedError {
        case missingKey
        case http(Int, String)

        var errorDescription: String? {
            switch self {
            case .missingKey: "Service key not found in Keychain (\"control-center service key\")."
            case let .http(code, body): "HTTP \(code): \(body)"
            }
        }
    }

    private let key: String

    init() throws {
        if let key = ProcessInfo.processInfo.environment["CC_SERVICE_KEY"] {
            self.key = key
            return
        }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/security")
        process.arguments = ["find-generic-password", "-a", "control-center", "-s", "control-center service key", "-w"]
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = Pipe()
        try process.run()
        process.waitUntilExit()
        let key = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard process.terminationStatus == 0, !key.isEmpty else { throw APIError.missingKey }
        self.key = key
    }

    private func request(_ path: String, method: String = "GET", body: Any? = nil) async throws -> Data {
        var req = URLRequest(url: URL(string: path, relativeTo: Self.baseURL)!)
        req.httpMethod = method
        req.setValue(key, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("return=representation", forHTTPHeaderField: "Prefer")
        if let body { req.httpBody = try JSONSerialization.data(withJSONObject: body) }
        let (data, response) = try await URLSession.shared.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw APIError.http(code, String(decoding: data, as: UTF8.self)) }
        return data
    }

    private func get<T: Decodable>(_ path: String) async throws -> T {
        try JSONDecoder().decode(T.self, from: await request(path))
    }

    /// Open tasks plus anything finished in the last two weeks (done history for day views).
    func fetchTasks() async throws -> [BoardTask] {
        let since = ISO8601DateFormatter().string(from: Date().addingTimeInterval(-14 * 86400))
        return try await get("tasks?select=*,waiting_on,awaiting_review,blockers:task_dependencies!task_id(task:tasks!blocked_by_id(id,title,status,kind)),blocks:task_dependencies!blocked_by_id(task:tasks!task_id(id,title,status,kind))&or=(status.not.in.(done,cancelled),completed_at.gt.\(since))&order=sort_order,id")
    }

    func fetchTeams() async throws -> [Team] {
        try await get("teams?select=*&order=sort_order,id")
    }

    func fetchRepos() async throws -> [LocalRepo] {
        try await get("repos?select=id,team_id,name,path,github_url,description,aliases,base_branch,hidden&order=hidden,name")
    }

    func updateRepo(_ id: Int, _ fields: [String: Any]) async throws {
        _ = try await request("repos?id=eq.\(id)", method: "PATCH", body: fields)
    }

    func fetchProjects() async throws -> [ProjectSpec] {
        try await get("projects?select=id,name,team_id,description,repos,pr_review&order=name")
    }

    @discardableResult
    func addTeam(_ fields: [String: Any]) async throws -> Team {
        let data = try await request("teams", method: "POST", body: fields)
        return try JSONDecoder().decode([Team].self, from: data)[0]
    }

    func updateTeam(_ id: Int, _ fields: [String: Any]) async throws {
        _ = try await request("teams?id=eq.\(id)", method: "PATCH", body: fields)
    }

    func addProject(_ fields: [String: Any]) async throws {
        _ = try await request("projects", method: "POST", body: fields)
    }

    func updateProject(_ id: Int, _ fields: [String: Any]) async throws {
        _ = try await request("projects?id=eq.\(id)", method: "PATCH", body: fields)
    }

    // ---------- Webhooks ----------

    func fetchWebhooks(team: Int) async throws -> [Webhook] {
        try await get("webhook_overview?team_id=eq.\(team)&select=*&order=id")
    }

    /// Returns the signing secret, which can't be read again after this.
    func createWebhook(team: Int, url: String, project: Int?, events: [String], scope: String) async throws -> String {
        let data = try await request("rpc/create_webhook", method: "POST", body: [
            "p_team": team, "p_url": url, "p_project": project ?? NSNull(), "p_events": events, "p_scope": scope,
        ] as [String: Any])
        struct Created: Decodable { let secret: String }
        return try JSONDecoder().decode(Created.self, from: data).secret
    }

    func setWebhookActive(_ id: Int, _ active: Bool) async throws {
        _ = try await request("rpc/set_webhook_active", method: "POST", body: ["p_webhook": id, "p_active": active] as [String: Any])
    }

    func testWebhook(_ id: Int) async throws {
        _ = try await request("rpc/test_webhook", method: "POST", body: ["p_webhook": id])
    }

    func deleteWebhook(_ id: Int) async throws {
        _ = try await request("webhooks?id=eq.\(id)", method: "DELETE")
    }

    func fetchInbox() async throws -> [InboxItem] {
        try await get("notifications?select=id,kind,body,author,read_at,created_at,task:tasks(id,title,status)&order=created_at.desc&limit=100")
    }

    func fetchComments(_ taskId: Int) async throws -> [TaskComment] {
        try await get("task_comments?task_id=eq.\(taskId)&select=id,author,author_name,body,timecode,still_url,quote,attachments,created_at&order=created_at")
    }

    func fetchActivity(_ taskId: Int) async throws -> [ActivityEvent] {
        try await get("task_events?task_id=eq.\(taskId)&select=id,kind,body,actor,created_at&order=created_at")
    }

    @discardableResult
    func addTask(_ fields: [String: Any]) async throws -> BoardTask {
        let data = try await request("tasks", method: "POST", body: fields)
        return try JSONDecoder().decode([BoardTask].self, from: data)[0]
    }

    func update(_ id: Int, _ fields: [String: Any], onlyIfStatus: TaskStatus? = nil) async throws {
        var path = "tasks?id=eq.\(id)"
        if let onlyIfStatus { path += "&status=eq.\(onlyIfStatus.rawValue)" }
        _ = try await request(path, method: "PATCH", body: fields)
    }

    func addComment(_ taskId: Int, body: String, author: String = "me", attachments: [FileAttachment] = []) async throws {
        var fields: [String: Any] = ["task_id": taskId, "author": author, "body": body]
        if !attachments.isEmpty { fields["attachments"] = attachments.map(\.json) }
        _ = try await request("task_comments", method: "POST", body: fields)
    }

    // ---------- Task and comment files (private Storage bucket) ----------

    private static let storageURL = URL(string: "../../storage/v1/object/comment-attachments/", relativeTo: baseURL)!.absoluteURL

    private func storage(_ path: String, method: String = "GET", body: Data? = nil, type: String? = nil) async throws -> Data {
        var req = URLRequest(url: Self.storageURL.appendingPathComponent(path))
        req.httpMethod = method
        req.setValue(key, forHTTPHeaderField: "apikey")
        req.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization")
        if let type { req.setValue(type, forHTTPHeaderField: "Content-Type") }
        req.httpBody = body
        let (data, response) = try await URLSession.shared.data(for: req)
        let code = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(code) else { throw APIError.http(code, String(decoding: data, as: UTF8.self)) }
        return data
    }

    /// `folder` is the task id, or "new" for files on a task that doesn't exist yet.
    func uploadFile(_ file: PendingFile, folder: String) async throws -> FileAttachment {
        let path = "\(folder)/\(UUID().uuidString.lowercased())\(file.ext.isEmpty ? "" : ".\(file.ext)")"
        _ = try await storage(path, method: "POST", body: file.data, type: file.type)
        return FileAttachment(path: path, name: file.name, type: file.type)
    }

    func downloadFile(_ path: String) async throws -> Data {
        try await storage(path)
    }

    func addEvent(_ taskId: Int, kind: String, body: String) async throws {
        _ = try await request("task_events", method: "POST",
                              body: ["task_id": taskId, "kind": kind, "body": body, "actor": "me"])
    }

    func markUnread(ids: [Int]) async throws {
        guard !ids.isEmpty else { return }
        let list = ids.map(String.init).joined(separator: ",")
        _ = try await request("notifications?id=in.(\(list))", method: "PATCH", body: ["read_at": NSNull()])
    }

    func markRead(ids: [Int]) async throws {
        guard !ids.isEmpty else { return }
        let list = ids.map(String.init).joined(separator: ",")
        _ = try await request("notifications?id=in.(\(list))", method: "PATCH",
                              body: ["read_at": ISO8601DateFormatter().string(from: Date())])
    }
}
