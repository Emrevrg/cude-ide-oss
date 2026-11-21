//! cude-core: Cude IDE'nin Rust çekirdeği.
//! Protokol: stdin'den satır başına bir JSON istek {"id":1,"method":"...","params":{...}}, stdout'a satır başına JSON yanıt.
//! Yöntemler: index, find_files, grep, context, ping. Ayrıca `cude-core bench <kök>` ölçüm modu.
use ignore::WalkBuilder;
use regex::RegexBuilder;
use serde_json::{json, Value};
use std::io::{self, BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::Instant;

const MAX_FILE: u64 = 1_000_000;

fn is_secret(rel: &str) -> bool {
    let l = rel.to_ascii_lowercase();
    let name = l.rsplit('/').next().unwrap_or(&l);
    name.starts_with(".env") || name == ".npmrc" || name == ".pypirc"
        || [".pem", ".key", ".p12", ".pfx"].iter().any(|e| name.ends_with(e))
        || l.split('/').any(|s| s.starts_with("secret") || s.starts_with("credential"))
}

fn is_binary_ext(rel: &str) -> bool {
    let l = rel.to_ascii_lowercase();
    ["png", "jpg", "jpeg", "gif", "ico", "pdf", "zip", "exe", "dll", "vsix", "lock", "woff", "woff2", "ttf", "mp4", "bin", "node"]
        .iter().any(|e| l.ends_with(&format!(".{e}")))
}

static CACHE: std::sync::Mutex<Option<(PathBuf, Vec<(String, u64)>)>> = std::sync::Mutex::new(None);

/// Paralel gezinti; sonuç bellekte tutulur (sunucu modunda ikinci çağrı anında döner). `refresh` ile yenilenir.
fn walk(root: &Path) -> Vec<(String, u64)> {
    if let Some((r, v)) = CACHE.lock().unwrap().as_ref() { if r == root { return v.clone(); } }
    let out = std::sync::Mutex::new(Vec::with_capacity(32_768));
    WalkBuilder::new(root).hidden(false).git_ignore(true).threads(std::thread::available_parallelism().map(|n| n.get()).unwrap_or(4))
        .filter_entry(|e| {
            let n = e.file_name().to_string_lossy();
            !matches!(n.as_ref(), ".git" | "node_modules" | "dist" | "build" | "out" | "target" | ".next" | ".venv" | "coverage" | "vendor")
        })
        .build_parallel().run(|| {
            let out = &out;
            Box::new(move |res| {
                if let Ok(e) = res {
                    if e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                        let rel = e.path().strip_prefix(root).unwrap_or(e.path()).to_string_lossy().replace('\\', "/");
                        let size = e.metadata().map(|m| m.len()).unwrap_or(0);
                        out.lock().unwrap().push((rel, size));
                    }
                }
                ignore::WalkState::Continue
            })
        });
    let mut v = out.into_inner().unwrap();
    v.sort_unstable_by(|a, b| a.0.cmp(&b.0));
    *CACHE.lock().unwrap() = Some((root.to_path_buf(), v.clone()));
    v
}

/// Basit bulanık eşleşme puanı: sorgu harfleri sırayla geçmeli; ardışık ve dosya adı eşleşmeleri ödüllendirilir.
fn fuzzy(q: &str, s: &str) -> Option<i64> {
    let (q, s) = (q.to_ascii_lowercase(), s.to_ascii_lowercase());
    let name_start = s.rfind('/').map(|i| i + 1).unwrap_or(0);
    let (mut score, mut last, mut si) = (0i64, None::<usize>, 0usize);
    let sb = s.as_bytes();
    for qc in q.bytes() {
        let mut found = None;
        while si < sb.len() { if sb[si] == qc { found = Some(si); si += 1; break; } si += 1; }
        let i = found?;
        score += 10;
        if last.map(|l| l + 1 == i).unwrap_or(false) { score += 15; }
        if i >= name_start { score += 8; }
        last = Some(i);
    }
    Some(score - (s.len() as i64) / 8)
}

fn rank(rel: &str) -> u8 {
    let l = rel.to_ascii_lowercase();
    let top = ["readme", "package.json", "pyproject.toml", "cargo.toml", "go.mod", "pom.xml", "build.gradle", "composer.json", ".cude/origin.md"];
    if top.iter().any(|t| l.starts_with(t)) { 0 }
    else if ["src/", "app/", "lib/", "packages/", ".cude/"].iter().any(|p| l.starts_with(p)) { 1 } else { 2 }
}

