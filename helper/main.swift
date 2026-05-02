// notes-bridge: long-lived ScriptingBridge helper for the Notes backend.
//
// Reads JSON-RPC requests from stdin (one per line), executes them against
// Notes.app via ScriptingBridge, writes JSON responses to stdout (one per
// line). Stays alive until stdin closes, so each call avoids the
// process-spawn cost that osascript pays.
//
// Build: swiftc -O helper/main.swift -framework ScriptingBridge -o helper/notes-bridge
import Foundation
import ScriptingBridge

// MARK: - App handle

guard let app = SBApplication(bundleIdentifier: "com.apple.Notes") else {
    FileHandle.standardError.write(Data("notes-bridge: failed to connect to Notes.app\n".utf8))
    exit(1)
}

// MARK: - JSON helpers

func toJSONString(_ obj: Any) -> String {
    let data = try! JSONSerialization.data(
        withJSONObject: obj,
        options: [.fragmentsAllowed]
    )
    return String(data: data, encoding: .utf8)!
}

func parseJSON(_ s: String) -> [String: Any]? {
    guard let data = s.data(using: .utf8) else { return nil }
    return (try? JSONSerialization.jsonObject(with: data, options: [])) as? [String: Any]
}

// MARK: - SB helpers

// Bulk-fetch a property across all elements in a single Apple Event.
func bulkGet(_ array: SBElementArray, _ key: String) -> [Any] {
    return array.array(byApplying: NSSelectorFromString(key))
}

func elements(_ obj: Any?, _ key: String) -> SBElementArray? {
    return (obj as? NSObject)?.value(forKey: key) as? SBElementArray
}

func get<T>(_ obj: SBObject, _ key: String) -> T? {
    return obj.value(forKey: key) as? T
}

// MARK: - Methods

func listFolders() -> Any {
    var out: [[String: Any]] = []
    guard let accountsArr = (app as AnyObject).value(forKey: "accounts") as? SBElementArray else {
        return out
    }
    let accounts = accountsArr.get() as? [SBObject] ?? []
    for acc in accounts {
        let accountName: String = get(acc, "name") ?? ""
        let accountId: String = get(acc, "id") ?? ""
        guard let foldersArr = elements(acc, "folders") else { continue }

        // Bulk reads — one Apple Event per property, regardless of folder
        // count. Was 4×N events (id/name/container/notes per folder) and
        // dominated by the per-folder container() round trip; on a 43-folder
        // library this took ~5800 ms. Bulk reads land closer to ~150 ms.
        let folderIds = bulkGet(foldersArr, "id") as? [String] ?? []
        let folderNames = bulkGet(foldersArr, "name") as? [String] ?? []
        // SBElementArray inherits NSArray, so KVC chained key paths work
        // and the Notes engine resolves them in one shot.
        let containerIds =
            (foldersArr.value(forKeyPath: "container.id") as? [Any]) ?? []
        // `notes.id` returns an array-of-arrays — count each inner array.
        let noteIdArrays =
            (foldersArr.value(forKeyPath: "notes.id") as? [[Any]]) ?? []

        struct Node {
            var name: String
            var parentId: String
            var depth: Int = 0
            var path: String = ""
            var computed: Bool = false
        }
        var nodes: [String: Node] = [:]
        var orderedIds: [String] = []
        for j in 0..<folderIds.count {
            let fid = folderIds[j]
            let fname = j < folderNames.count ? folderNames[j] : ""
            let pid = (j < containerIds.count
                       ? containerIds[j] as? String
                       : nil) ?? accountId
            nodes[fid] = Node(name: fname, parentId: pid)
            orderedIds.append(fid)
        }

        func compute(_ id: String) {
            guard var n = nodes[id], !n.computed else { return }
            let pid = n.parentId
            if pid == accountId || nodes[pid] == nil {
                n.depth = 0
                n.path = "\(accountName) / \(n.name)"
            } else {
                compute(pid)
                let p = nodes[pid]!
                n.depth = p.depth + 1
                n.path = "\(p.path) / \(n.name)"
            }
            n.computed = true
            nodes[id] = n
        }
        for id in orderedIds { compute(id) }

        for j in 0..<orderedIds.count {
            let id = orderedIds[j]
            let n = nodes[id]!
            let noteCount = j < noteIdArrays.count ? noteIdArrays[j].count : 0
            out.append([
                "id": id,
                "name": n.name,
                "account": accountName,
                "path": n.path,
                "depth": n.depth,
                "noteCount": noteCount,
            ])
        }
    }
    out.sort {
        let a = ($0["path"] as? String ?? "").lowercased()
        let b = ($1["path"] as? String ?? "").lowercased()
        return a < b
    }
    return out
}

