// GIWA Mainnet Watch — Telegram bildirim botu
// Bağımlılık yok. Node 20+ gerekir (yerleşik fetch).
//
// Ortam değişkenleri:
//   TELEGRAM_BOT_TOKEN  (zorunlu)  BotFather'ın verdiği token
//   TELEGRAM_CHAT_ID    (isteğe bağlı) Boşsa bota ilk /start yazan sohbet kaydedilir
//   GITHUB_TOKEN        (önerilir)  Yetkisiz public okuma token'ı; GitHub limitine takılmamak için
//   ETH_RPC_URL         (isteğe bağlı) Ethereum ana ağı RPC. Boşsa ücretsiz publicnode kullanılır
//   DATA_DIR            (isteğe bağlı) Durum dosyasının klasörü. Railway'de Volume'u /data'ya bağla.
//   TZ_OFFSET_HOURS     (isteğe bağlı) Günlük "hayattayım" mesajı saati için, varsayılan 3 (İstanbul)
//   STATUS_KEY          (isteğe bağlı) Verilirse GET /status?key=... ile durum JSON olarak okunur (kişisel asistan için)

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";
import { createServer } from "node:http";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN tanımlı değil.");
  process.exit(1);
}
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const ETH_RPC = process.env.ETH_RPC_URL || "https://ethereum-rpc.publicnode.com";
const DATA_DIR = process.env.DATA_DIR || "./data";
const TZ = Number(process.env.TZ_OFFSET_HOURS ?? 3);
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SPEED = Number(process.env.SPEED || 1); // sadece test için

const SEPOLIA_CHAIN_ID = 91342;
const SEPOLIA_BATCHER = "0x1caaaa58002a7e8b4c6f427ac2c943767b4d6cd7"; // giwa-io/node sepolia-rollup.json
const DOCS_URL = "https://docs.giwa.io/giwa-chain/en/get-started/connect-to-giwa.md";
const DOCS_DEV_TEXT = "GIWA Mainnet is currently under development";
const DOCS_INDEX_URL = "https://docs.giwa.io/llms.txt";
const UPBIT_NOTICE_URLS = [
  "https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20&category=all",
  "https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=30&category=all",
  "https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=20",
  "https://api-manager.upbit.com/api/v1/notices?page=1&per_page=30",
];
const GIWA_WORDS = /giwa|기와/i;
// GIWA'nın L1 operasyon kayıtları. Yapı: <ağ>/<tarih-iş>/artifacts/<adım>/<L1 chain ID>/<dosya>.json
// Bugüne kadarki her şey sepolia/…/11155111/ altında. Ethereum ana ağı = L1 chain ID 1.
const CHAINOPS = "giwa-io/chain-operations";
// RPC sağlayıcıları ağı genelde herkesten önce alır. Bu adreslerin cevabı değişirse haber ver.
const PROVIDER_PROBES = [
  "https://giwa-mainnet.g.alchemy.com/v2/probe",
  "https://giwa.g.alchemy.com/v2/probe",
];
// OP Stack L2 predeploy'ları — her gerçek OP Stack zincirinde bu adreslerde kod olur
const L1BLOCK = "0x4200000000000000000000000000000000000015";
const L2_TO_L1_PASSER = "0x4200000000000000000000000000000000000016";

// Mainnet açılınca büyük ihtimalle kullanılacak alan adları (giwa.io, sepolia-rpc.giwa.io kalıbından)
const RPC_CANDIDATES = [
  "https://rpc.giwa.io",
  "https://mainnet-rpc.giwa.io",
  "https://rpc-mainnet.giwa.io",
  "https://mainnet.giwa.io",
  "https://rpc-flashblocks.giwa.io",
  "https://mainnet-rpc-flashblocks.giwa.io",
];
const DNS_CANDIDATES = [
  "rpc.giwa.io", "mainnet-rpc.giwa.io", "rpc-mainnet.giwa.io", "mainnet.giwa.io",
  "explorer.giwa.io", "mainnet-explorer.giwa.io", "sequencer.giwa.io",
  "mainnet-sequencer.giwa.io", "snapshot.giwa.io", "mainnet-snapshot.giwa.io",
  "bridge.giwa.io", "rpc-flashblocks.giwa.io",
];

// ---------- durum ----------
let state = {};
function loadState() {
  try { state = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch { state = {}; }
  state.seen ??= {};      // izleyici -> önceki değer
  state.fired ??= {};     // tek seferlik kritik alarmlar
  state.health ??= {};    // izleyici -> {ok, at, err}
  state.chatId ??= process.env.TELEGRAM_CHAT_ID || null;
}
function saveState() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = STATE_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ---------- yardımcılar ----------
async function http(url, opts = {}, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: ctrl.signal });
  } finally { clearTimeout(t); }
}
async function gh(pathAndQuery) {
  const headers = { "Accept": "application/vnd.github+json", "User-Agent": "giwa-mainnet-watch" };
  if (GH_TOKEN) headers.Authorization = `Bearer ${GH_TOKEN}`;
  const r = await http(`https://api.github.com/${pathAndQuery}`, { headers });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GitHub ${r.status} ${pathAndQuery}`);
  return r.json();
}
async function rpc(url, method, params = []) {
  const r = await http(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  }, 10000);
  if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message);
  return j.result;
}
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const SAFETY = "\n\n⚠️ Sadece resmi kaynaklara güven (github.com/giwa-io, docs.giwa.io, @GIWA_by_Upbit). Doğrulamadan hiçbir köprüye para gönderme.";

// ---------- Telegram ----------
async function tg(method, body) {
  const r = await http(`https://api.telegram.org/bot${TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }, 40000);
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
  return j.result;
}
const outbox = [];
// Seviyeler: info (rutin), hint (doğrulanmamış ipucu), strong (resmi kaynakta mainnet izi), confirmed (zincir üstünde kanıtlandı)
const HEAD = {
  info: "🔔 ",
  hint: "🔎 <b>İpucu — doğrulanmadı</b>\n\n",
  strong: "🟠 <b>GÜÇLÜ SİNYAL — resmi kaynakta mainnet izi</b>\n\n",
  confirmed: "🚨🚨 <b>GIWA MAINNET — ZİNCİR ÜSTÜNDE DOĞRULANDI</b>\n\n",
};
function notify(text, { level = "info" } = {}) {
  let msg = (HEAD[level] || HEAD.info) + text;
  if (level === "strong" || level === "confirmed") msg += "\n\n" + assessText() + SAFETY;
  else if (level === "hint") msg += "\n\n<i>Tek başına mainnet anlamına gelmez. Kesin durum için /dogrula</i>";
  console.log("[notify]", msg.replace(/<[^>]+>/g, ""));
  // Son bildirimleri sakla (kişisel asistan /status üzerinden okur)
  (state.recent ??= []).push({ at: Date.now(), level, text: text.replace(/<[^>]+>/g, "").slice(0, 500) });
  state.recent = state.recent.slice(-20);
  outbox.push(msg);
  flush();
}
let flushing = false;
async function flush() {
  if (flushing || !state.chatId) return;
  flushing = true;
  try {
    while (outbox.length) {
      await tg("sendMessage", { chat_id: state.chatId, text: outbox[0], parse_mode: "HTML", disable_web_page_preview: true });
      outbox.shift();
    }
  } catch (e) {
    console.error("Telegram gönderim hatası:", e.message);
  } finally { flushing = false; }
}

