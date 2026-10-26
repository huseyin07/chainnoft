// GIWA Mainnet Watch — Telegram bildirim botu
// Bağımlılık yok. Node 20+ gerekir (yerleşik fetch).
//
// Ortam değişkenleri:
//   TELEGRAM_BOT_TOKEN  (zorunlu)  BotFather'ın verdiği token
//   TELEGRAM_CHAT_ID    (isteğe bağlı) Boşsa bota ilk /start yazan sohbet kaydedilir
//   GITHUB_TOKEN        (önerilir)  Yetkisiz public okuma token'ı; GitHub limitine takılmamak için
//   ETH_RPC_URL         (isteğe bağlı) Ethereum ana ağı RPC (Alchemy/Infura) — L1 sinyalleri için
//   DATA_DIR            (isteğe bağlı) Durum dosyasının klasörü. Railway'de Volume'u /data'ya bağla.
//   TZ_OFFSET_HOURS     (isteğe bağlı) Günlük "hayattayım" mesajı saati için, varsayılan 3 (İstanbul)

import fs from "node:fs";
import path from "node:path";
import dns from "node:dns/promises";

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!TOKEN) {
  console.error("TELEGRAM_BOT_TOKEN tanımlı değil.");
  process.exit(1);
}
const GH_TOKEN = process.env.GITHUB_TOKEN || "";
const ETH_RPC = process.env.ETH_RPC_URL || "";
const DATA_DIR = process.env.DATA_DIR || "./data";
const TZ = Number(process.env.TZ_OFFSET_HOURS ?? 3);
const STATE_FILE = path.join(DATA_DIR, "state.json");
const SPEED = Number(process.env.SPEED || 1); // sadece test için

const SEPOLIA_CHAIN_ID = 91342;
const SEPOLIA_BATCHER = "0x1caaaa58002a7e8b4c6f427ac2c943767b4d6cd7"; // giwa-io/node sepolia-rollup.json
const DOCS_URL = "https://docs.giwa.io/giwa-chain/en/get-started/connect-to-giwa.md";
const DOCS_DEV_TEXT = "GIWA Mainnet is currently under development";

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
function notify(text, { critical = false } = {}) {
  const msg = (critical ? "🚨🚨 <b>GIWA MAINNET SİNYALİ</b>\n\n" : "🔔 ") + text + (critical ? SAFETY : "");
  console.log("[notify]", msg.replace(/<[^>]+>/g, ""));
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
          await tg("sendMessage", { chat_id: chat, text: "✅ Kayıt tamam. GIWA mainnet sinyallerini bu sohbete göndereceğim.\n\n/status — izleyicilerin durumu\n/test — deneme bildirimi" });
          flush();
          continue;
        }
        if (chat !== String(state.chatId)) continue; // yabancı sohbetleri yok say
        if (cmd === "/start") await tg("sendMessage", { chat_id: chat, text: "Zaten kayıtlısın. /status yaz." });
        else if (cmd === "/status") await tg("sendMessage", { chat_id: chat, text: statusText(), parse_mode: "HTML" });
        else if (cmd === "/test") notify("Test bildirimi — bot çalışıyor.");
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
  const fired = Object.keys(state.fired);
  lines.push(fired.length ? `\nTetiklenen kritik sinyaller: ${fired.length}` : "\nKritik sinyal yok — mainnet izleri görünmedi.");
  return lines.join("\n");
}

