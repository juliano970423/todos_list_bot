// pop3.js - POP3 郵件客戶端 (cloudflare:sockets) + MIME 解碼 + AI 去識別化
// 伺服器連線參數 (host/port/tls/帳密) 全部由呼叫端傳入或 settings 决定，不綁定任何特定郵件服務
import { connect } from "cloudflare:sockets";

const dec = new TextDecoder("utf-8");
const TE = new TextEncoder();

class TcpLine {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.pending = "";
  }
  async readChunk() {
    const { value, done } = await this.reader.read();
    if (done) throw new Error("連線已關閉 (EOF)");
    this.pending += dec.decode(value, { stream: true });
  }
  // 單行回應 "+OK ..." / "-ERR ..."
  async line(maxBytes = 65536) {
    while (this.pending.indexOf("\r\n") < 0 && this.pending.length < maxBytes) {
      await this.readChunk();
    }
    const i = this.pending.indexOf("\r\n");
    const out = i >= 0 ? this.pending.slice(0, i) : this.pending;
    this.pending = i >= 0 ? this.pending.slice(i + 2) : "";
    return out;
  }
  // 多行回應，以 "\r\n.\r\n" 結尾
  async multi(maxBytes = 260000) {
    while (this.pending.indexOf("\r\n.\r\n") < 0 && this.pending.length < maxBytes) {
      await this.readChunk();
    }
    let out;
    const i = this.pending.indexOf("\r\n.\r\n");
    if (i >= 0) { out = this.pending.slice(0, i); this.pending = this.pending.slice(i + 5); }
    else { out = this.pending; this.pending = ""; }
    return out;
  }
  async cmdSingle(s) { await this.writer.write(TE.encode(s + "\r\n")); return this.line(); }
  async cmdMulti(s) {
    await this.writer.write(TE.encode(s + "\r\n"));
    const st = await this.line();
    const body = await this.multi();
    return { st, body };
  }
  async startTls() {
    try { this.reader.releaseLock(); } catch {}
    try { this.writer.releaseLock(); } catch {}
    const upgraded = await this.socket.startTls();
    this.socket = upgraded;
    this.reader = upgraded.readable.getReader();
    this.writer = upgraded.writable.getWriter();
  }
  close() {
    try { this.writer.write(TE.encode("QUIT\r\n")); } catch {}
    try { this.writer.close(); } catch {}
    try { this.socket.close(); } catch {}
  }
}

// 取得新郵件清單（快照式：以 UIDL 增量比對 + 回傳 TOP 內容和解碼結果）
// opts:
//   knownUids: Set<string>  已處理過的 UIDL（增量判斷）
//   sinceTs: number|null    只保留 Date >= sinceTs 的信（首次回看用）
//   maxCount: number        最多回傳幾封（最新的優先）
//   topLines: number        每封 TOP 抓幾行內容
// 回傳 {ok, count, mails:[{uid,n,subject,from,date,ts,snippet}], stage?, error?, steps}
export async function fetchMail(inbox, opts = {}) {
  const { knownUids = new Set(), sinceTs = null, maxCount = 25, topLines = 120 } = opts;
  const host = inbox.host, port = inbox.port || 995, mode = inbox.mode || "tls";
  const steps = [];
  let p = null;
  try {
    p = new TcpLine(connect(`${host}:${port}`, {
      allowHalfOpen: false,
      secureTransport: mode === "tls" ? "on" : (mode === "starttls" ? "starttls" : "off"),
    }));
    const greeting = await p.line();
    steps.push(["greeting", greeting.slice(0, 80)]);
    if (!greeting.startsWith("+OK")) return { ok: false, stage: "greeting", error: greeting, steps };

    if (mode === "starttls") {
      const st = await p.cmdSingle("STLS");
      if (!st.startsWith("+OK")) return { ok: false, stage: "stls", error: st, steps };
      await p.startTls();
      steps.push(["starttls", "upgraded"]);
    }

    const u = await p.cmdSingle(`USER ${inbox.user}`);
    if (!u.startsWith("+OK")) return { ok: false, stage: "user", error: u, steps };
    const pw = await p.cmdSingle(`PASS ${inbox.pass}`);
    if (!pw.startsWith("+OK")) return { ok: false, stage: "pass", error: pw, steps };
    steps.push(["auth", "ok"]);

    const stat = await p.cmdSingle("STAT");
    const sm = stat.match(/^\+OK\s+(\d+)\s+(\d+)/);
    if (!sm) return { ok: false, stage: "stat", error: stat, steps };
    const count = parseInt(sm[1]);
    if (count === 0) { try { p.close(); } catch {} return { ok: true, count: 0, mails: [], steps }; }

    // UIDL 清單（只取最後 maxCount*2 附近即可增量比對；先整份讀回（上限 240KB），不行就截）
    let uidLines = [];
    const uidl = await p.cmdMulti("UIDL");
    uidLines = uidl.body.split(/\r?\n/).filter(Boolean);
    if (uidLines.length > count) uidLines = uidLines.filter(l => { const sp = l.indexOf(" "); return sp > -1; });

    // 解析成 {n, uid}，取最後段做候選
    const all = uidLines.map(l => { const sp = l.indexOf(" "); return { n: parseInt(l.slice(0, sp)), uid: l.slice(sp + 1).trim() }; });
    const cand = all.slice(-Math.max(maxCount * 3, 80));

    // 新信 = 不在 knownUids 的；再套 sinceTs 時間窗
    let news = cand.filter(x => !knownUids.has(x.uid));
    // 載入內容（由舊到新的 TOP，回傳前依時間排序、截 maxCount 封最新的）
    const mails = [];
    for (const item of news.slice(-maxCount * 2)) {
      let raw;
      try { const r = await p.cmdMulti(`TOP ${item.n} ${topLines}`); raw = r.body; }
      catch {
        // TOP 不支援時退回 RETR（可能抓很多，限筆）
        try { const r = await p.cmdMulti(`RETR ${item.n}`); raw = r.body; }
        catch (e) { steps.push(["fetch_fail", `${item.n}: ${String(e).slice(0, 60)}`]); continue; }
      }
      try {
        const m = decodeMail(raw);
        mails.push({ uid: item.uid, n: item.n, ...m });
      } catch (e) { steps.push(["decode_fail", `${item.n}: ${String(e).slice(0, 60)}`]); }
    }
    try { p.close(); } catch {}

    // 過濾時間窗 + 截取 maxCount 封最新
    let list = sinceTs != null ? mails.filter(m => (m.ts || 0) >= sinceTs) : mails;
    if (list.length > maxCount) list = list.slice(-maxCount);
    list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return { ok: true, count, mails: list, steps };
  } catch (e) {
    try { p?.close(); } catch {}
    return { ok: false, stage: "session", error: String(e).slice(0, 300), steps };
  }
}