// Komutlar: /start /status /test
let updateOffset = 0;
async function pollTelegram() {
  for (;;) {
    try {
      const updates = await tg("getUpdates", { offset: updateOffset, timeout: 30, allowed_updates: ["message"] });
      for (const u of updates) {
        updateOffset = u.update_id + 1;
        const m = u.message;
        if (!m?.text) continue;
        const chat = String(m.chat.id);
        const cmd = m.text.trim().split(/\s+/)[0].split("@")[0].toLowerCase();
        if (!state.chatId && cmd === "/start") {
          state.chatId = chat; saveState();
          await tg("sendMessage", { chat_id: chat, text: "✅ Kayıt tamam. GIWA mainnet sinyallerini bu sohbete göndereceğim.\n\n/dogrula — kesin kaynakları şimdi kontrol et\n/status — izleyicilerin durumu\n/test — deneme bildirimi" });
          flush();
          continue;
        }
        if (chat !== String(state.chatId)) continue; // yabancı sohbetleri yok say
        if (cmd === "/start") await tg("sendMessage", { chat_id: chat, text: "Zaten kayıtlısın. /status yaz." });
        else if (cmd === "/status") await tg("sendMessage", { chat_id: chat, text: statusText(), parse_mode: "HTML" });
        else if (cmd === "/test") notify("Test bildirimi — bot çalışıyor.");
        else if (cmd === "/dogrula" || cmd === "/doğrula" || cmd === "/verify") verifyNow(chat);
      }
    } catch (e) {
      console.error("getUpdates hatası:", e.message);
      await sleep(5000);
    }
  }
}
function statusText() {
  const lines = ["<b>GIWA Watch durumu</b>"];
  for (const w of WATCHERS) {
    const h = state.health[w.id];
    const when = h ? new Date(h.at).toISOString().slice(11, 16) + " UTC" : "henüz yok";
    lines.push(`${h?.ok ? "🟢" : h ? "🔴" : "⚪"} ${w.name} — ${when}${h && !h.ok ? `\n   <i>${esc(h.err).slice(0, 120)}</i>` : ""}`);
  }
  lines.push("", `<b>Karar:</b> ${assess().verdict}`, "Ayrıntı için /dogrula");
  return lines.join("\n");
}

// /dogrula: kesin kaynakları sırayla yeniden çalıştırır ve kararı yazar
let verifying = false;
async function verifyNow(chat) {
  if (verifying) return tg("sendMessage", { chat_id: chat, text: "Doğrulama zaten sürüyor, birazdan sonuç gelecek." });
  verifying = true;
  try {
    await tg("sendMessage", { chat_id: chat, text: "🔍 Resmi kaynaklar ve Ethereum ana ağı kontrol ediliyor (~30 sn)…" });
    for (const id of ["chainops", "node-repo", "docs", "docs-index", "registry", "l1", "rpc"]) {
      const w = WATCHERS.find((x) => x.id === id);
      if (w) await runWatcher(w, { force: true });
    }
    await tg("sendMessage", { chat_id: chat, text: assessText(), parse_mode: "HTML", disable_web_page_preview: true });
  } catch (e) {
    await tg("sendMessage", { chat_id: chat, text: `Doğrulama hatası: ${e.message}` }).catch(() => {});
  } finally { verifying = false; }
}

