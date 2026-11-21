"""Compare both GGUF files with the pinned Hugging Face PyTorch reference."""

import argparse
import hashlib
import json
from pathlib import Path
import re
import secrets
import socket
import subprocess
import sys
import time
import unicodedata
import urllib.error
import urllib.request

import numpy as np


EXAMPLES = [
    "Find where expired sessions are revoked.",
    "Veritabanı bağlantısı hangi sırayla kapatılıyor?",
    "Où le client renouvelle-t-il le jeton d’accès ?",
    "Wo wird das Ergebnis der Dateisuche zwischengespeichert?",
    "¿Dónde se valida esta solicitud de la API?",
    "Почему тест зависает после закрытия процесса?",
    "ハッシュを検証してからファイルを保存する処理を探す。",
    "如何限制每个用户的请求频率？",
    "كيف يتعامل التطبيق مع الروابط الرمزية؟",
    "İndirme yarıda kesilirse geçici dosyalar temizleniyor mu?",
    "การจัดการข้อผิดพลาดระหว่างการเชื่อมต่อ",
    "O provedor devolve um erro quando o limite é atingido.",
    "Resolve an alias to the exact path selected by the user.",
    "Find the component that sends the selected tab to the extension.",
    "Use constant-time comparison for credentials of equal length.",
    "The server must never include provider response headers in an error.",
    "An unrelated window message should not stop an active request.",
    "Preserve CRLF and Unicode in the accepted edit.",
    "La cache viene invalidata quando cambia il sorgente.",
    "Test de seriële afhandeling van gelijktijdige updates.",
    "An empty configuration creates a usable default profile.",
    "Cancellation should stop the child process and release its port.",
    "A redirect from the download endpoint must retain HTTPS.",
    "Log only the request identifier and a coarse error code.",
    "Find the function that filters binary files before indexing.",
    "A SQLite transaction increments the daily and global counters.",
    "Run the tests after compiling the TypeScript extension.",
    "Where are dirty editor buffers kept out of staged changes?",
    "How are generated folders excluded from file discovery?",
    "Does the next request re-use the previously approved session?",
    "Check that each embedding is a finite unit vector.",
    "Split a long file without breaking UTF-8.",
    "The worker returns all rows sorted by their original index.",
    "A request body can arrive across several chunks.",
    "A second session should fail cleanly if the server port is busy.",
    "Locate the configuration for retry delays and output limits.",
    "Bir iş kuyruğu iptal edildiğinde bekleyen kayıtlar temizlenir.",
    "İzin oturumu değiştiğinde eski ortam kullanılmamalıdır.",
    "Предварительный просмотр показывает различия между версиями.",
    "El manifiesto incluye el tamaño y la suma SHA-256.",
    "const tok = await server.tokenize('passage: ' + source);",
    "function reserve(id, limit) { return counts[id] < limit; }",
    "if (!isInside(root, file)) throw new Error('unsafe path');",
    "export async function collect<T>(items: T[]): Promise<T[]> { return [...items]; }",
    "for key, tensor in sorted(weights.items()): writer.add_tensor(key, tensor)",
    "SELECT id, digest FROM clients WHERE expires > CURRENT_TIMESTAMP;",
    "async def open_pool(url: str) -> None: await connect(url)",
    "cargo test --locked && npm test",
    "Path.resolve('src', 'données', 'işçi.ts') 🔍",
    "class Epoch { #value = 0; bump() { return ++this.#value; } }",
    "make index: build && run # lexical fallback",
    "\tdef normalize(x):\n    return x / max(1e-12, norm(x))\n",
    "Tabs\tand spaces    are part of the code.\r\nThe line endings can differ.",
    "print('Data: 🧪 🔒 🌍'); 👩🏾‍💻 café Cafe\u0301",
    "Use … and «configuration» syntax in paths. 北京·İstanbul·São Paulo.",
    "An empty environment keeps PATH only if explicitly allowed.",
    "regex target: ^(?:\\.cude|\\.git)(?:/|$)",
    "std::vector<float> scores; std::sort(scores.begin(), scores.end());",
    "ユーザーの入力をそのまま設定ファイルに書き込まない。",
    "Consider constant-expression ternaries and nested function calls.",
    "find change arrow → with emoji 💼 and HTML entity &amp;.",
    "function workerTask() { return queue.next(); }\n" * 65,
    "Ein längeres Beispiel mit Zeilenumbrüchen für die Rückgabe eines Vektors.\n" * 40,
    "İş parçacığı kapandı, kilit bırakıldı ve yeni bağlantı kabul edildi.\n" * 45,
]


def request(origin, route, key, body=None):
    options = {"Authorization": "Bearer " + key, "Content-Type": "application/json"}
    data = None if body is None else json.dumps(body).encode()
    with urllib.request.urlopen(urllib.request.Request(origin + route, data, options), timeout=45) as response:
        return json.load(response)