let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

func listNotes() -> Any {
    let t0 = Date()
    var out: [[String: Any]] = []
    guard let accountsArr = (app as AnyObject).value(forKey: "accounts") as? SBElementArray else {
        return out
    }
    let accounts = accountsArr.get() as? [SBObject] ?? []
    let tEnumAccounts = Date()

    var tBulkFolders = 0.0
    var tBulkNotes = 0.0
    var tBuild = 0.0
    var folderCount = 0
    var noteEventCount = 0

    for acc in accounts {
        let accountName: String = get(acc, "name") ?? ""
        guard let foldersArr = elements(acc, "folders") else { continue }

        // Bulk-fetch folder ids/names once per account (was once per folder).
        let bf0 = Date()
        let folderIds = bulkGet(foldersArr, "id") as? [String] ?? []
        let folderNames = bulkGet(foldersArr, "name") as? [String] ?? []
        let folders = foldersArr.get() as? [SBObject] ?? []
        tBulkFolders += Date().timeIntervalSince(bf0)
        folderCount += folders.count

        for j in 0..<folders.count {
            let folder = folders[j]
            let folderId = j < folderIds.count ? folderIds[j] : ""
            let folderName = j < folderNames.count ? folderNames[j] : ""
            let folderPath = "\(accountName) / \(folderName)"
            guard let notesArr = elements(folder, "notes") else { continue }

            let bn0 = Date()
            let ids = bulkGet(notesArr, "id") as? [String] ?? []
            let names = bulkGet(notesArr, "name") as? [String] ?? []
            let dates = bulkGet(notesArr, "modificationDate") as? [Date] ?? []
            tBulkNotes += Date().timeIntervalSince(bn0)
            noteEventCount += 3

            let bb0 = Date()
            let count = min(ids.count, names.count)
            for k in 0..<count {
                let dateAny: Any =
                    k < dates.count ? isoFormatter.string(from: dates[k]) : NSNull()
                out.append([
                    "id": ids[k],
                    "title": names[k],
                    "folderId": folderId,
                    "folderPath": folderPath,
                    "account": accountName,
                    "modifiedAt": dateAny,
                ])
            }
            tBuild += Date().timeIntervalSince(bb0)
        }
    }
    let tDone = Date()
    let total = Int(tDone.timeIntervalSince(t0) * 1000)
    let enumMs = Int(tEnumAccounts.timeIntervalSince(t0) * 1000)
    let log = """
        listNotes: total=\(total)ms accounts(enumerate)=\(enumMs)ms \
        folders=\(folderCount) folder-bulk=\(Int(tBulkFolders * 1000))ms \
        note-bulk(\(noteEventCount)events)=\(Int(tBulkNotes * 1000))ms \
        build=\(Int(tBuild * 1000))ms count=\(out.count)
        """
    FileHandle.standardError.write(Data((log + "\n").utf8))
    return out
}

func getFolderNotes(folderIds: [String]) -> Any {
    var out: [[String: Any]] = []
    guard let foldersArr = (app as AnyObject).value(forKey: "folders") as? SBElementArray else {
        return out
    }
    for fid in folderIds {
        guard let folder = foldersArr.object(withID: fid) as? SBObject,
              let notesArr = elements(folder, "notes")
        else { continue }
        let ids = bulkGet(notesArr, "id") as? [String] ?? []
        let names = bulkGet(notesArr, "name") as? [String] ?? []
        let dates = bulkGet(notesArr, "modificationDate") as? [Date] ?? []
        let count = min(ids.count, names.count)
        for k in 0..<count {
            let dateAny: Any =
                k < dates.count ? isoFormatter.string(from: dates[k]) : NSNull()
            out.append([
                "id": ids[k],
                "title": names[k],
                "folderId": fid,
                "modifiedAt": dateAny,
            ])
        }
    }
    return out
}