// ---------- kesinlik değerlendirmesi ----------
// state.ev: doğrulanmış kanıtlar. Sadece resmi kaynaklardan ve Ethereum ana ağından gelen bilgiler buraya yazılır.
function ev() { return (state.ev ??= {}); }
function setOfficial(source, data) {
  const e = ev();
  const o = (e.official ??= { sources: [] });
  if (data.l2ChainId && o.l2ChainId && o.l2ChainId !== data.l2ChainId && !state.fired[`conflict:${data.l2ChainId}`]) {
    state.fired[`conflict:${data.l2ChainId}`] = Date.now();
    notify(`⚠️ Resmi kaynaklarda farklı mainnet chain ID'leri var: ${o.l2ChainId} (${esc(o.sources.join(", "))}) ve ${data.l2ChainId} (${esc(source)}). İkisine de güvenme, bekle.`, { level: "hint" });
  }
  for (const [k, v] of Object.entries(data)) if (v) o[k] = typeof v === "string" ? v.toLowerCase() : v;
  if (!o.sources.includes(source)) o.sources.push(source);
  // eski alanlarla uyum
  if (o.l2ChainId) state.seen.mainnetChainId = o.l2ChainId;
  if (o.portal) state.seen.mainnetPortal = o.portal;
}
function assess() {
  const e = ev(); const o = e.official || {};
  const lines = [];
  const row = (good, text) => lines.push(`${good === true ? "✅" : good === false ? "❌" : "➖"} ${text}`);
  row(!!o.l2ChainId, o.l2ChainId ? `Resmi mainnet config: chain ID <b>${o.l2ChainId}</b> (${esc(o.sources.join(", "))})` : "GitHub'da resmi mainnet config yok");
  const code = e.l1Code || {};
  const codeKeys = Object.keys(code);
  if (!o.portal && !o.systemConfig) row(null, "Ethereum'daki kontratlar: kontrol için önce resmi adres gerekli");
  else if (!codeKeys.length) row(null, "Köprü kontratları Ethereum ana ağında: kontrol sırada");
  else row(codeKeys.every((k) => code[k]), `Köprü kontratları Ethereum ana ağında: ${codeKeys.map((k) => `${k} ${code[k] ? "var" : "yok"}`).join(", ")}`);
  const txs = e.l1Txs || [];
  if (txs.length && e.l1TxOk === undefined) row(null, `Resmi operasyon işlemleri (${txs.length}): Ethereum'da kontrol sırada`);
  else if (txs.length) row(e.l1TxOk > 0, `Resmi operasyon işlemleri Ethereum'da onaylı: ${e.l1TxOk || 0}/${txs.length}`);
  else row(null, "Resmi operasyon işlemi (Ethereum ana ağı) yayınlanmadı");
  const r = e.rpc;
  row(!!r?.full, r?.full ? `Mainnet RPC canlı ve Ethereum'a bağlı: <code>${esc(r.url)}</code> (chain ID ${r.id})` : "Ethereum ana ağına bağlı canlı GIWA RPC bulunamadı");
  row(!!e.docsLive, e.docsLive ? `Resmi dokümanda mainnet bilgisi var${e.docsChainIds?.length ? ` (chain ID ${e.docsChainIds.join(", ")})` : ""}` : "Doküman hâlâ \"mainnet geliştiriliyor\" diyor");
  row(!!e.registry, e.registry ? "Optimism superchain-registry'de mainnet config var" : "superchain-registry'de mainnet config yok");
  const upOk = state.health.upbit?.ok;
  row(e.upbitMainnet ? true : upOk === false ? null : false, e.upbitMainnet ? `Upbit resmi duyurusu: ${esc(e.upbitMainnet)}` : upOk === false ? "Upbit duyuruları bu sunucudan okunamıyor" : "Upbit'te mainnet duyurusu yok");

  // Çapraz doğrulama: RPC'nin chain ID'si başka bağımsız resmi kaynakla eşleşmeli
  const crossIds = new Set([o.l2ChainId, ...(e.docsChainIds || [])].filter(Boolean));
  const cross = r?.full && (crossIds.has(r.id) || !!e.upbitMainnet);
  let level, verdict;
  if (cross) { level = "live"; verdict = "🟢 KESİN — GIWA mainnet canlı ve resmi kaynaklarla çapraz doğrulandı"; }
  else if (r?.full) { level = "running"; verdict = "🟠 Resmi alan adında Ethereum'a bağlı bir zincir çalışıyor, ama chain ID henüz başka resmi kaynakla eşleşmedi"; }
  else if ((codeKeys.length && codeKeys.every((k) => code[k])) || (e.l1TxOk || 0) > 0) { level = "deployed"; verdict = "🟠 Mainnet kontratları Ethereum'da deploy edilmiş — ağ henüz herkese açık değil"; }
  else if (o.l2ChainId || e.registry || e.docsLive) { level = "prep"; verdict = "🟡 Resmi mainnet hazırlık izi var, zincir henüz canlı değil"; }
  else { level = "none"; verdict = "⚪ Mainnet'e dair doğrulanmış iz yok"; }
  return { level, verdict, lines };
}
function assessText() {
  const a = assess();
  return `<b>Kesinlik:</b> ${a.verdict}\n${a.lines.join("\n")}`;
}
// Karar seviyesi yükseldiğinde bir kez haber ver
function reassess() {
  const a = assess();
  const r = ev().rpc;
  if (a.level === "live") fireOnce("verdict:live", `Bağımsız resmi kaynaklar ve Ethereum ana ağı aynı şeyi söylüyor.\n\nRPC: <code>${esc(r.url)}</code> — Chain ID <b>${r.id}</b>\n<b>Zincir testi:</b>\n${(r.lines || []).join("\n")}`, "confirmed");
  else if (a.level === "running") fireOnce(`verdict:running:${ev().rpc?.url}`, "Resmi giwa.io adresinde, Ethereum ana ağına bağlı ve blok üreten bir zincir bulundu.", "strong");
  else if (a.level === "deployed") fireOnce("verdict:deployed", "GIWA mainnet kontratları Ethereum ana ağında zincir üstünde doğrulandı.", "strong");
}

// Alarm: aynı anahtar için bir kez gönderilir
function fireOnce(key, text, level = "strong") {
  if (state.fired[key]) return;
  state.fired[key] = Date.now();
  notify(text, { level });
}
// Farka dayalı izleme: ilk çalıştırmada sessizce taban değeri alır
function diffSet(key, current) {
  const prev = state.seen[key];
  state.seen[key] = current;
  if (!prev) return [];
  const p = new Set(prev);
  return current.filter((x) => !p.has(x));
}