def digest(file):
    with file.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def evaluate(executable, model, reference, expected, attention_flag):
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port = probe.getsockname()[1]
    key = secrets.token_hex(24)
    origin = f"http://127.0.0.1:{port}"
    args = [
        str(executable), "-m", str(model), "--host", "127.0.0.1", "--port", str(port),
        "--api-key", key, "--embedding", "--pooling", "mean", "--embd-normalize", "2",
        "--ctx-size", "1024", "--batch-size", "1024", "--ubatch-size", "1024",
        "--parallel", "1", "--n-gpu-layers", "0", "--threads", "3", "--no-webui",
    ]
    if attention_flag:
        args += ["--attention", "non-causal"]
    log = model.with_suffix(".llama.log")
    with log.open("wb") as stderr:
        child = subprocess.Popen(args, cwd=executable.parent, stdout=stderr, stderr=stderr)
        try:
            deadline = time.monotonic() + 90
            while True:
                if child.poll() is not None:
                    raise RuntimeError(f"llama-server exited. See {log}")
                try:
                    if request(origin, "/health", key)["status"] == "ok":
                        break
                except (urllib.error.URLError, TimeoutError):
                    pass
                if time.monotonic() > deadline:
                    raise TimeoutError(f"llama-server readiness deadline. See {log}")
                time.sleep(0.25)
            actual = []
            matches = 0
            for index, (prefix, text) in enumerate(expected):
                value = prefix + text
                ids = request(origin, "/tokenize", key, {"content": unicodedata.normalize("NFC", value), "add_special": False, "parse_special": True})["tokens"][:256]
                ref_ids = reference.tok.encode(value, add_special_tokens=False).ids[:256]
                if ids != ref_ids:
                    difference = next((i for i, (left, right) in enumerate(zip(ids, ref_ids)) if left != right), min(len(ids), len(ref_ids)))
                    raise AssertionError(f"Tokenizer differs at case {index}, token {difference}: {ids[difference:difference + 4]} vs {ref_ids[difference:difference + 4]}")
                matches += 1
                row = request(origin, "/v1/embeddings", key, {"input": ids, "encoding_format": "float"})["data"]
                actual.append(row[0]["embedding"])
            return np.asarray(actual, dtype=np.float64), matches
        finally:
            if child.poll() is None:
                child.terminate()
            child.wait(timeout=15)


def main():
    cli = argparse.ArgumentParser(description=__doc__)
    cli.add_argument("reference", type=Path)
    cli.add_argument("llama_server", type=Path)
    cli.add_argument("output", type=Path)
    cli.add_argument("models", nargs="+", type=Path)
    args = cli.parse_args()
    sys.path.insert(0, str(args.reference.resolve() / "code"))
    import torch
    from norovox_embed import Encoder, NorovoxEmbed
    from safetensors.torch import load_file
    from tokenizers import Tokenizer

    torch.set_num_threads(1)
    print("Loading the reference encoder with memory-mapped weights", flush=True)
    # The same published encoder and encode() code, initialized on meta to avoid an
    # extra 768 MiB copy of the float32 checkpoint on small Windows machines.
    reference = NorovoxEmbed.__new__(NorovoxEmbed)
    reference.cfg = json.loads((args.reference / "config.json").read_text(encoding="utf-8"))
    reference.device = "cpu"
    reference.pad = reference.cfg["pad_id"]
    reference.max_len = reference.cfg["max_len"]
    reference.tok = Tokenizer.from_file(str(args.reference / "tokenizer.json"))
    with torch.device("meta"):
        reference.enc = Encoder(reference.cfg["core"])
    reference.enc.load_state_dict(load_file(args.reference / "model.safetensors"), strict=True, assign=True)
    reference.enc.eval()
    kinds = (("query", "query: "), ("document", "passage: "))
    reference_vectors = []
    for kind, _ in kinds:
        print(f"Evaluating {len(EXAMPLES)} PyTorch {kind} inputs", flush=True)
        for first in range(0, len(EXAMPLES), 8):
            reference_vectors.append(reference.encode(EXAMPLES[first:first + 8], kind=kind, batch_size=4))
            print(f'  {kind}: {min(first + 8, len(EXAMPLES))}/{len(EXAMPLES)}', flush=True)
    ref = np.concatenate(reference_vectors).astype(np.float64)
    del reference.enc
    expected = [(prefix, text) for _, prefix in kinds for text in EXAMPLES]
    executable = args.llama_server.resolve()
    help_text = subprocess.run([str(executable), "--help"], capture_output=True, text=True, errors="replace", check=True).stdout
    attention_flag = bool(re.search(r"^\s*--attention\b", help_text, re.MULTILINE))
    results = {}
    for model in args.models:
        print(f'Evaluating {model.name} with bundled llama-server', flush=True)
        built, matches = evaluate(executable, model.resolve(), reference, expected, attention_flag)
        if built.shape != ref.shape or not np.isfinite(built).all():
            raise ValueError(f"Wrong or invalid dimensions for {model}: {built.shape}")
        norm = np.linalg.norm(built, axis=1)
        cosines = (ref * built).sum(axis=1) / (np.linalg.norm(ref, axis=1) * norm)
        entry = {
            "file": model.name, "size": model.stat().st_size, "sha256": digest(model),
            "cases": len(cosines), "tokenizer_matches": matches, "dimensions": built.shape[1],
            "mean_cosine": float(cosines.mean()), "min_cosine": float(cosines.min()),
            "mean_cosine_distance": float((1 - cosines).mean()), "max_unit_norm_error": float(abs(norm - 1).max()),
            "mean_query_cosine": float(cosines[:len(EXAMPLES)].mean()),
            "mean_passage_cosine": float(cosines[len(EXAMPLES):].mean()),
            "attention": "flag-and-gguf" if attention_flag else "gguf-metadata",
            "passes": bool(cosines.mean() >= 0.999 and matches == len(cosines) and abs(norm - 1).max() <= 1e-5)
        }
        results[model.name] = entry
        print(json.dumps(entry), flush=True)
    args.output.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    return 0 if all(entry["passes"] for entry in results.values()) else 1


if __name__ == "__main__":
    raise SystemExit(main())
