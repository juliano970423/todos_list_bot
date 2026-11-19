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
  // 關鍵：無論內容多大都必須吃到結尾記號為止。舊版撞到 260KB 就放棄並清空 pending，
  // 結尾記號殘留在 socket 裡 → 後續每條命令全部錯位 → 每封信都解出上一封信的
  // base64 碎片（「5 封全空白」的根因）。內容過大只截斷回傳，對齊必須保住。
  // 超過 hardBytes 視為連線中毒（無法合理對齊），throw 由呼叫端中止本輪。
  async multi(maxBytes = 260000, hardBytes = 5000000) {
    while (this.pending.indexOf("\r\n.\r\n") < 0) {
      await this.readChunk();
      if (this.pending.length > hardBytes) {
        this.poisoned = true;
        throw new Error("多行回應超過硬上限，連線已中毒");
      }
    }
    const i = this.pending.indexOf("\r\n.\r\n");
    let out = this.pending.slice(0, i);
    this.pending = this.pending.slice(i + 5);
    if (out.length > maxBytes) out = out.slice(0, maxBytes); // 截斷內容，但結尾已吃掉、stream 仍對齊
    return out;
  }
  async cmdSingle(s) { await this.writer.write(TE.encode(s + "\r\n")); return this.line(); }
  async cmdMulti(s) {
    await this.writer.write(TE.encode(s + "\r\n"));
    const st = await this.line();
    // POP3 的 -ERR 是「單行」回應（沒有結尾記號），絕不能去讀 body，
    // 否則會把下一條命令的回應當成這封信的內容 → 整個 session 錯位
    if (st.startsWith("-ERR")) return { st, body: "" };
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

// 取得新郵件清單（快照式：以 UIDL 增量比對 + 回傳信件解碼結果）
// opts:
//   knownUids: Set<string>  已處理過的 UIDL（增量判斷）
//   sinceTs: number|null    只保留 Date >= sinceTs 的信（首次回看用）
//   maxCount: number        最多回傳幾封（最新的優先）
//   topLines: number        每封 TOP 抓幾行內容
//   full: boolean           true = 整信抓回（RETR），摘要品質依賴完整內文時用
// 回傳 {ok, count, mails:[{uid,n,subject,from,date,ts,text}], stage?, error?, steps}
export async function fetchMail(inbox, opts = {}) {
  const { knownUids = new Set(), sinceTs = null, maxCount = 25, topLines = 120, full = false } = opts;
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
      if (p.poisoned) { steps.push(["aborted_poisoned", String(item.n)]); break; }
      let raw = null, st = "";
      try {
        // full=true 時整信抓回（RETR）；否則 TOP 省頻寬
        const r = full ? await p.cmdMulti(`RETR ${item.n}`) : await p.cmdMulti(`TOP ${item.n} ${topLines}`);
        st = r.st;
        if (r.st.startsWith("+OK")) raw = r.body;
        else if (!full) {
          // TOP 被拒絕（-ERR 單行回應）→ 退回 RETR
          const r2 = await p.cmdMulti(`RETR ${item.n}`);
          st = r2.st;
          if (r2.st.startsWith("+OK")) raw = r2.body;
        }
      }
      catch (e) {
        if (p.poisoned) { steps.push(["poisoned", `${item.n}: ${String(e).slice(0, 60)}`]); break; }
        steps.push(["fetch_fail", `${item.n}: ${String(e).slice(0, 60)}`]); continue;
      }
      if (raw == null) {
        // 狀態行不是 +OK（-ERR 或非預期回應）→ 跳過這封，不吃 body 也不留髒資料
        steps.push(["err_resp", `${item.n}: ${String(st).slice(0, 60)}`]);
        continue;
      }
      try {
        const m = decodeMail(raw, full ? 8000 : 1600);
        // 診斷用：raw 長度與前 120 字元（/email_raw 顯示，判斷「解不出」是 raw 空還是解析壞）
        mails.push({ uid: item.uid, n: item.n, rawLen: raw.length, rawHead: raw.slice(0, 120), ...m });
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

export function decodeMail(raw, textCap = 1600) {
  const sep = findHeaderEnd(raw);
  const headRaw = raw.slice(0, sep);
  let body = raw.slice(sep);
  if (!body.endsWith("\n")) body += "\n";

  const headers = parseHeaders(headRaw);
  const ctype = headers["content-type"] || "";
  const cte = (headers["content-transfer-encoding"] || "").trim().toLowerCase();
  const meta = { ...parseCtype(ctype), cte };

  const extracted = extractPart(body, meta);
  // bodyEmpty：信件本體解不出任何文字（純圖片/附件信或解碼失敗）。
  // text 仍退回主旨，讓 AI 至少看得到主旨；但摘要層靠 bodyEmpty 把這類信合併處理。
  const bodyEmpty = !String(extracted || "").replace(/\s+/g, "");
  let text = extracted || (headers.subject || "");

  // 標題、寄件者正規化
  const subject = decodeHeader(headers.subject || "");
  const from = cleanFrom(decodeHeader(headers.from || ""));
  const to = cleanFrom(decodeHeader(headers.to || ""));
  const dateStr = headers.date || "";
  let ts = 0;
  try { const d = new Date(dateStr); if (!isNaN(d.getTime())) ts = Math.floor(d.getTime() / 1000); } catch {}
  // 沒有 Date 時保持 0（排最前）。舊版 fallback 成 now 會讓「解不出 header 的垃圾」
  // 被排成最新信，霸佔顯示範圍。

  // 對純文字內容做深度去噪：重複空行、腳註；textCap 控制保留長度（摘要用全文時給大值）
  const cleaned = cleanSnippet(text, textCap);
  return { subject, from, to, date: dateStr, ts, text: cleaned, bodyEmpty };
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

// multipart 展開：收集所有 leaf 文字 part（支援巢狀 multipart，深度上限 3）
// 舊版兩個致命缺陷（造成「空白郵件」+「期限未見於文字內容」）：
//  1. 比對 pm.type === "text/plain" —— parseCtype 回傳 type="text"、sub 才是 "plain"，
//     永遠不命中 → multipart 信一律解出空字串（NTU COOL 全是 multipart/alternative）
//  2. 只認 \r\n\r\n 分隔 —— LF-only 行尾的信每個 section 都切不出 header/body
function collectLeafParts(body, meta, depth, out) {
  if (depth > 3) return;
  if (meta.type === "multipart" && meta.params.boundary) {
    const b = `--${meta.params.boundary}`;
    const secs = body.split(b);
    for (const sec of secs.slice(1)) {
      if (/^\s*--/.test(sec)) break; // 結束 boundary
      const m = /\r?\n\r?\n/.exec(sec);
      if (!m) continue;
      const head = sec.slice(0, m.index);
      const rest = sec.slice(m.index + m[0].length);
      const hdrs = parseHeaders(head + "\n");
      const pm = parseCtype(hdrs["content-type"] || "text/plain");
      const cte = hdrs["content-transfer-encoding"] || "";
      if (pm.type === "multipart") {
        collectLeafParts(rest, pm, depth + 1, out); // 巢狀（mixed > alternative）
      } else if (pm.type === "text") {
        out.push({ sub: pm.sub || "plain", raw: rest, cte, charset: pm.params.charset });
      }
      // 非文字 part（附件、image/*、message/rfc822）一律跳過
    }
    return;
  }
  // 非 multipart：最外層即內容
  out.push({ sub: meta.sub || "plain", raw: body, cte: meta.cte, charset: meta.params.charset });
}

function extractPart(body, meta) {
  const parts = [];
  collectLeafParts(body, meta, 0, parts);
  const effLen = (t) => String(t || "").replace(/\s+/g, "").length;

  let bestPlain = "", bestHtml = "";
  for (const p of parts) {
    let t = decodeByCte(p.raw, p.cte, p.charset);
    if (p.sub === "html") t = htmlToText(t);
    if (p.sub === "html") { if (effLen(t) > effLen(bestHtml)) bestHtml = t; }
    else if (effLen(t) > effLen(bestPlain)) bestPlain = t;
  }
  // plain 有實質內容（≥20 非空白字）→ 用 plain（乾淨）；
  // plain 是空殼/太短（alternative 裡 plain 常是空的，完整內容在 html）→ 退 html
  if (effLen(bestPlain) >= 20) return bestPlain;
  if (effLen(bestHtml) > 0) return bestHtml;
  return bestPlain || bestHtml || "";
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

function cleanSnippet(t, maxLen = 1600) {
  return String(t || "")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\r/g, "")
    .split("\n").map(l => l.trim()).filter(Boolean)
    .join("\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, maxLen);
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