fn handle(method: &str, p: &Value) -> Result<Value, String> {
    let root = PathBuf::from(p.get("root").and_then(Value::as_str).unwrap_or("."));
    match method {
        "ping" => Ok(json!({"ok": true, "version": env!("CARGO_PKG_VERSION")})),
        "refresh" => { *CACHE.lock().unwrap() = None; let f = walk(&root); Ok(json!({"files": f.len()})) }
        "index" => { let f = walk(&root); Ok(json!({"files": f.len(), "bytes": f.iter().map(|x| x.1).sum::<u64>()})) }
        "find_files" => {
            let q = p.get("query").and_then(Value::as_str).unwrap_or("");
            let limit = p.get("limit").and_then(Value::as_u64).unwrap_or(50) as usize;
            let mut hits: Vec<(i64, String)> = walk(&root).into_iter().filter_map(|(r, _)| fuzzy(q, &r).map(|s| (s, r))).collect();
            hits.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
            Ok(json!(hits.into_iter().take(limit).map(|h| h.1).collect::<Vec<_>>()))
        }
        "grep" => {
            let pat = p.get("pattern").and_then(Value::as_str).ok_or("pattern gerekli")?;
            let re = RegexBuilder::new(pat).case_insensitive(p.get("ignore_case").and_then(Value::as_bool).unwrap_or(true)).build().map_err(|e| e.to_string())?;
            let limit = p.get("limit").and_then(Value::as_u64).unwrap_or(200) as usize;
            let mut out = Vec::new();
            'f: for (rel, size) in walk(&root) {
                if size > MAX_FILE || is_binary_ext(&rel) || is_secret(&rel) { continue; }
                let Ok(text) = std::fs::read_to_string(root.join(&rel)) else { continue };
                for (n, line) in text.lines().enumerate() {
                    if re.is_match(line) { out.push(json!({"file": rel, "line": n + 1, "text": line.chars().take(240).collect::<String>()})); if out.len() >= limit { break 'f; } }
                }
            }
            Ok(json!(out))
        }
        "context" => {
            // TypeScript sürümüyle aynı kural: sırlar ve ikililer hariç, öncelik sıralı, dosya ve karakter bütçeli.
            let max_files = p.get("max_files").and_then(Value::as_u64).unwrap_or(24) as usize;
            let budget = p.get("max_chars").and_then(Value::as_u64).unwrap_or(36_000) as usize;
            let mut files: Vec<(String, u64)> = walk(&root).into_iter().filter(|(r, s)| *s <= 30_000 && !is_secret(r) && !is_binary_ext(r)).collect();
            files.sort_by(|a, b| rank(&a.0).cmp(&rank(&b.0)).then(a.0.cmp(&b.0)));
            let (mut parts, mut total) = (Vec::new(), 0usize);
            for (rel, _) in files {
                if parts.len() >= max_files || total >= budget { break; }
                let Ok(text) = std::fs::read_to_string(root.join(&rel)) else { continue };
                if text.contains('\0') { continue; }
                let chunk: String = text.chars().take(7000.min(budget - total)).collect();
                total += chunk.len();
                parts.push(json!({"file": rel, "text": chunk}));
            }
            Ok(json!({"files": parts, "chars": total}))
        }
        m => Err(format!("bilinmeyen yöntem: {m}")),
    }
}

fn bench(root: &str) {
    let p = json!({"root": root, "query": "main", "pattern": "TODO"});
    for m in ["index", "find_files", "grep", "context", "index"] {
        let t = Instant::now();
        let r = handle(m, &p);
        let ms = t.elapsed().as_secs_f64() * 1000.0;
        let size = match &r { Ok(Value::Array(a)) => a.len(), Ok(v) => v.get("files").map(|f| f.as_array().map(|a| a.len()).unwrap_or_else(|| f.as_u64().unwrap_or(0) as usize)).unwrap_or(0), Err(_) => 0 };
        println!("{m:<11} {ms:>9.1} ms  sonuç={size}");
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("bench") { bench(args.get(2).map(String::as_str).unwrap_or(".")); return; }
    let stdin = io::stdin(); let mut out = io::stdout().lock();
    for line in stdin.lock().lines().map_while(Result::ok) {
        if line.trim().is_empty() { continue; }
        let resp = match serde_json::from_str::<Value>(&line) {
            Ok(req) => {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                match handle(method, req.get("params").unwrap_or(&Value::Null)) { Ok(r) => json!({"id": id, "result": r}), Err(e) => json!({"id": id, "error": e}) }
            }
            Err(e) => json!({"id": null, "error": format!("geçersiz JSON: {e}")}),
        };
        let _ = writeln!(out, "{resp}"); let _ = out.flush();
    }
}