// ---------- izleyiciler ----------
const WATCHERS = [
  {
    id: "rpc", name: "Mainnet RPC adresleri", everySec: 60,
    async run({ force } = {}) {
      const extra = (state.seen.extraRpc || []).filter((u) => !RPC_CANDIDATES.includes(u));
      for (const url of [...RPC_CANDIDATES, ...extra]) {
        let id;
        try { id = parseInt(await rpc(url, "eth_chainId"), 16); } catch { continue; }
        if (!Number.isFinite(id) || id === SEPOLIA_CHAIN_ID) continue;
        const key = `rpc:${url}:${id}`;
        if (state.fired[key] && !force && ev().rpc?.url === url) continue;
        const v = await verifyRpc(url, id);
        if (v.full) ev().rpc = { url, id, full: true, at: Date.now(), lines: v.lines };
        else if (ev().rpc?.url === url) delete ev().rpc; // artık geçmiyorsa kanıtı geri al
        if (assess().level === "live") { state.fired[key] ??= Date.now(); continue; } // ayrıntılar doğrulama mesajında gidecek
        fireOnce(key, `Resmi giwa.io adresinde Sepolia OLMAYAN bir RPC cevap veriyor:\n<code>${url}</code>\nChain ID: <b>${id}</b>\n\n<b>Zincir testi (${v.score}/${v.total}):</b>\n${v.lines.join("\n")}`, v.full ? "strong" : "hint");
      }
    },
  },
  {
    id: "dns", name: "giwa.io alt alan adları (DNS)", everySec: 120,
    async run() {
      const resolves = async (h) => { try { return (await dns.resolve(h)).length > 0; } catch { return false; } };
      // Joker (*.giwa.io) DNS varsa bu sinyal anlamsız olur — kontrol et
      if (await resolves(`zz-${Date.now().toString(36)}.giwa.io`)) { state.seen.dnsWildcard = true; return; }
      const live = [];
      for (const host of DNS_CANDIDATES) if (await resolves(host)) live.push(host);
      for (const h of live) addRpcCandidate(`https://${h}`);
      const firstRun = !state.seen.dnsLive;
      const added = diffSet("dnsLive", live);
      if (firstRun) return; // bot başlarken zaten var olanlar sinyal değil
      for (const host of added) fireOnce(`dns:${host}`, `Yeni alt alan adı çözülmeye başladı: <code>${host}</code>\n\nBu genelde servisin hazırlandığını gösterir; henüz canlı olmayabilir. RPC izleyicisi bu adresi zincir testinden geçirecek.`, "hint");
    },
  },
  {
    id: "docs", name: "Resmi doküman (Connect to GIWA)", everySec: 120,
    async run() {
      const r = await http(DOCS_URL, { headers: { "User-Agent": "giwa-mainnet-watch" } });
      if (!r.ok) throw new Error(`docs HTTP ${r.status}`);
      const text = await r.text();
      if (text.length < 200) throw new Error("docs içeriği beklenenden kısa");
      const ids = [...new Set([...text.matchAll(/Chain ID[^0-9]{0,80}?(\d{3,12})/gi)].map((m) => Number(m[1])).filter((n) => n !== SEPOLIA_CHAIN_ID && n !== 11155111))];
      ev().docsChainIds = ids;
      ev().docsLive = !text.includes(DOCS_DEV_TEXT);
      if (ev().docsLive) fireOnce("docs:dev-text-gone", `docs.giwa.io sayfasında "Mainnet geliştiriliyor" yazısı KALDIRILDI.\n${DOCS_URL.replace(".md", "")}`);
      for (const m of text.matchAll(/https:\/\/[a-z0-9.-]+\.giwa\.io/gi)) addRpcCandidate(m[0]);
      for (const id of ids) fireOnce(`docs:chainid:${id}`, `Resmi dokümanda yeni Chain ID göründü: <b>${id}</b>\n${DOCS_URL.replace(".md", "")}`);
    },
  },
  {
    id: "node-repo", name: "GitHub giwa-io/node", everySec: 180,
    async run() {
      const commits = await gh("repos/giwa-io/node/commits?per_page=5");
      if (!commits?.length) throw new Error("commit listesi boş");
      const head = commits[0].sha;
      if (state.seen.nodeHead && state.seen.nodeHead !== head) {
        const fresh = [];
        for (const c of commits) { if (c.sha === state.seen.nodeHead) break; fresh.push(c); }
        notify(`giwa-io/node deposuna yeni commit:\n${fresh.map((c) => `• ${esc(c.commit.message.split("\n")[0])}`).join("\n")}\nhttps://github.com/giwa-io/node/commits`);
      }
      if (state.seen.nodeHead === head && state.seen.nodeFiles) return;
      state.seen.nodeHead = head;
      const tree = await gh(`repos/giwa-io/node/git/trees/${head}?recursive=1`);
      const files = (tree?.tree || []).filter((f) => f.type === "blob").map((f) => f.path);
      const added = diffSet("nodeFiles", files);
      const mainnetFiles = files.filter((f) => /mainnet/i.test(f) || (/^\.env\./.test(f) && !/sepolia/i.test(f)) || (/^genesis\//.test(f) && !/sepolia/i.test(f)));
      for (const f of mainnetFiles) {
        let extra = "";
        if (/rollup\.json$/.test(f)) extra = await describeRollup(head, f);
        fireOnce(`node:file:${f}`, `giwa-io/node deposuna MAINNET dosyası eklendi:\n<code>${esc(f)}</code>${extra}\nhttps://github.com/giwa-io/node/blob/${head}/${encodeURI(f)}`);
      }
      const other = added.filter((f) => !mainnetFiles.includes(f));
      if (other.length) notify(`giwa-io/node yeni dosyalar:\n${other.slice(0, 15).map((f) => `• ${esc(f)}`).join("\n")}`);
    },
  },
  {
    id: "chainops", name: "GitHub giwa-io/chain-operations (L1 işlemleri)", everySec: 180,
    async run() {
      const commits = await gh(`repos/${CHAINOPS}/commits?per_page=10`);
      if (!commits?.length) throw new Error("commit listesi boş");
      const head = commits[0].sha;
      const prevHead = state.seen.chainopsHead;
      if (prevHead === head && state.seen.chainopsFiles) return;
      const tree = await gh(`repos/${CHAINOPS}/git/trees/${head}?recursive=1`);
      const files = (tree?.tree || []).filter((f) => f.type === "blob").map((f) => f.path);
      if (!files.length) throw new Error("dosya ağacı boş");
      state.seen.chainopsHead = head;
      const added = diffSet("chainopsFiles", files);

      const mainnet = files.filter(isMainnetOpsPath);
      if (mainnet.length) await readMainnetOps(head, mainnet);

      if (prevHead && prevHead !== head) {
        const fresh = [];
        for (const c of commits) { if (c.sha === prevHead) break; fresh.push(c); }
        // Her yeni commit'in gerçekten değiştirdiği dosyalar (ekleme, silme, düzenleme)
        const changed = new Set(added);
        for (const c of fresh.slice(0, 6)) {
          const d = await gh(`repos/${CHAINOPS}/commits/${c.sha}`).catch(() => null);
          for (const f of d?.files || []) changed.add(f.filename);
        }
        const list = [...changed];
        const nets = [...new Set(list.map(opsNetwork).filter(Boolean))];
        const msgs = fresh.slice(0, 6).map((c) => `• ${esc(c.commit.message.split("\n")[0])}`).join("\n");
        if (list.some(isMainnetOpsPath)) {
          if (!mainnet.length) notify(`${CHAINOPS}: ana ağ (L1 ID 1) dosyalarında değişiklik oldu:\n${msgs}\nhttps://github.com/${CHAINOPS}/commits`, { level: "hint" });
        } else {
          notify(`${CHAINOPS} güncellendi — <b>mainnet değil</b>${nets.length ? `, ağ: ${esc(nets.join(", "))}` : ""}:\n${msgs}\nhttps://github.com/${CHAINOPS}/commits`);
        }
      }
    },
  },
  {
    id: "org-repos", name: "GitHub giwa-io yeni depolar", everySec: 600,
    async run() {
      const repos = await gh("orgs/giwa-io/repos?per_page=100&sort=created");
      if (!Array.isArray(repos)) throw new Error("depo listesi alınamadı");
      const pushed = Object.fromEntries(repos.map((r) => [r.full_name, r.pushed_at]));
      const prevPushed = state.seen.orgPushed;
      state.seen.orgPushed = pushed;
      if (prevPushed) for (const [name, at] of Object.entries(pushed)) {
        // node ve chain-operations kendi izleyicilerinde dosya düzeyinde inceleniyor
        if (!prevPushed[name] || prevPushed[name] === at || name === "giwa-io/node" || name === CHAINOPS) continue;
        const commits = (await gh(`repos/${name}/commits?per_page=10&since=${encodeURIComponent(prevPushed[name])}`)) || [];
        const msgs = commits.map((c) => c.commit.message.split("\n")[0]);
        // Sadece mesajında açıkça mainnet geçenler; "deploy" gibi genel kelimeler ve testnet işleri ipucu sayılmaz
        const hot = msgs.filter((m) => /mainnet|메인넷/i.test(m) && !/sepolia|testnet|devnet/i.test(m));
        if (hot.length) fireOnce(`push:${name}:${at}`, `${esc(name)} deposunda mesajında "mainnet" geçen commit:\n${hot.map((m) => `• ${esc(m)}`).join("\n")}\nhttps://github.com/${name}/commits`, "hint");
        else if (msgs.length) notify(`${esc(name)} güncellendi:\n${msgs.slice(0, 5).map((m) => `• ${esc(m)}`).join("\n")}`);
      }
      const added = diffSet("orgRepos", repos.map((r) => r.full_name));
      for (const name of added) {
        const r = repos.find((x) => x.full_name === name);
        notify(`giwa-io yeni public depo açtı: <b>${esc(name)}</b>\n${esc(r?.description || "")}\n${r?.html_url}`);
      }
    },
  },
  {
    id: "registry", name: "Optimism superchain-registry + chainlist", everySec: 600,
    async run() {
      const q = encodeURIComponent("giwa repo:ethereum-optimism/superchain-registry repo:ethereum-lists/chains");
      const res = await gh(`search/issues?q=${q}&sort=created&order=desc&per_page=30`);
      const items = res?.items || [];
      const added = diffSet("registryItems", items.map((i) => i.html_url));
      for (const url of added) {
        const i = items.find((x) => x.html_url === url);
        notify(`Zincir kayıt deposunda GIWA geçen yeni ${i?.pull_request ? "PR" : "issue"}:\n<b>${esc(i?.title)}</b>\n${url}`);
      }
      const file = await gh("repos/ethereum-optimism/superchain-registry/contents/superchain/configs/mainnet/giwa.toml");
      ev().registry = !!file;
      if (file) fireOnce("registry:mainnet-toml", `Optimism superchain-registry'ye GIWA MAINNET config'i eklendi:\n${file.html_url}`);
    },
  },
  {
    id: "crtsh", name: "SSL sertifika logları (crt.sh)", everySec: 900,
    async run() {
      // crt.sh sık sık 502/503 veriyor; birkaç kez artan beklemeyle dene
      let rows = null, last = "";
      for (let i = 0; i < 3 && !rows; i++) {
        if (i) await sleep(15000 * i);
        try {
          const r = await http("https://crt.sh/?q=%25.giwa.io&output=json", { headers: { "User-Agent": "giwa-mainnet-watch" } }, 60000);
          if (!r.ok) { last = `HTTP ${r.status}`; continue; }
          rows = await r.json();
        } catch (e) { last = e.message; }
      }
      if (!rows) throw new Error(`crt.sh ${last}`);
      const names = [...new Set(rows.flatMap((x) => String(x.name_value).split("\n")).map((s) => s.trim().toLowerCase()).filter((s) => s.endsWith("giwa.io")))].sort();
      for (const n of names) if (!n.startsWith("*")) addRpcCandidate(`https://${n}`);
      const added = diffSet("certNames", names);
      if (added.length) {
        const hot = added.filter((n) => /mainnet|rpc|sequencer|explorer|bridge/.test(n) && !/sepolia|testnet/.test(n));
        notify(`giwa.io için yeni SSL sertifikası alınan alan adları:\n${added.slice(0, 20).map((n) => `• <code>${esc(n)}</code>`).join("\n")}`);
        for (const n of hot) fireOnce(`crt:${n}`, `Mainnet'e işaret edebilecek yeni sertifika: <code>${esc(n)}</code>\nRPC izleyicisi bu adresi zincir testinden geçirecek.`, "hint");
      }
    },
  },
  {
    id: "l1", name: "Ethereum L1 (batcher + köprü)", everySec: 300,
    async run() {
      const nonce = parseInt(await rpc(ETH_RPC, "eth_getTransactionCount", [SEPOLIA_BATCHER, "latest"]), 16);
      const prev = state.seen.batcherNonce;
      state.seen.batcherNonce = nonce;
      if (prev !== undefined && nonce > prev) fireOnce(`l1:batcher:${nonce > 0}`, `GIWA Sepolia batcher adresi Ethereum ANA AĞINDA işlem yaptı:\n<code>${SEPOLIA_BATCHER}</code>\nnonce ${prev} → ${nonce}\nhttps://etherscan.io/address/${SEPOLIA_BATCHER}`, "hint");

      // Resmi config'ten gelen kontrat adresleri Ethereum ana ağında gerçekten var mı
      const o = ev().official || {};
      const targets = { OptimismPortal: o.portal, SystemConfig: o.systemConfig };
      const code = (ev().l1Code ??= {});
      for (const [name, addr] of Object.entries(targets)) {
        if (!addr) continue;
        const c = await rpc(ETH_RPC, "eth_getCode", [addr, "latest"]);
        code[name] = !!c && c !== "0x";
      }

      // chain-operations'taki ana ağ (L1 chain ID 1) işlem hash'leri Ethereum'da onaylı mı
      const txs = ev().l1Txs || [];
      if (txs.length) {
        let okCount = 0;
        for (const h of txs) {
          const rc = await rpc(ETH_RPC, "eth_getTransactionReceipt", [h]).catch(() => null);
          if (rc?.status === "0x1") okCount++;
        }
        ev().l1TxOk = okCount;
      }
    },
  },
  {
    id: "upbit", name: "Upbit duyuruları (GIWA/기와)", everySec: 120, quiet: true, // Upbit bazı sunucu IP'lerini engelliyor; hata bildirimi atma
    async run() {
      const headers = {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36",
        "Accept": "application/json, text/plain, */*",
        "Accept-Language": "ko-KR,ko;q=0.9,en;q=0.8",
        "Origin": "https://upbit.com",
        "Referer": "https://upbit.com/service_center/notice",
      };
      let j = null; const tried = [];
      for (const url of UPBIT_NOTICE_URLS) {
        const tag = new URL(url).pathname.split("/").pop() + "?" + new URL(url).searchParams.get("per_page");
        try {
          const r = await http(url, { headers });
          if (!r.ok) { tried.push(`${tag}=HTTP ${r.status}${r.headers.get("server") ? "/" + r.headers.get("server") : ""}`); continue; }
          j = await r.json(); break;
        } catch (e) { tried.push(`${tag}=${e.message}`); }
      }
      if (!j) throw new Error(`Upbit duyuruları alınamadı (${tried.join(", ")})`);
      const notices = [];
      (function walk(o) { if (Array.isArray(o)) o.forEach(walk); else if (o && typeof o === "object") { if (typeof o.title === "string") notices.push(o); else Object.values(o).forEach(walk); } })(j);
      if (!notices.length) throw new Error("Upbit duyuru listesi okunamadı (format değişmiş olabilir)");
      const giwa = notices.filter((n) => GIWA_WORDS.test(n.title));
      const added = diffSet("upbitGiwa", giwa.map((n) => String(n.id ?? n.title)));
      for (const key of added) {
        const n = giwa.find((x) => String(x.id ?? x.title) === key);
        const link = n.id ? `https://upbit.com/service_center/notice?id=${n.id}` : "https://upbit.com/service_center/notice";
        const isLaunch = /메인넷|mainnet|출시|오픈|런칭|launch/i.test(n.title);
        if (isLaunch) ev().upbitMainnet = n.title;
        fireOnce(`upbit:${key}`, `Upbit'te GIWA geçen YENİ resmi duyuru:\n<b>${esc(n.title)}</b>\n${link}`, isLaunch ? "strong" : "hint");
      }
    },
  },
  {
    id: "docs-index", name: "docs.giwa.io sayfa listesi", everySec: 300,
    async run() {
      const r = await http(DOCS_INDEX_URL, { headers: { "User-Agent": "giwa-mainnet-watch" } });
      if (!r.ok) throw new Error(`llms.txt HTTP ${r.status}`);
      const body = await r.text();
      const abs = [...body.matchAll(/https:\/\/docs\.giwa\.io\/[^\s)"'<>]+/g)].map((m) => m[0]);
      const rel = [...body.matchAll(/\]\((\/[^\s)"'<>]+)\)/g)].map((m) => "https://docs.giwa.io" + m[1]);
      const urls = [...new Set([...abs, ...rel])].filter((u) => !u.endsWith("llms.txt"));
      if (!urls.length) throw new Error("doküman listesi boş");
      const added = diffSet("docsPages", urls);
      if (!added.length) return;
      const hot = added.filter((u) => /mainnet/i.test(u));
      for (const u of hot) fireOnce(`docsidx:${u}`, `Resmi dokümana MAINNET sayfası eklendi:\n${u}`);
      const rest = added.filter((u) => !hot.includes(u));
      if (rest.length) notify(`docs.giwa.io yeni sayfalar:\n${rest.slice(0, 10).map((u) => `• ${u}`).join("\n")}`);
    },
  },
  {
    id: "providers", name: "RPC sağlayıcıları (Alchemy)", everySec: 600,
    async run() {
      for (const url of PROVIDER_PROBES) {
        let sig;
        try {
          const r = await http(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }) }, 15000);
          sig = `${r.status}:${(await r.text()).slice(0, 120).replace(/\s+/g, " ")}`;
        } catch (e) { sig = `ERR:${e.cause?.code || e.name}`; }
        const key = `prov:${url}`;
        const prev = state.seen[key];
        state.seen[key] = sig;
        if (prev && prev !== sig) notify(`RPC sağlayıcı adresinin cevabı DEĞİŞTİ — ağ sağlayıcıya eklenmiş olabilir:\n<code>${esc(url.replace("/v2/probe", ""))}</code>\nÖnce: ${esc(prev)}\nŞimdi: ${esc(sig)}`);
      }
    },
  },
];

// Bulunan bir RPC'nin gerçekten Ethereum ana ağına bağlı bir OP Stack zinciri olduğunu kontrol eder
async function verifyRpc(url, id) {
  const lines = []; let score = 0; const total = 5;
  const ok = (cond, yes, no) => { if (cond) score++; lines.push((cond ? "✅ " : "❌ ") + (cond ? yes : no)); };
  // 1) Alan adı resmi mi
  ok(/^https:\/\/[a-z0-9.-]+\.giwa\.io$/i.test(url), "Alan adı resmi giwa.io altında", "Alan adı giwa.io değil!");
  // 2) OP Stack predeploy kontratları var mı
  let isOp = false;
  try {
    const [a, b] = await Promise.all([rpc(url, "eth_getCode", [L1BLOCK, "latest"]), rpc(url, "eth_getCode", [L2_TO_L1_PASSER, "latest"])]);
    isOp = a?.length > 2 && b?.length > 2;
  } catch {}
  ok(isOp, "OP Stack sistem kontratları mevcut", "OP Stack sistem kontratları yok — GIWA olamaz");
  // 3) L1Block kontratı Ethereum ANA AĞINI mı takip ediyor (hash birebir eşleşmeli)
  let anchored = false, l1n = null;
  try {
    l1n = parseInt(await rpc(url, "eth_call", [{ to: L1BLOCK, data: "0x8381f58a" }, "latest"]), 16);
    const l1h = (await rpc(url, "eth_call", [{ to: L1BLOCK, data: "0x09bd5a60" }, "latest"]))?.toLowerCase();
    const real = await rpc(ETH_RPC, "eth_getBlockByNumber", ["0x" + l1n.toString(16), false]);
    anchored = !!real && real.hash?.toLowerCase() === l1h;
  } catch {}
  ok(anchored, `Ethereum ana ağına bağlı (L1 blok ${l1n} hash'i birebir eşleşiyor)`, `Ethereum ana ağı hash'i eşleşmedi${l1n ? ` (L1 blok ${l1n})` : ""} — testnet ya da sahte zincir olabilir`);
  // 4) Zincir üretiyor mu (blok ilerliyor mu)
  let moving = false, b1 = null;
  try {
    b1 = parseInt(await rpc(url, "eth_blockNumber"), 16);
    await sleep(4000);
    moving = parseInt(await rpc(url, "eth_blockNumber"), 16) > b1;
  } catch {}
  ok(moving, `Blok üretiyor (şu an ${b1})`, `Blok ilerlemiyor${b1 !== null ? ` (blok ${b1})` : ""}`);
  // 5) Resmi config ile chain ID
  const known = state.seen.mainnetChainId;
  if (known) ok(known === id, "Chain ID GitHub'daki resmi config ile eşleşiyor", `Chain ID resmi config'teki ${known} ile EŞLEŞMİYOR`);
  else lines.push("➖ GitHub'da henüz resmi config yok, chain ID çapraz kontrolü bekliyor");
  const full = /\.giwa\.io$/i.test(new URL(url).hostname) && isOp && anchored && moving;
  return { score, total: known ? total : total - 1, lines, full };
}

// Keşfedilen giwa.io adreslerini RPC izleyicisine ekler (testnet ve web sayfaları hariç)
function addRpcCandidate(url) {
  const u = url.toLowerCase().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+\.giwa\.io$/.test(u)) return;
  if (/sepolia|testnet|docs\.|www\.|snapshot|playground|faucet/.test(u)) return;
  state.seen.extraRpc ??= [];
  if (!state.seen.extraRpc.includes(u) && !RPC_CANDIDATES.includes(u)) state.seen.extraRpc.push(u);
}

// chain-operations dosya yolundan ağ bilgisini çıkarır
function opsL1Id(p) {
  const seg = p.split("/").find((s) => /^\d+$/.test(s));
  return seg ? Number(seg) : null;
}
function opsNetwork(p) {
  const id = opsL1Id(p);
  if (id === 1) return "Ethereum ana ağı (L1 ID 1)";
  if (id === 11155111) return "Sepolia testnet (L1 ID 11155111)";
  if (id) return `L1 ID ${id}`;
  return null;
}
function isMainnetOpsPath(p) {
  const top = p.split("/")[0];
  if (!p.includes("/") || /^(\.github|resources)$/.test(top)) return false;
  const id = opsL1Id(p);
  if (id === 1) return true;           // Ethereum ana ağında yürütülen iş — en kesin işaret
  if (id) return false;                 // başka bir L1 (Sepolia vb.)
  return /mainnet/i.test(top);          // L1 klasörü olmayan mainnet/ altındaki dosyalar (README vb.)
}
// Ana ağ operasyon dosyalarından resmi adresleri, chain ID'yi ve işlem hash'lerini okur
async function readMainnetOps(sha, files) {
  state.seen.chainopsRead ??= {};
  const ops = [...new Set(files.map((f) => f.split("/").slice(0, 2).join("/")))];
  const txs = new Set(ev().l1Txs || []);
  for (const f of files.filter((x) => x.endsWith(".json"))) {
    if (state.seen.chainopsRead[f]) continue;
    let j;
    try {
      const r = await http(`https://raw.githubusercontent.com/${CHAINOPS}/${sha}/${encodeURI(f)}`);
      if (!r.ok) continue;
      j = await r.json();
    } catch { continue; }
    state.seen.chainopsRead[f] = true;
    if (/deploy-config\.json$/.test(f) && j.l1ChainID === 1 && j.l2ChainID) setOfficial(`chain-operations ${f.split("/")[1]}`, { l2ChainId: Number(j.l2ChainID) });
    if (/l1-contracts\.json$/.test(f) && j.opChainDeployment) {
      setOfficial(`chain-operations ${f.split("/")[1]}`, {
        portal: j.opChainDeployment.optimismPortalProxyAddress,
        systemConfig: j.opChainDeployment.systemConfigProxyAddress,
      });
    }
    for (const t of j.transactions || []) if (/^0x[0-9a-f]{64}$/i.test(t.hash || "") && txs.size < 30) txs.add(t.hash.toLowerCase());
  }
  ev().l1Txs = [...txs];
  // Dosyalar okunduktan sonra haber ver ki mesajdaki kesinlik tablosu dolu olsun.
  // Ethereum'daki kontrat/işlem kontrolü L1 izleyicisinde yapılır; sonuç ayrıca bildirilir.
  for (const op of ops) fireOnce(`chainops:op:${op}`, `GIWA, ${CHAINOPS} deposuna <b>Ethereum ana ağı</b> için operasyon kaydı ekledi:\n<code>${esc(op)}</code>\nhttps://github.com/${CHAINOPS}/tree/${sha}/${encodeURI(op)}\n\nKontratlar ve işlemler birkaç dakika içinde Ethereum'da kontrol edilecek.`);
}

async function describeRollup(sha, file) {
  try {
    const r = await http(`https://raw.githubusercontent.com/giwa-io/node/${sha}/${file}`);
    const j = await r.json();
    if (j.l1_chain_id !== 1) return `\nL1 chain ID: ${j.l1_chain_id} (Ethereum ana ağı değil)`;
    setOfficial(`giwa-io/node ${file}`, { l2ChainId: j.l2_chain_id, portal: j.deposit_contract_address, systemConfig: j.l1_system_config_address });
    return `\n\n<b>Resmi mainnet Chain ID: ${j.l2_chain_id}</b>\nKöprü (OptimismPortal): <code>${j.deposit_contract_address}</code>\nBatch inbox: <code>${j.batch_inbox_address}</code>\nGenesis L1 blok: ${j.genesis?.l1?.number}`;
  } catch (e) {
    return `\n(rollup dosyası okunamadı: ${esc(e.message)})`;
  }
}

// ---------- zamanlayıcı ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runWatcher(w, opts = {}) {
  state.errStreak ??= {};
  try {
    await w.run(opts);
    reassess();
    if (state.errStreak[w.id] >= 10) notify(`✅ "${w.name}" izleyicisi tekrar çalışıyor.`);
    state.health[w.id] = { ok: true, at: Date.now() };
    state.errStreak[w.id] = 0;
  } catch (e) {
    state.health[w.id] = { ok: false, at: Date.now(), err: e.message };
    state.errStreak[w.id] = (state.errStreak[w.id] || 0) + 1;
    console.error(`[${w.id}]`, e.message);
    // Kısa kesintileri sessiz geç; 10 kez üst üste düşerse haber ver
    if (state.errStreak[w.id] === 10 && !w.quiet) notify(`"${w.name}" izleyicisi 10 kez üst üste hata verdi: ${esc(e.message)}`);
  }
  saveState();
}
function loop(w) {
  const tick = async () => { await runWatcher(w); setTimeout(tick, (w.everySec * 1000) / SPEED); };
  tick();
}
function heartbeat() {
  setInterval(() => {
    const now = new Date(Date.now() + TZ * 3600e3);
    const day = now.toISOString().slice(0, 10);
    if (now.getUTCHours() === 9 && state.lastBeat !== day) {
      state.lastBeat = day; saveState();
      // Tek seferlik kesintiler rapora girmesin: en az 3 kez üst üste düşenleri, nedeniyle birlikte göster
      const broken = WATCHERS.filter((w) => state.health[w.id] && !state.health[w.id].ok && (state.errStreak?.[w.id] || 0) >= 3)
        .map((w) => `${w.name} — ${esc(String(state.health[w.id].err || "").slice(0, 160))}`);
      notify(`Günlük kontrol: bot çalışıyor.\n${assess().verdict}${broken.length ? `\nHata veren izleyiciler:\n${broken.map((b) => "• " + b).join("\n")}` : ""}`);
    }
  }, 60e3);
}

// Kişisel asistan için salt okunur durum uç noktası: GET /status?key=STATUS_KEY
function statusServer() {
  const key = process.env.STATUS_KEY;
  const port = Number(process.env.PORT);
  if (!key || !port) return;
  createServer((req, res) => {
    const u = new URL(req.url, "http://x");
    if (u.pathname !== "/status" || u.searchParams.get("key") !== key) {
      res.writeHead(404).end();
      return;
    }
    const a = assess();
    const strip = (t) => String(t).replace(/<[^>]+>/g, "");
    const health = Object.fromEntries(
      WATCHERS.map((w) => [w.name, state.health[w.id] ? (state.health[w.id].ok ? "ok" : "hata") : "bekliyor"]),
    );
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({
      level: a.level,
      verdict: strip(a.verdict),
      checks: a.lines.map(strip),
      recent: (state.recent || []).slice(-10),
      health,
      at: Date.now(),
    }));
  }).listen(port, () => console.log(`Durum uç noktası açık (port ${port})`));
}

async function main() {
  loadState(); saveState();
  const me = await tg("getMe", {});
  console.log(`Bot: @${me.username}. Sohbet: ${state.chatId || "henüz yok — bota /start yaz"}`);
  pollTelegram();
  for (const w of WATCHERS) if (!w.enabled || w.enabled()) loop(w); else console.log(`[${w.id}] kapalı (değişken yok)`);
  heartbeat();
  statusServer();
  if (state.chatId) notify("Bot başladı, izleme açık. /status ile durumu görebilirsin.");
}
main().catch((e) => { console.error(e); process.exit(1); });
