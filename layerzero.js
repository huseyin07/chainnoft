// LayerZero "Zero" ağı izleyicisi — GIWA botunun içinde, ondan bağımsız çalışır.
//
// İzolasyon kuralları:
//   • Kendi durum dosyası (DATA_DIR/lz-state.json) — GIWA'nın state.json'una dokunmaz
//   • Her izleyici kendi try/catch'inde; hiçbir hata dışarı sızmaz
//   • GIWA'nın izleyici listesine, kesinlik tablosuna, günlük raporuna karışmaz
//   • Sadece okur; hiçbir işlem göndermez, cüzdan kullanmaz
//   • LZ_WATCH=0 ile tamamen kapatılır
//
// Ortam değişkenleri (hepsi isteğe bağlı):
//   LZ_WATCH        0 ise modül hiç başlamaz
//   ARB_RPC_URL     Arbitrum RPC (varsayılan publicnode)
//   BASE_RPC_URL    Base RPC (varsayılan publicnode)

import fs from "node:fs";
import path from "node:path";

const ZRO = "0x6985884c4392d348587b19cb9eaaf157f13271cd"; // Ethereum, Arbitrum, Base'de aynı adres
const SEL_PEERS = "0xbb0b6a53";                              // peers(uint32)
const TOPIC_PEERSET = "0x238399d427b947898edb290f5ff0f9109849b1c3ba196a42e35f00c50a54b98b"; // PeerSet(uint32,bytes32)
// npm @layerzerolabs/lz-definitions 3.1.20'den beri: ZEROINTEROP_V2_MAINNET = 33002 (EVM zinciri olarak tanımlı)
const DEFAULT_ZERO_EIDS = [33002];
const METADATA_URL = "https://metadata.layerzero-api.com/v1/metadata";
const NPM_PKG = "@layerzerolabs/lz-definitions";
const DOCS_CHAIN = "https://docs.layerzero.network/chain.md";
const DOCS_INDEX = "https://docs.layerzero.network/llms.txt";
const CRT_DOMAINS = ["layerzero.network", "layerzero-api.com"];
const ZERO_WORDS = /zero(?!-?knowledge)|atlas|zone/i;
const SAFETY = "\n\n⚠️ Resmi kaynaklar: layerzero.network, docs.layerzero.network, github.com/LayerZero-Labs, @LayerZero_Core. Bot işlem yapmaz; yeni bir ağa girersen sadece kaybetmeyi göze aldığın küçük bir miktarla gir.";

const HEAD = {
  info: "🟣 <b>LayerZero</b> · ",
  hint: "🟣🔎 <b>LayerZero — İpucu, doğrulanmadı</b>\n\n",
  strong: "🟣🟠 <b>LayerZero ZERO — GÜÇLÜ SİNYAL</b>\n\n",
  confirmed: "🟣🚨 <b>ZERO AĞI CANLI — ZİNCİR ÜSTÜNDE DOĞRULANDI</b>\n\n",
};