// ---------- MIME 解碼 ----------

export function decodeMail(raw) {
  const sep = findHeaderEnd(raw);
  const headRaw = raw.slice(0, sep);
  let body = raw.slice(sep);
  if (!body.endsWith("\n")) body += "\n";

  const headers = parseHeaders(headRaw);
  const ctype = headers["content-type"] || "";
  const cte = (headers["content-transfer-encoding"] || "").trim().toLowerCase();
  const meta = { ...parseCtype(ctype), cte };

  let text = extractPart(body, meta) || (headers.subject || "");

  // 標題、寄件者正規化
  const subject = decodeHeader(headers.subject || "");
  const from = cleanFrom(decodeHeader(headers.from || ""));
  const to = cleanFrom(decodeHeader(headers.to || ""));
  const dateStr = headers.date || "";
  let ts = 0;
  try { const d = new Date(dateStr); if (!isNaN(d.getTime())) ts = Math.floor(d.getTime() / 1000); } catch {}
  if (!ts) ts = Math.floor(Date.now() / 1000);

  // 對純文字內容做深度去噪：重複空行、腳註
  const snippet = cleanSnippet(text);
  return { subject, from, to, date: dateStr, ts, snippet };
}

function findHeaderEnd(raw) {
  let off = 0;
  while (true) {
    const nl = raw.indexOf("\n", off);
    if (nl === -1) { off = raw.length; break; }
    const line = raw.slice(off, nl);
    const trimmed = line.replace(/\r$/, "");
    if (trimmed === "") { off = nl + 1; break; }
    off = nl + 1;
  }
  return off; // body 起點（回傳 headerEnd=separator 的位置）
}

function parseHeaders(headRaw) {
  const headers = {};
  let last = null;
  for (const rawLine of headRaw.split(/\r?\n/)) {
    if (!rawLine) continue;
    if (/^[ \t]/.test(rawLine)) {
      if (last) headers[last] += " " + rawLine.trim();
      continue;
    }
    const i = rawLine.indexOf(":");
    if (i < 1) continue;
    const key = rawLine.slice(0, i).trim().toLowerCase();
    headers[key] = rawLine.slice(i + 1).trim();
    last = key;
  }
  return headers;
}

// RFC2047 decode + 換行修復
function decodeHeader(h) {
  if (!h) return "";
  return String(h)
    .replace(/=\?([^?]+)\?([BbQq])\?([^?\s]*)\?=/g,
      (m, cs, q, txt) => tryDecodeCharset(cs, q.toLowerCase(), txt))
    .replace(/\r?\n[ \t]+/g, " ").trim();
}

function tryDecodeCharset(charset, enc, txt) {
  try {
    let bytes;
    if (enc === "b") {
      let b64 = txt.replace(/-/g, "+").replace(/_/g, "/");
      while (b64.length % 4) b64 += "=";
      const bin = atob(b64);
      bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    } else {
      const s = txt.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
      bytes = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    }
    return new TextDecoder(normalizeCharset(charset)).decode(bytes);
  } catch { return txt; }
}

function normalizeCharset(cs) {
  const c = String(cs || "utf-8").toLowerCase();
  if (c === "big5" || c === "x-big5" || c.startsWith("big5")) return "big5";
  if (c.startsWith("gb") || c.includes("chinese")) return "gb18030";
  if (c.includes("shift") || c.includes("sjis")) return "shift_jis";
  return c;
}