func getFolderSnippets(folderId: String) -> Any {
    guard let foldersArr = (app as AnyObject).value(forKey: "folders") as? SBElementArray,
          let folder = foldersArr.object(withID: folderId) as? SBObject,
          let notesArr = elements(folder, "notes") else {
        return [String: String]()
    }
    let ids = bulkGet(notesArr, "id") as? [String] ?? []
    let plaintexts = bulkGet(notesArr, "plaintext") as? [String] ?? []
    var out: [String: String] = [:]
    let count = min(ids.count, plaintexts.count)
    for k in 0..<count {
        let lines = plaintexts[k].split(separator: "\n", omittingEmptySubsequences: false)
        var snippet = ""
        if lines.count > 1 {
            for i in 1..<lines.count {
                let trimmed = lines[i]
                    .replacingOccurrences(of: "\\s+", with: " ", options: .regularExpression)
                    .trimmingCharacters(in: .whitespaces)
                if !trimmed.isEmpty {
                    snippet = trimmed
                    break
                }
            }
        }
        if snippet.count > 120 {
            snippet = String(snippet.prefix(120))
        }
        out[ids[k]] = snippet
    }
    return out
}

func getNoteBody(noteId: String) -> Any {
    guard let notesArr = (app as AnyObject).value(forKey: "notes") as? SBElementArray,
          let note = notesArr.object(withID: noteId) as? SBObject else {
        return ""
    }
    return (note.value(forKey: "plaintext") as? String) ?? ""
}

func getNoteHtml(noteId: String) -> Any {
    guard let notesArr = (app as AnyObject).value(forKey: "notes") as? SBElementArray,
          let note = notesArr.object(withID: noteId) as? SBObject else {
        return ""
    }
    return (note.value(forKey: "body") as? String) ?? ""
}

func moveNotes(moves: [[String: String]]) -> Any {
    var results: [[String: Any]] = []
    guard let notesArr = (app as AnyObject).value(forKey: "notes") as? SBElementArray,
          let foldersArr = (app as AnyObject).value(forKey: "folders") as? SBElementArray else {
        return results
    }
    for m in moves {
        guard let noteId = m["noteId"], let folderId = m["folderId"] else { continue }
        if let note = notesArr.object(withID: noteId) as? SBObject,
           let folder = foldersArr.object(withID: folderId) as? SBObject {
            // ScriptingBridge bridges `move <note> to <folder>` to -moveTo: on the source.
            let sel = NSSelectorFromString("moveTo:")
            if note.responds(to: sel) {
                _ = note.perform(sel, with: folder)
                results.append(["noteId": noteId, "ok": true])
            } else {
                results.append([
                    "noteId": noteId, "ok": false,
                    "error": "moveTo: selector unavailable on note",
                ])
            }
        } else {
            results.append([
                "noteId": noteId, "ok": false, "error": "note or folder not found",
            ])
        }
    }
    return results
}

// MARK: - JSON-RPC loop

while let line = readLine() {
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    if trimmed.isEmpty { continue }
    guard let req = parseJSON(trimmed),
          let id = req["id"],
          let method = req["method"] as? String else {
        print(toJSONString(["error": "invalid request"]))
        fflush(stdout)
        continue
    }
    let params = req["params"] as? [String: Any] ?? [:]

    let result: Any
    switch method {
    case "listFolders":
        result = listFolders()
    case "listNotes":
        result = listNotes()
    case "getFolderNotes":
        let folderIds = params["folderIds"] as? [String] ?? []
        result = getFolderNotes(folderIds: folderIds)
    case "getFolderSnippets":
        result = getFolderSnippets(folderId: params["folderId"] as? String ?? "")
    case "getNoteBody":
        result = getNoteBody(noteId: params["noteId"] as? String ?? "")
    case "getNoteHtml":
        result = getNoteHtml(noteId: params["noteId"] as? String ?? "")
    case "moveNotes":
        let raw = params["moves"] as? [[String: Any]] ?? []
        let moves: [[String: String]] = raw.compactMap { m in
            guard let n = m["noteId"] as? String, let f = m["folderId"] as? String
            else { return nil }
            return ["noteId": n, "folderId": f]
        }
        result = moveNotes(moves: moves)
    default:
        print(toJSONString(["id": id, "error": "unknown method: \(method)"]))
        fflush(stdout)
        continue
    }

    print(toJSONString(["id": id, "result": result]))
    fflush(stdout)
    // print() in Swift CLI flushes on newline by default; no explicit flush needed.
}