export function startLayerZero(ctx) {
  const { http, gh, send, esc, dataDir, ethRpc } = ctx;
  const CHAINS = [
    { name: "Ethereum", loc: "Ethereum'daki", rpc: ethRpc, selfEid: 30110 },   // self-test: Ethereum'daki ZRO'nun Arbitrum peer'ı dolu olmalı
    { name: "Arbitrum", loc: "Arbitrum'daki", rpc: process.env.ARB_RPC_URL || "https://arbitrum-one-rpc.publicnode.com", selfEid: 30101 },
    { name: "Base", loc: "Base'deki", rpc: process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com", selfEid: 30101 },
  ];
  const FILE = path.join(dataDir, "lz-state.json");
  let S = {};
  try { S = JSON.parse(fs.readFileSync(FILE, "utf8")); } catch { S = {}; }
  S.seen ??= {}; S.fired ??= {}; S.health ??= {}; S.facts ??= {};
  S.zeroEids ??= [...DEFAULT_ZERO_EIDS];
  const save = () => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(FILE + ".tmp", JSON.stringify(S, null, 2));
      fs.renameSync(FILE + ".tmp", FILE);
    } catch (e) { console.error("[lz] durum kaydedilemedi:", e.message); }
  };

  const notify = (text, level = "info") => {
    let msg = (HEAD[level] || HEAD.info) + text;
    if (level === "strong" || level === "confirmed") msg += "\n\n" + factsText() + SAFETY;
    else if (level === "hint") msg += "\n\n<i>Tek başına ağın açıldığı anlamına gelmez. Durum için /lz</i>";
    try { send(msg); } catch (e) { console.error("[lz] gönderim:", e.message); }
  };
  const fireOnce = (key, text, level = "strong") => {
    if (S.fired[key]) return;
    S.fired[key] = Date.now();
    notify(text, level);
  };
  const diffSet = (key, current) => {
    const prev = S.seen[key];
    S.seen[key] = current;
    if (!prev) return [];
    const p = new Set(prev);
    return current.filter((x) => !p.has(x));
  };

  async function rpc(url, method, params = []) {
    const r = await http(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    }, 15000);
    if (!r.ok) throw new Error(`RPC HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    return j.result;
  }
  const eidHex = (eid) => eid.toString(16).padStart(64, "0");
  const isZero = (h) => !h || /^0x0*$/.test(h);
  const addr = (b32) => "0x" + b32.slice(-40);
  const isZeroEid = (eid) => S.zeroEids.includes(eid) || (eid >= 33000 && eid < 34000);

  // ---------- kesinlik özeti ----------
  function factsText() {
    const f = S.facts; const lines = [];
    const row = (ok, t) => lines.push(`${ok === true ? "✅" : ok === false ? "❌" : "➖"} ${t}`);
    row(true, `npm'de Zero endpoint ID'si: <b>${S.zeroEids.join(", ")}</b> (EVM olarak tanımlı)`);
    const peers = f.peers || {};
    const set = Object.entries(peers).filter(([, v]) => v);
    row(set.length ? true : false, set.length ? `ZRO köprüsü Zero'ya bağlandı: ${set.map(([k, v]) => `${k} → <code>${v}</code>`).join(", ")}` : "ZRO kontratında Zero peer'ı yok (henüz ZRO gönderilemez)");
    row(f.metadata ? true : false, f.metadata ? `LayerZero metadata'da: <b>${esc(f.metadata.key)}</b>${f.metadata.chainId ? ` · chain ID ${f.metadata.chainId}` : ""}` : "LayerZero metadata API'sinde Zero kaydı yok");
    row(f.rpc?.live ? true : false, f.rpc?.live ? `Canlı RPC: <code>${esc(f.rpc.url)}</code> · chain ID ${f.rpc.chainId} · blok ${f.rpc.block}` : "Canlı Zero RPC bulunamadı");
    row(f.docs ? true : null, f.docs ? `Doküman zaman çizelgesi: ${esc(f.docs)}` : "Doküman zaman çizelgesi okunmadı");
    return `<b>Zero durumu:</b> ${verdict()}\n${lines.join("\n")}`;
  }
  function verdict() {
    const f = S.facts;
    if (f.rpc?.live && f.rpc.peerCode) return "🟢 Zero canlı ve ZRO köprüsü zincir üstünde doğrulandı";
    if (f.rpc?.live) return "🟠 Zero RPC canlı, köprü kontratı henüz doğrulanmadı";
    if (Object.values(f.peers || {}).some(Boolean)) return "🟠 ZRO köprüsü Zero'ya bağlandı — ağ açılıyor olabilir";
    if (f.metadata) return "🟡 Zero LayerZero altyapısına eklendi, canlı RPC yok";
    return "⚪ Zero'nun açıldığına dair zincir üstü iz yok";
  }

  // ---------- izleyiciler ----------
  const W = [
    {
      id: "peer", name: "ZRO kontratı — Zero peer (Ethereum/Arbitrum/Base)", every: 120,
      async run() {
        S.facts.peers ??= {};
        let verified = 0;
        for (const c of CHAINS) {
          // Self-test: bilinen bir peer'ı okuyabiliyor muyuz? Okuyamıyorsak "yok" demek yanıltıcı olur.
          const self = await rpc(c.rpc, "eth_call", [{ to: ZRO, data: SEL_PEERS + eidHex(c.selfEid) }, "latest"]);
          if (isZero(self)) throw new Error(`${c.name}: bilinen peer okunamadı, kontrol güvenilir değil`);
          verified++;
          for (const eid of S.zeroEids) {
            const p = await rpc(c.rpc, "eth_call", [{ to: ZRO, data: SEL_PEERS + eidHex(eid) }, "latest"]);
            const key = `${c.name}:${eid}`;
            if (!isZero(p)) {
              S.facts.peers[key] = addr(p);
              fireOnce(`peer:${key}:${p}`, `${c.loc} ZRO kontratına <b>Zero (EID ${eid})</b> için peer eklendi:\n<code>${addr(p)}</code>\n\nBu, ZRO'nun Zero'ya köprülenebileceği anlamına gelir. Zero RPC'si bulunursa bu adres zincir üstünde ayrıca doğrulanacak.`, "strong");
            } else S.facts.peers[key] = null;
          }
        }
        if (!verified) throw new Error("hiçbir zincir okunamadı");
      },
    },
    {
      id: "peerlog", name: "ZRO PeerSet olayları (Ethereum)", every: 300,
      async run() {
        const latest = parseInt(await rpc(ethRpc, "eth_blockNumber"), 16);
        const from = S.seen.peerlogBlock ? S.seen.peerlogBlock + 1 : latest - 50;
        if (from > latest) return;
        const to = Math.min(latest, from + 1999);
        const logs = await rpc(ethRpc, "eth_getLogs", [{ address: ZRO, topics: [TOPIC_PEERSET], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
        for (const l of logs || []) {
          const eid = parseInt(l.data.slice(2, 66), 16);
          const peer = addr("0x" + l.data.slice(66, 130));
          const zero = isZeroEid(eid);
          if (zero && !S.zeroEids.includes(eid)) S.zeroEids.push(eid);
          fireOnce(`peerlog:${l.transactionHash}:${eid}`, `ZRO kontratı yeni bir zincire bağlandı (Ethereum):\nEID <b>${eid}</b>${zero ? " — <b>Zero aralığında</b>" : ""}\nPeer: <code>${peer}</code>\nİşlem: https://etherscan.io/tx/${l.transactionHash}`, zero ? "strong" : "info");
        }
        S.seen.peerlogBlock = to;
      },
    },
    {
      id: "npm", name: "npm lz-definitions (yeni zincir tanımları)", every: 600,
      async run() {
        const r = await http(`https://registry.npmjs.org/${NPM_PKG}/latest`);
        if (!r.ok) throw new Error(`npm ${r.status}`);
        const ver = (await r.json()).version;
        if (S.seen.npmVer === ver && S.seen.npmNames) return;
        let dts = null;
        for (const u of [`https://cdn.jsdelivr.net/npm/${NPM_PKG}@${ver}/dist/index.d.ts`, `https://unpkg.com/${NPM_PKG}@${ver}/dist/index.d.ts`]) {
          try { const x = await http(u); if (x.ok) { dts = await x.text(); break; } } catch {}
        }
        if (!dts) throw new Error(`${ver} içeriği okunamadı`);
        const names = [...dts.matchAll(/([A-Z0-9_]+_V2_MAINNET) = (\d+)/g)].map((m) => `${m[1]}=${m[2]}`);
        if (!names.length) throw new Error("zincir listesi ayrıştırılamadı");
        for (const n of names) {
          const [k, v] = n.split("="); const eid = Number(v);
          if ((ZERO_WORDS.test(k) || (eid >= 33000 && eid < 34000)) && !S.zeroEids.includes(eid)) S.zeroEids.push(eid);
        }
        const added = diffSet("npmNames", [...new Set(names)]);
        S.seen.npmVer = ver;
        const zeroAdded = added.filter((n) => ZERO_WORDS.test(n) || /=33\d{3}$/.test(n));
        if (zeroAdded.length) notify(`npm <code>${NPM_PKG}@${esc(ver)}</code> sürümüne Zero ile ilgili yeni endpoint eklendi:\n${zeroAdded.map((n) => `• <code>${esc(n)}</code>`).join("\n")}`, "hint");
      },
    },
    {
      id: "metadata", name: "LayerZero metadata API", every: 600,
      async run() {
        const r = await http(METADATA_URL, {}, 60000);
        if (!r.ok) throw new Error(`metadata ${r.status}`);
        const j = await r.json();
        for (const [key, v] of Object.entries(j)) {
          const eids = (v?.deployments || []).map((d) => Number(d.eid)).filter(Boolean);
          if (!ZERO_WORDS.test(key) && !eids.some(isZeroEid)) continue;
          const mainnetEids = eids.filter((e) => e < 40000);
          if (/testnet|sandbox/i.test(key) || (eids.length && !mainnetEids.length)) {
            fireOnce(`meta:test:${key}`, `LayerZero metadata'sına Zero test zinciri eklendi: <b>${esc(key)}</b> (EID ${eids.join(", ")}). Mainnet değil.`, "info");
            continue;
          }
          const chainId = v?.chainDetails?.nativeChainId ?? null;
          const rpcs = (v?.rpcs || []).map((x) => x?.url).filter((u) => /^https:\/\//.test(u || ""));
          const ep = (v?.deployments || []).find((d) => d.endpointV2?.address)?.endpointV2?.address;
          S.facts.metadata = { key, chainId, eids: mainnetEids, rpcs, endpoint: ep || null };
          for (const e of mainnetEids) if (!S.zeroEids.includes(e)) S.zeroEids.push(e);
          S.seen.rpcCandidates = [...new Set([...(S.seen.rpcCandidates || []), ...rpcs])];
          fireOnce(`meta:${key}:${chainId}:${rpcs.join(",")}`, `LayerZero metadata API'sinde Zero kaydı:\nAnahtar: <b>${esc(key)}</b>\nEID: ${mainnetEids.join(", ") || "?"}\nChain ID: ${chainId ?? "?"}\nEndpointV2: <code>${esc(ep || "?")}</code>\nRPC: ${rpcs.length ? rpcs.map((u) => `<code>${esc(u)}</code>`).join(", ") : "yok"}\n\nRPC'ler her dakika denenecek.`, "strong");
        }
      },
    },
    {
      id: "rpc", name: "Zero RPC denemesi", every: 60,
      async run() {
        const list = S.seen.rpcCandidates || [];
        for (const url of list) {
          let id;
          try { id = parseInt(await rpc(url, "eth_chainId"), 16); } catch { continue; }
          const b1 = parseInt(await rpc(url, "eth_blockNumber"), 16);
          await new Promise((r) => setTimeout(r, 5000));
          const b2 = parseInt(await rpc(url, "eth_blockNumber"), 16);
          const want = S.facts.metadata?.chainId;
          const lines = [];
          const ok = (c, y, n) => lines.push(c ? "✅ " + y : "❌ " + n);
          ok(b2 > b1, `Blok üretiyor (${b2})`, `Blok ilerlemiyor (${b1})`);
          if (want) ok(Number(want) === id, `Chain ID metadata ile eşleşiyor (${id})`, `Chain ID ${id}, metadata ${want} diyor`);
          // Çapraz doğrulama: Ethereum'daki ZRO'nun Zero peer adresinde bu zincirde kontrat var mı
          const peer = Object.entries(S.facts.peers || {}).find(([k, v]) => v && k.startsWith("Ethereum"))?.[1];
          let peerCode = false;
          if (peer) {
            try { peerCode = ((await rpc(url, "eth_getCode", [peer, "latest"])) || "0x").length > 2; } catch {}
            ok(peerCode, `ZRO'nun Ethereum'daki Zero peer'ı (<code>${peer}</code>) bu zincirde gerçek kontrat`, `ZRO peer adresinde bu zincirde kod yok — yanlış zincir olabilir`);
          } else lines.push("➖ ZRO peer'ı henüz yok, köprü çapraz kontrolü bekliyor");
          const live = b2 > b1 && (!want || Number(want) === id);
          S.facts.rpc = { url, chainId: id, block: b2, live, peerCode };
          if (live && peerCode) fireOnce(`rpc:confirmed:${url}:${id}`, `Zero RPC canlı, metadata ile eşleşiyor ve ZRO köprü kontratı zincirde mevcut.\n\nRPC: <code>${esc(url)}</code> · Chain ID <b>${id}</b>\n${lines.join("\n")}`, "confirmed");
          else if (live) fireOnce(`rpc:live:${url}:${id}`, `Zero RPC cevap veriyor ve blok üretiyor.\n\nRPC: <code>${esc(url)}</code> · Chain ID <b>${id}</b>\n${lines.join("\n")}`, "strong");
        }
      },
    },
    {
      id: "docs", name: "Resmi doküman (Zero sayfası + sayfa listesi)", every: 300,
      async run() {
        const r = await http(DOCS_CHAIN);
        if (!r.ok) throw new Error(`docs ${r.status}`);
        const t = await r.text();
        const rows = [...t.matchAll(/^\|\s*\**(Testnet|Mainnet|Devnet|Beta)\**\s*\|\s*([^|]+)\|/gim)].map((m) => `${m[1]}: ${m[2].trim()}`);
        if (rows.length) {
          S.facts.docs = rows.join(" · ");
          const prev = S.seen.docsRows;
          S.seen.docsRows = S.facts.docs;
          if (prev && prev !== S.facts.docs) notify(`Zero doküman sayfasındaki zaman çizelgesi DEĞİŞTİ:\nÖnce: ${esc(prev)}\nŞimdi: <b>${esc(S.facts.docs)}</b>\n${DOCS_CHAIN.replace(".md", "")}`, "strong");
        }
        const urls = [/https:\/\/[^\s)]*(chain|zero|atlas)[^\s)]*/gi].flatMap((re) => t.match(re) || []);
        try {
          const ix = await http(DOCS_INDEX);
          if (ix.ok) {
            const pages = ((await ix.text()).match(/https:\/\/docs\.layerzero\.network\/[^\s)]+/g) || []).filter((u) => /zero|atlas|chain\/|zone/i.test(u));
            const added = diffSet("docsPages", [...new Set([...pages, ...urls])]);
            if (added.length) notify(`LayerZero dokümanına Zero/ATLAS ile ilgili yeni sayfa eklendi:\n${added.slice(0, 8).map((u) => "• " + esc(u)).join("\n")}`, "hint");
          }
        } catch {}
      },
    },
    {
      id: "github", name: "GitHub LayerZero-Labs yeni depolar", every: 600,
      async run() {
        const repos = await gh("orgs/LayerZero-Labs/repos?sort=created&direction=desc&per_page=40");
        if (!repos) throw new Error("org okunamadı");
        const added = diffSet("ghRepos", repos.map((r) => r.full_name));
        const hits = added.filter((n) => ZERO_WORDS.test(n));
        if (hits.length) notify(`LayerZero-Labs GitHub'ında Zero ile ilgili yeni public depo:\n${hits.map((n) => `• https://github.com/${esc(n)}`).join("\n")}`, "hint");
      },
    },
    {
      id: "crt", name: "SSL sertifikaları (crt.sh)", every: 1200, quiet: true,
      async run() {
        const names = [];
        for (const d of CRT_DOMAINS) {
          const r = await http(`https://crt.sh/?q=%25.${d}&output=json&exclude=expired`, {}, 60000);
          if (!r.ok) throw new Error(`crt.sh ${r.status}`);
          for (const c of await r.json()) for (const n of String(c.name_value || "").split("\n")) names.push(n.toLowerCase().replace(/^\*\./, ""));
        }
        const interesting = [...new Set(names)].filter((n) => ZERO_WORDS.test(n) || /(^|\.)(rpc|explorer|scan|bridge|mainnet)[.-]/.test(n));
        const added = diffSet("crt", interesting);
        if (added.length) {
          for (const n of added) if (/rpc/.test(n)) S.seen.rpcCandidates = [...new Set([...(S.seen.rpcCandidates || []), `https://${n}`])];
          notify(`LayerZero alan adlarında yeni sertifika alındı:\n${added.slice(0, 10).map((n) => `• <code>${esc(n)}</code>`).join("\n")}${added.some((n) => /rpc/.test(n)) ? "\n\nRPC adresleri dakikalık denemeye eklendi." : ""}`, "hint");
        }
      },
    },
  ];

  // ---------- zamanlayıcı (tamamen izole) ----------
  async function runOne(w) {
    S.errStreak ??= {};
    try {
      await w.run();
      if ((S.errStreak[w.id] || 0) >= 10) notify(`"${w.name}" izleyicisi tekrar çalışıyor.`);
      S.health[w.id] = { ok: true, at: Date.now() };
      S.errStreak[w.id] = 0;
    } catch (e) {
      S.health[w.id] = { ok: false, at: Date.now(), err: String(e?.message || e) };
      S.errStreak[w.id] = (S.errStreak[w.id] || 0) + 1;
      console.error(`[lz:${w.id}]`, e?.message || e);
      if (S.errStreak[w.id] === 10 && !w.quiet) notify(`"${w.name}" izleyicisi 10 kez üst üste hata verdi: ${esc(String(e?.message || e))}`);
    }
    save();
  }
  const loops = [];
  for (const w of W) {
    const tick = async () => {
      try { await runOne(w); } catch (e) { console.error("[lz] beklenmeyen:", e); }
      loops.push(setTimeout(tick, w.every * 1000));
    };
    loops.push(setTimeout(tick, 3000 + W.indexOf(w) * 2000)); // GIWA başlangıcını yavaşlatmamak için kademeli
  }

  function status() {
    const lines = ["<b>LayerZero / Zero izleme</b>"];
    for (const w of W) {
      const h = S.health[w.id];
      const when = h ? new Date(h.at).toISOString().slice(11, 16) + " UTC" : "henüz yok";
      lines.push(`${h?.ok ? "🟢" : h ? "🔴" : "⚪"} ${w.name} — ${when}${h && !h.ok ? `\n   <i>${esc(h.err).slice(0, 120)}</i>` : ""}`);
    }
    lines.push("", factsText());
    return lines.join("\n");
  }
  async function verify() {
    for (const id of ["peer", "metadata", "rpc", "docs"]) await runOne(W.find((w) => w.id === id));
    return factsText();
  }
  console.log(`[lz] LayerZero/Zero izleme açık (${W.length} izleyici, durum: ${FILE})`);
  return { status, verify, summary: () => verdict() };
}