function cleanFrom(s) {
  let out = String(s || "").replace(/[\r\n]/g, " ").replace(/"<>/g, "").trim();
  // 取「名 <mail>」組合或 mail
  return out.slice(0, 120);
}

// 淺層 multipart 處理：優取 text/plain，退而取 text/html
function extractPart(body, meta) {
  if (meta.type === "multipart" && meta.params.boundary) {
    const b = `--${meta.params.boundary}`;
    const secs = body.split(b);
    let plain = null, html = null;
    for (const sec of secs.slice(1)) {
      if (/^\s*--/.test(sec)) break; // 結束 boundary
      const hdEnd = sec.search(/\r\n\r\n/);
      if (hdEnd < 0) continue;
      const head = sec.slice(0, hdEnd);
      const rest = sec.slice(hdEnd + 4);
      const hdrs = parseHeaders(head + "\n");
      const pm = parseCtype(hdrs["content-type"] || "text/plain");
      const cte = hdrs["content-transfer-encoding"] || "";
      if (pm.type === "text/plain") { plain = { raw: rest, cte, charset: pm.params.charset }; }
      else if (pm.type === "text/html" && !html) { html = { raw: rest, cte, charset: pm.params.charset }; }
      if (plain) break;
    }
    const pick = plain || html;
    if (!pick) return "";
    let text = decodeByCte(pick.raw, pick.cte, pick.charset);
    if (pick === html) text = htmlToText(text);
    return text;
  }
  // 非 multipart：最外層即內容
  let text = decodeByCte(body, meta.cte, meta.params.charset);
  if (meta.type === "text/html" || (meta.type !== "text" && /</.test(text.slice(0, 200)))) text = htmlToText(text);
  return text;
}

function decodeByCte(raw, cte, charset) {
  try {
    const cteLow = String(cte || "").toLowerCase().trim();
    if (cteLow === "base64") return b64Decode(raw, charset);
    if (cteLow === "quoted-printable") return qpDecode(raw, charset);
    return String(raw || "");
  } catch { return String(raw || ""); }
}

function b64Decode(raw, charset) {
  let b64 = String(raw).replace(/\s+/g, "");
  while (b64.length % 4) b64 += "=";
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder(normalizeCharset(charset)).decode(bytes);
  } catch { return ""; }
}

function qpDecode(raw, charset) {
  try {
    const s = String(raw).replace(/=\r?\n/g, "").replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16)));
    const bytes = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
    return new TextDecoder(normalizeCharset(charset)).decode(bytes);
  } catch { return String(raw); }
}

function parseCtype(ctypeHeader) {
  const s = String(ctypeHeader || "text/plain");
  const main = s.split(";")[0].trim().toLowerCase();
  const type = main.split("/")[0];
  const sub = main.split("/")[1] || "";
  const params = {};
  for (const kv of s.split(";").slice(1)) {
    const m = kv.match(/\s*([A-Za-z0-9_-]+)\s*=\s*(.+?)(?:\s|$)/);
    if (m) params[m[1].toLowerCase()] = String(m[2]).replace(/^"|"$/g, "");
  }
  return { type, sub, full: main, params };
}

// 把 html 轉成可讀文字（淺層去標籤）
function htmlToText(h) {
  return String(h)
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function cleanSnippet(t) {
  return String(t || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "")
    .split("\n").map(l => l.trim()).filter(Boolean)
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, 1600);
}

// ---------- AI 去識別化 ----------

// 內建預設模式（學校信箱常見的可識別資訊）
const DEFAULT_REDACT_PATTERNS = [
  /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, // email
  /\b[A-HD-KPRSTU][0-9]{8,9}\b/g,                    // 學號（台大常見：B/9 開頭英數字串）
  /\b09[0-9]{2}[- ]?[0-9]{3}[- ]?[0-9]{3}\b/g,        // 手機（0912-345-678 / 0912345678）
  /\b0[0-9]{1,2}[- ]?[0-9]{7,8}\b/g,                  // 市話/長途
];

// 把文字中的敏感片段替換成穩定的代碼（同一原文 -> 同一代碼）
// extraPatterns: 從 secret / 郵箱設定自加的正規式組（ 例如 ["王小華", "TA 小明", "re:B\\d{8,9}"] ）
export function buildRedactor(extraPatterns) {
  const pats = [...DEFAULT_REDACT_PATTERNS];
  for (const raw of extraPatterns || []) {
    const s = String(raw || "").trim();
    if (!s || s.startsWith("#")) continue;
    if (s.startsWith("re:")) {
      try { pats.push(new RegExp(s.slice(3), "g")); } catch {}
    } else {
      pats.push(new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"));
    }
  }
  const map = new Map();
  const fn = (text) => {
    let t = String(text ?? "");
    for (const re of pats) {
      t = t.replace(re, (m) => {
        if (!map.has(m)) map.set(m, `⟨私${String(map.size + 1).padStart(2, "0")}⟩`);
        return map.get(m);
      });
    }
    return t;
  };
  fn.map = map;
  return fn;
}