// Kritik alarm: koşul doğru olduğu sürece bir kez gönderilir
function fireOnce(key, text) {
  if (state.fired[key]) return;
  state.fired[key] = Date.now();
  notify(text, { critical: true });
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
    async run() {
      for (const url of RPC_CANDIDATES) {
        let id;
        try { id = parseInt(await rpc(url, "eth_chainId"), 16); } catch { continue; }
        if (!Number.isFinite(id) || id === SEPOLIA_CHAIN_ID) continue;
        let block = "?";
        try { block = parseInt(await rpc(url, "eth_blockNumber"), 16); } catch {}
        const known = state.seen.mainnetChainId;
        const match = known ? (known === id ? "✅ GitHub'daki resmi config ile EŞLEŞİYOR" : `❌ GitHub config'teki chain ID ${known} ile EŞLEŞMİYOR — dikkat!`) : "ℹ️ GitHub'da henüz resmi config yok, çapraz kontrol yapılamadı";
        fireOnce(`rpc:${url}:${id}`, `Resmi alan adında RPC cevap veriyor:\n<code>${url}</code>\nChain ID: <b>${id}</b>\nBlok: ${block}\n${match}`);
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
      const firstRun = !state.seen.dnsLive;
      const added = diffSet("dnsLive", live);
      if (firstRun) return; // bot başlarken zaten var olanlar sinyal değil
      for (const host of added) fireOnce(`dns:${host}`, `Yeni alt alan adı çözülmeye başladı: <code>${host}</code>\n\nBu genelde servisin hazırlandığını gösterir; henüz canlı olmayabilir.`);
    },
  },
  {
    id: "docs", name: "Resmi doküman (Connect to GIWA)", everySec: 120,
    async run() {
      const r = await http(DOCS_URL, { headers: { "User-Agent": "giwa-mainnet-watch" } });
      if (!r.ok) throw new Error(`docs HTTP ${r.status}`);
      const text = await r.text();
      if (text.length < 200) throw new Error("docs içeriği beklenenden kısa");
      if (!text.includes(DOCS_DEV_TEXT)) fireOnce("docs:dev-text-gone", `docs.giwa.io sayfasında "Mainnet geliştiriliyor" yazısı KALDIRILDI.\n${DOCS_URL.replace(".md", "")}`);
      const ids = [...text.matchAll(/Chain ID[^0-9]{0,80}?(\d{3,12})/gi)].map((m) => Number(m[1])).filter((n) => n !== SEPOLIA_CHAIN_ID);
      for (const id of new Set(ids)) fireOnce(`docs:chainid:${id}`, `Resmi dokümanda yeni Chain ID göründü: <b>${id}</b>\n${DOCS_URL.replace(".md", "")}`);
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
    id: "org-repos", name: "GitHub giwa-io yeni depolar", everySec: 600,
    async run() {
      const repos = await gh("orgs/giwa-io/repos?per_page=100&sort=created");
      if (!Array.isArray(repos)) throw new Error("depo listesi alınamadı");
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
      if (file) fireOnce("registry:mainnet-toml", `Optimism superchain-registry'ye GIWA MAINNET config'i eklendi:\n${file.html_url}`);
    },
  },
  {
    id: "crtsh", name: "SSL sertifika logları (crt.sh)", everySec: 900,
    async run() {
      const r = await http("https://crt.sh/?q=%25.giwa.io&output=json", { headers: { "User-Agent": "giwa-mainnet-watch" } }, 60000);
      if (!r.ok) throw new Error(`crt.sh HTTP ${r.status}`);
      const rows = await r.json();
      const names = [...new Set(rows.flatMap((x) => String(x.name_value).split("\n")).map((s) => s.trim().toLowerCase()).filter((s) => s.endsWith("giwa.io")))].sort();
      const added = diffSet("certNames", names);
      if (added.length) {
        const hot = added.filter((n) => /mainnet|rpc|sequencer|explorer|bridge/.test(n) && !/sepolia|testnet/.test(n));
        notify(`giwa.io için yeni SSL sertifikası alınan alan adları:\n${added.slice(0, 20).map((n) => `• <code>${esc(n)}</code>`).join("\n")}`);
        for (const n of hot) fireOnce(`crt:${n}`, `Mainnet'e işaret eden yeni sertifika: <code>${esc(n)}</code>\nDNS ve RPC izleyicileri bu adresi zaten deneyecek.`);
      }
    },
  },
  {
    id: "l1", name: "Ethereum L1 (batcher + köprü)", everySec: 300, enabled: () => !!ETH_RPC,
    async run() {
      const nonce = parseInt(await rpc(ETH_RPC, "eth_getTransactionCount", [SEPOLIA_BATCHER, "latest"]), 16);
      const prev = state.seen.batcherNonce;
      state.seen.batcherNonce = nonce;
      if (prev !== undefined && nonce > prev) fireOnce(`l1:batcher:${nonce > 0}`, `GIWA Sepolia batcher adresi Ethereum ANA AĞINDA işlem yapmaya başladı:\n<code>${SEPOLIA_BATCHER}</code>\nnonce ${prev} → ${nonce}\nhttps://etherscan.io/address/${SEPOLIA_BATCHER}`);
      const portal = state.seen.mainnetPortal;
      if (portal) {
        const code = await rpc(ETH_RPC, "eth_getCode", [portal, "latest"]);
        if (code && code !== "0x") fireOnce(`l1:portal:${portal}`, `Resmi config'teki GIWA köprü (OptimismPortal) kontratı Ethereum ana ağında DEPLOY EDİLMİŞ:\nhttps://etherscan.io/address/${portal}`);
      }
    },
  },
];

async function describeRollup(sha, file) {
  try {
    const r = await http(`https://raw.githubusercontent.com/giwa-io/node/${sha}/${file}`);
    const j = await r.json();
    if (j.l1_chain_id !== 1) return `\nL1 chain ID: ${j.l1_chain_id} (Ethereum ana ağı değil)`;
    state.seen.mainnetChainId = j.l2_chain_id;
    state.seen.mainnetPortal = j.deposit_contract_address;
    return `\n\n<b>Resmi mainnet Chain ID: ${j.l2_chain_id}</b>\nKöprü (OptimismPortal): <code>${j.deposit_contract_address}</code>\nBatch inbox: <code>${j.batch_inbox_address}</code>\nGenesis L1 blok: ${j.genesis?.l1?.number}`;
  } catch (e) {
    return `\n(rollup dosyası okunamadı: ${esc(e.message)})`;
  }
}

// ---------- zamanlayıcı ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function runWatcher(w) {
  state.errStreak ??= {};
  try {
    await w.run();
    if (state.errStreak[w.id] >= 10) notify(`✅ "${w.name}" izleyicisi tekrar çalışıyor.`);
    state.health[w.id] = { ok: true, at: Date.now() };
    state.errStreak[w.id] = 0;
  } catch (e) {
    state.health[w.id] = { ok: false, at: Date.now(), err: e.message };
    state.errStreak[w.id] = (state.errStreak[w.id] || 0) + 1;
    console.error(`[${w.id}]`, e.message);
    // Kısa kesintileri sessiz geç; 10 kez üst üste düşerse haber ver
    if (state.errStreak[w.id] === 10) notify(`"${w.name}" izleyicisi 10 kez üst üste hata verdi: ${esc(e.message)}`);
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
      const broken = WATCHERS.filter((w) => state.health[w.id] && !state.health[w.id].ok).map((w) => w.name);
      notify(`Günlük kontrol: bot çalışıyor. ${Object.keys(state.fired).length ? "" : "Mainnet izi yok."}${broken.length ? `\nHata veren izleyiciler: ${broken.join(", ")}` : ""}`);
    }
  }, 60e3);
}

async function main() {
  loadState(); saveState();
  const me = await tg("getMe", {});
  console.log(`Bot: @${me.username}. Sohbet: ${state.chatId || "henüz yok — bota /start yaz"}`);
  pollTelegram();
  for (const w of WATCHERS) if (!w.enabled || w.enabled()) loop(w); else console.log(`[${w.id}] kapalı (değişken yok)`);
  heartbeat();
  if (state.chatId) notify("Bot başladı, izleme açık. /status ile durumu görebilirsin.");
}
main().catch((e) => { console.error(e); process.exit(1); });
