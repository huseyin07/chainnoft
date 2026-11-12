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
import dns from "node:dns/promises";

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
// Testnet RPC'si metadata'da testnet.zero.layerzero.network olarak duruyor; mainnet büyük ihtimalle aynı alan adı altında olacak
const GUESSED_RPCS = ["https://rpc.zero.layerzero.network", "https://mainnet.zero.layerzero.network", "https://zero.layerzero.network", "https://rpc.atlas.zero.layerzero.network", "https://interop.zero.layerzero.network"];
// DNS'te düzenli olarak denenecek adlar: biri ilk kez çözülmeye başlarsa uyarı
const DNS_BASES = ["zero.layerzero.network", "mainnet.zero.layerzero.network"];
const DNS_PREFIXES = ["", "rpc", "ws", "wss", "explorer", "scan", "bridge", "app", "api", "faucet", "status", "portal", "gateway", "indexer", "archive", "prover", "stake", "mainnet", "testnet", "devnet",
  "rpc-mainnet", "mainnet-rpc", "node", "nodes", "chain", "blockscout", "stats", "explorer-api", "api-explorer", "bridge-api", "graph", "subgraph", "dvn", "executor", "relayer", "og", "da", "sequencer", "docs", "www", "launch", "claim", "airdrop"];
const DNS_EXTRA = ["atlas.layerzero.network", "rpc.atlas.layerzero.network", "explorer.atlas.layerzero.network", "zeroscan.layerzero.network", "zero-rpc.layerzero.network", "rpc-zero.layerzero.network", "interop.zero.layerzero.network", "rpc.interop.zero.layerzero.network"];
const DNS_CANDIDATES = [...new Set([...DNS_BASES.flatMap((b) => DNS_PREFIXES.map((p) => (p ? `${p}.${b}` : b))), ...DNS_EXTRA])];
// EndpointV2 tüm EVM zincirlerinde aynı adreste. Yeni bir zincir açılmadan önce LayerZero bu kontratta
// o zincirin EID'si için varsayılan kütüphaneleri ve ULN/Executor ayarlarını yapar — zincir üstünde en erken iz.
const ENDPOINT_V2 = "0x1a44076050125825900e736c501f859c50fe728c";
const SEL_IS_SUPPORTED = "0x6750cd4c";   // isSupportedEid(uint32)
const SEL_DEFAULT_SEND = "0xf64be4c7";   // defaultSendLibrary(uint32)
const CONFIG_TOPICS = {
  "0x16aa0f528038ab41019e95bae5b418a50ba8532c5800e3b7ea2f517d3fa625f5": "DefaultSendLibrarySet",
  "0xc16891855cffb4a5ac51ac11864a3f3c96ba816cc45fe686c987ae36277de5ec": "DefaultReceiveLibrarySet",
  "0x55b28633cdb29709386f555dfc54418592ad475ce7a65a78ac5928af60ffb8f8": "DefaultReceiveLibraryTimeoutSet",
  "0xaaf3aaa0c11056e86ac56eb653e25b005ca1a7d4dcd21ba24647f7ab63f3b560": "DefaultUlnConfigsSet",
  "0x2b001e1c6683bf79cc52891bd7215b204c787d18134fc7f3d21b4f32a49e47de": "DefaultExecutorConfigsSet",
  "0x238399d427b947898edb290f5ff0f9109849b1c3ba196a42e35f00c50a54b98b": "PeerSet",
};
const SITEMAPS = ["https://layerzero.network/sitemap.xml", "https://docs.layerzero.network/sitemap.xml"];
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
    { name: "Ethereum", loc: "Ethereum'daki", rpc: ethRpc, selfEid: 30110, explorer: "https://etherscan.io", logsRpcs: [process.env.ETH_LOGS_RPC_URL, "https://eth.drpc.org", "https://eth.llamarpc.com", "https://ethereum-rpc.publicnode.com"].filter(Boolean) },   // self-test: Ethereum'daki ZRO'nun Arbitrum peer'ı dolu olmalı
    { name: "Arbitrum", loc: "Arbitrum'daki", rpc: process.env.ARB_RPC_URL || "https://arbitrum-one-rpc.publicnode.com", selfEid: 30101, explorer: "https://arbiscan.io", logsRpcs: [process.env.ARB_LOGS_RPC_URL, "https://arb1.arbitrum.io/rpc", "https://arbitrum.drpc.org", "https://arbitrum.llamarpc.com"].filter(Boolean) },
    { name: "Base", loc: "Base'deki", rpc: process.env.BASE_RPC_URL || "https://base-rpc.publicnode.com", selfEid: 30101, explorer: "https://basescan.org", logsRpcs: [process.env.BASE_LOGS_RPC_URL, "https://mainnet.base.org", "https://base.llamarpc.com", "https://base.drpc.org"].filter(Boolean) },
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
  // Birikimli: bir kez görülen değer bir daha "yeni" sayılmaz. crt.sh/doküman gibi
  // her seferinde eksik ya da farklı liste dönebilen kaynaklarda tekrar uyarıyı önler.
  const diffSetCumulative = (key, current) => {
    const prev = S.seen[key];
    const p = new Set(prev || []);
    const added = current.filter((x) => !p.has(x));
    S.seen[key] = [...p, ...added];
    return prev ? added : [];
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
  // "layerzero" kelimesinin kendisi "zero" içerdiği için onu çıkarıp bak
  const zeroish = (t) => ZERO_WORDS.test(String(t || "").replace(/layer[-_ ]?zero/gi, ""));
  const addRpc = (u) => { if (/^https?:\/\//.test(u || "") && !/testnet|sepolia|devnet/i.test(u)) S.seen.rpcCandidates = [...new Set([...(S.seen.rpcCandidates || []), u.replace(/\/$/, "")])]; };

  // ---------- kesinlik özeti ----------
  function factsText() {
    const f = S.facts; const lines = [];
    const row = (ok, t) => lines.push(`${ok === true ? "✅" : ok === false ? "❌" : "➖"} ${t}`);
    row(true, `npm'de Zero endpoint ID'si: <b>${S.zeroEids.join(", ")}</b> (EVM olarak tanımlı)`);
    const peers = f.peers || {};
    const set = Object.entries(peers).filter(([, v]) => v);
    row(set.length ? true : false, set.length ? `ZRO köprüsü Zero'ya bağlandı: ${set.map(([k, v]) => `${k} → <code>${v}</code>`).join(", ")}` : "ZRO kontratında Zero peer'ı yok (henüz ZRO gönderilemez)");
    const ep = Object.entries(f.endpoint || {}).filter(([, v]) => v?.sendLib || v?.supported);
    row(ep.length ? true : false, ep.length ? `EndpointV2'de Zero yolu ayarlı: ${ep.map(([k]) => k).join(", ")}` : "EndpointV2'de Zero için varsayılan kütüphane yok (yol açılmadı)");
    if (f.oappPeers?.length) row(true, `Zero'ya peer ekleyen uygulamalar: ${f.oappPeers.slice(0, 5).map((x) => `<code>${esc(x)}</code>`).join(", ")}`);
    if (f.metadata) row(true, `LayerZero metadata'da: <b>${esc(f.metadata.key)}</b>${f.metadata.chainId ? ` · chain ID ${f.metadata.chainId}` : ""}${f.metadata.eids?.length ? ` · EID ${f.metadata.eids.join(", ")}` : ""}`);
    else if (f.metaPlaceholders?.length) row(null, `Metadata'da boş Zero kayıtları var (${esc(f.metaPlaceholders.join(", "))}) — EID/chain ID/RPC henüz yok`);
    else row(false, "LayerZero metadata API'sinde Zero kaydı yok");
    if (f.metaTestnets?.length) row(null, `Zero testnetleri: ${esc(f.metaTestnets.join("; "))}`);
    row(f.rpc?.live ? true : false, f.rpc?.live ? `Canlı RPC: <code>${esc(f.rpc.url)}</code> · chain ID ${f.rpc.chainId} · blok ${f.rpc.block}` : "Canlı Zero RPC bulunamadı");
    row(f.docs ? true : null, f.docs ? `Doküman zaman çizelgesi: ${esc(f.docs)}` : "Doküman zaman çizelgesi okunmadı");
    return `<b>Zero durumu:</b> ${verdict()}\n${lines.join("\n")}`;
  }
  function verdict() {
    const f = S.facts;
    if (f.rpc?.live && f.rpc.peerCode) return "🟢 Zero canlı ve ZRO köprüsü zincir üstünde doğrulandı";
    if (f.rpc?.live) return "🟠 Zero RPC canlı, köprü kontratı henüz doğrulanmadı";
    if (Object.values(f.endpoint || {}).some((v) => v?.supported) || f.oappPeers?.length) return "🟠 LayerZero Zero yolunu zincir üstünde açtı — ağ açılıyor olabilir";
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
        const latest = parseInt(await rpc(ethRpc, "eth_blockNumber"), 16) - 2; // geride kalan düğümler için pay
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
        // Her turda baştan hesapla: sadece içi dolu (EID / chain ID / RPC olan) mainnet kaydı "metadata'da var" sayılır
        S.facts.metadata = null;
        S.facts.metaPlaceholders = [];
        S.facts.metaTestnets = [];
        for (const [key, v] of Object.entries(j)) {
          const eids = (v?.deployments || []).map((d) => Number(d.eid)).filter(Boolean);
          if (!ZERO_WORDS.test(key) && !eids.some(isZeroEid)) continue;
          const mainnetEids = eids.filter((e) => e < 40000);
          const chainId = v?.chainDetails?.nativeChainId ?? null;
          const rpcs = (v?.rpcs || []).map((x) => x?.url).filter((u) => /^https:\/\//.test(u || ""));
          const ep = (v?.deployments || []).find((d) => d.endpointV2?.address)?.endpointV2?.address;
          const details = `${chainId ? `\nChain ID: ${chainId}` : ""}${rpcs.length ? `\nRPC: ${rpcs.map((u) => `<code>${esc(u)}</code>`).join(", ")}` : ""}${ep ? `\nEndpointV2: <code>${esc(ep)}</code>` : ""}`;
          if (/testnet|sandbox/i.test(key) || (eids.length && !mainnetEids.length)) {
            if (chainId) S.testnetChainIds = [...new Set([...(S.testnetChainIds || []), Number(chainId)])];
            S.facts.metaTestnets.push(`${key} (EID ${eids.join(", ") || "?"}${chainId ? `, chain ID ${chainId}` : ""})`);
            fireOnce(`meta:test:${key}`, `LayerZero metadata'sına Zero test zinciri eklendi: <b>${esc(key)}</b> (EID ${eids.join(", ")}). Mainnet değil.`, "info");
            if (chainId || rpcs.length) fireOnce(`meta:test:${key}:${chainId}:${rpcs.join(",")}`, `Zero test zinciri ayrıntıları: <b>${esc(key)}</b>${details}\n\nBu testnet — gerçek para yok, mainnet sinyali değil.`, "info");
            continue;
          }
          if (!mainnetEids.length && !chainId && !rpcs.length) {
            // Yer tutucu kayıt: isim var, içi boş. Tek başına ağın açıldığı anlamına gelmez.
            S.facts.metaPlaceholders.push(key);
            fireOnce(`meta:${key}:${chainId}:${rpcs.join(",")}`, `LayerZero metadata'sında Zero için <b>boş bir kayıt</b> var: <code>${esc(key)}</code> (EID, chain ID ve RPC henüz yok). İçi dolduğunda güçlü sinyal gelecek.`, "info");
            continue;
          }
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
        const list = [...new Set([...(S.seen.rpcCandidates || []), ...GUESSED_RPCS])].filter((u) => !/testnet|sepolia/i.test(u));
        for (const url of list) {
          let id;
          try { id = parseInt(await rpc(url, "eth_chainId"), 16); } catch { continue; }
          // Testnet'in (ve yerel geliştirme ağlarının) chain ID'si mainnet sayılmaz
          if ([1337, 31337, ...(S.testnetChainIds || [])].includes(id)) {
            fireOnce(`rpc:testnet:${url}:${id}`, `<code>${esc(url)}</code> cevap veriyor ama chain ID ${id} testnet'e ait — mainnet değil.`, "info");
            continue;
          }
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
            const added = diffSetCumulative("docsPages", [...new Set([...pages, ...urls])]);
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
      id: "dns", name: "Zero alt alan adları (DNS)", every: 60,
      async run() {
        const resolves = async (h) => {
          try { return (await dns.resolve4(h)).length > 0; } catch (e) {
            if (e?.code === "ENOTFOUND" || e?.code === "ENODATA") return false;
            try { return (await dns.resolve6(h)).length > 0; } catch { return false; }
          }
        };
        // Joker kayıt (*.zero.layerzero.network) varsa her ad çözülür; o zaman bu kontrol anlamsız
        S.seen.dnsWildcard ??= {};
        for (const b of DNS_BASES) S.seen.dnsWildcard[b] = await resolves(`zz-${Date.now().toString(36)}.${b}`);
        const live = [];
        for (const h of DNS_CANDIDATES) {
          const base = DNS_BASES.find((b) => h.endsWith("." + b));
          if (base && S.seen.dnsWildcard[base]) continue;
          if (await resolves(h)) live.push(h);
        }
        const first = !S.seen.dnsLive;
        const prev = new Set(S.seen.dnsLive || []);
        const added = live.filter((h) => !prev.has(h));
        S.seen.dnsLive = [...new Set([...prev, ...live])];
        for (const h of live) if (/(^|\.)(rpc|ws|wss)\./.test(h) && !/testnet|devnet/.test(h)) S.seen.rpcCandidates = [...new Set([...(S.seen.rpcCandidates || []), `https://${h}`])];
        if (!added.length) return;
        const list = added.map((h) => `• <code>${esc(h)}</code>${/testnet|devnet/.test(h) ? " (test)" : ""}`).join("\n");
        notify(first
          ? `DNS izleyicisi başladı. Şu an çözülen Zero adresleri:\n${list}`
          : `Daha önce olmayan alan adı artık DNS'te çözülüyor:\n${list}\n\nArkasında bir servisin cevap verdiği ya da mainnet olduğu kanıtlanmadı.${added.some((h) => /(^|\.)(rpc|ws|wss)\./.test(h)) ? " RPC adresleri dakikalık denemeye eklendi." : ""}`, "hint");
      },
    },
    {
      id: "endpoint", name: "EndpointV2 — Zero yol ayarları (Ethereum/Arbitrum/Base, tüm OApp peer'ları)", every: 60,
      async run() {
        S.seen.epBlock ??= {}; S.facts.endpoint ??= {};
        let ok = 0;
        for (const c of CHAINS) {
          try {
            // 1) Durum: EndpointV2 Zero'yu destekliyor mu? (self-test: bilinen bir EID true dönmeli)
            const selfOk = await rpc(c.rpc, "eth_call", [{ to: ENDPOINT_V2, data: SEL_IS_SUPPORTED + eidHex(c.selfEid) }, "latest"]);
            if (isZero(selfOk)) throw new Error(`${c.name}: bilinen EID desteklenmiyor görünüyor, kontrol güvenilir değil`);
            for (const eid of S.zeroEids) {
              const sup = await rpc(c.rpc, "eth_call", [{ to: ENDPOINT_V2, data: SEL_IS_SUPPORTED + eidHex(eid) }, "latest"]);
              const lib = await rpc(c.rpc, "eth_call", [{ to: ENDPOINT_V2, data: SEL_DEFAULT_SEND + eidHex(eid) }, "latest"]);
              S.facts.endpoint[`${c.name}:${eid}`] = { supported: !isZero(sup), sendLib: isZero(lib) ? null : addr(lib) };
              if (!isZero(lib)) fireOnce(`ep:lib:${c.name}:${eid}`, `${c.loc} LayerZero EndpointV2'de <b>Zero (EID ${eid})</b> için varsayılan gönderim kütüphanesi ayarlandı:\n<code>${addr(lib)}</code>\n\nLayerZero Zero'ya giden yolu açıyor; uygulamalar artık Zero'ya mesaj gönderecek şekilde ayarlanabilir.`, "strong");
              if (!isZero(sup)) fireOnce(`ep:sup:${c.name}:${eid}`, `${c.loc} EndpointV2 artık <b>Zero (EID ${eid})</b> destekliyor (isSupportedEid = true).`, "strong");
            }
            // 2) Olaylar. publicnode adres filtresi olmadan getLogs kabul etmiyor:
            //    (a) EndpointV2'nin kendi olayları ana RPC'den (adresli), (b) tüm kontratlar (ULN ayarları,
            //    her OApp'in PeerSet'i) adres filtresiz sorguyu kabul eden ikinci RPC'den. Ayrı imleçler.
            // Sırayla dene: biri reddederse (403/400/limit) sonrakine geç
            const scan = async (key, urls, address, span) => {
              let last;
              for (const url of urls) { try { return await scanOne(key, url, address, span); } catch (e) { last = e; } }
              throw last;
            };
            const scanOne = async (key, url, address, span) => {
              S.seen[key] ??= {};
              const latest = parseInt(await rpc(url, "eth_blockNumber"), 16) - 2; // geride kalan düğümler için pay
              const from = S.seen[key][c.name] ? S.seen[key][c.name] + 1 : latest - 20;
              if (from > latest) return;
              const to = Math.min(latest, from + span - 1);
              const q = { topics: [Object.keys(CONFIG_TOPICS)], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) };
              if (address) q.address = address;
              const logs = await rpc(url, "eth_getLogs", [q]);
              for (const l of logs || []) {
                const name = CONFIG_TOPICS[l.topics[0]];
                const words = (l.data.slice(2).match(/.{64}/g) || []);
                const hit = S.zeroEids.find((e) => (name === "PeerSet" || name.startsWith("DefaultSend") || name.startsWith("DefaultReceive")) ? parseInt(words[0] || "0", 16) === e : words.some((w) => parseInt(w, 16) === e));
                if (hit === undefined) continue;
                if (name === "PeerSet" && c.name === "Ethereum" && l.address.toLowerCase() === ZRO) continue; // "peerlog" zaten bildiriyor
                if (name === "PeerSet") S.facts.oappPeers = [...new Set([...(S.facts.oappPeers || []), `${c.name}:${l.address}`])];
                fireOnce(`ep:log:${c.name}:${l.transactionHash}:${l.logIndex}`, `${c.loc} <b>${name}</b> olayı — <b>Zero (EID ${hit})</b>\nKontrat: <code>${l.address}</code>${name === "PeerSet" ? `\nPeer: <code>${addr("0x" + (words[1] || ""))}</code>\n\nBir uygulama (token/köprü) kendini Zero'ya bağladı.` : "\n\nLayerZero Zero yolunu yapılandırıyor."}\nİşlem: ${c.explorer}/tx/${l.transactionHash}`, "strong");
              }
              S.seen[key][c.name] = to;
            };
            await scan("epBlock", [c.rpc, ...c.logsRpcs], ENDPOINT_V2, c.name === "Arbitrum" ? 1000 : 500);
            try { await scan("epBlockAll", c.logsRpcs, null, c.name === "Arbitrum" ? 500 : 200); }
            catch (e) { console.error(`[lz:endpoint] ${c.name} tüm kontratlar:`, e?.message || e); }
            ok++;
          } catch (e) { console.error(`[lz:endpoint] ${c.name}:`, e?.message || e); }
        }
        if (!ok) throw new Error("hiçbir zincir okunamadı");
      },
    },
    {
      id: "probe", name: "Zero adreslerine HTTP yoklaması (explorer/RPC sayfaları)", every: 90,
      async run() {
        S.seen.probe ??= {}; S.facts.probe ??= {};
        const hosts = [...new Set([...(S.seen.dnsLive || []), ...GUESSED_RPCS.map((u) => new URL(u).host)])];
        for (const h of hosts) {
          const base = `https://${h}`;
          let sig = "erişilemiyor", info = "";
          try {
            const r = await http(base + "/", { redirect: "follow", headers: { "User-Agent": "Mozilla/5.0" } }, 15000);
            const body = (await r.text()).slice(0, 200000);
            const title = (body.match(/<title[^>]*>([^<]{0,120})/i) || [])[1]?.trim() || "";
            sig = `HTTP ${r.status}${title ? ` · ${title}` : ""}`;
            if (zeroish(body.replace(/testnet/gi, "")) && /mainnet/i.test(body)) info += "\nSayfada \"mainnet\" geçiyor.";
          } catch {}
          // Blockscout tabanlı explorer'lar yapılandırmayı açıkta tutar: ağ adı, chain ID, RPC
          try {
            const r = await http(base + "/assets/envs.js", {}, 10000);
            if (r.ok) {
              const t = await r.text();
              const g = (k) => (t.match(new RegExp(k + "\\s*[:=]\\s*[\"']([^\"']+)")) || [])[1];
              const net = g("NEXT_PUBLIC_NETWORK_NAME"), id = g("NEXT_PUBLIC_NETWORK_ID"), rpcUrl = g("NEXT_PUBLIC_NETWORK_RPC_URL");
              if (net || id || rpcUrl) {
                sig += ` · ${net || "?"} / chain ${id || "?"}`;
                info += `\nExplorer yapılandırması: ağ <b>${esc(net || "?")}</b>, chain ID <b>${esc(id || "?")}</b>${rpcUrl ? `, RPC <code>${esc(rpcUrl)}</code>` : ""}`;
                for (const u of String(rpcUrl || "").split(",")) addRpc(u.trim());
                S.facts.probe[h] = { net, id, rpc: rpcUrl };
              }
            }
          } catch {}
          try {
            const id = parseInt(await rpc(base + "/api/eth-rpc", "eth_chainId"), 16);
            if (id) { sig += ` · eth-rpc ${id}`; info += `\nExplorer'ın JSON-RPC'si cevap veriyor: chain ID <b>${id}</b>`; }
          } catch {}
          const prev = S.seen.probe[h];
          if (sig === "erişilemiyor" && prev !== undefined) continue; // anlık bağlantı hatası değişiklik sayılmaz
          S.seen.probe[h] = sig;
          if (prev === undefined && sig === "erişilemiyor") continue;
          if (prev === sig) continue;
          const test = /testnet|devnet/.test(h) || (S.testnetChainIds || []).some((t) => sig.includes(`chain ${t}`) || sig.includes(`eth-rpc ${t}`));
          notify(`<code>${esc(h)}</code> ${prev === undefined ? "yoklandı" : "değişti"}:\n${prev !== undefined ? `Önce: ${esc(prev)}\n` : ""}Şimdi: <b>${esc(sig)}</b>${info}${test ? "\n\n(Testnet adresi ya da testnet chain ID'si — mainnet sinyali değil.)" : ""}`, "hint");
        }
      },
    },
    {
      id: "certspotter", name: "SSL sertifikaları (Cert Spotter, crt.sh yedeği)", every: 300, quiet: true,
      async run() {
        let names = [];
        for (const d of CRT_DOMAINS) {
          S.seen.csAfter ??= {};
          const after = S.seen.csAfter[d] ? `&after=${S.seen.csAfter[d]}` : "";
          const r = await http(`https://api.certspotter.com/v1/issuances?domain=${d}&include_subdomains=true&expand=dns_names${after}`, {}, 30000);
          if (!r.ok) throw new Error(`certspotter ${r.status}`);
          const j = await r.json();
          for (const c of j) for (const n of c.dns_names || []) names.push(n.toLowerCase().replace(/^\*\./, ""));
          if (j.length) S.seen.csAfter[d] = j[j.length - 1].id;
        }
        const sub = (n) => { const d = CRT_DOMAINS.find((x) => n === x || n.endsWith("." + x)); return d ? n.slice(0, -d.length).replace(/\.$/, "") : n; };
        names = [...new Set(names)].filter((n) => { const x = sub(n); return x && !/(^|\.)(testnet|sepolia|devnet|staging)(\.|$)/.test(x) && (ZERO_WORDS.test(x) || /(^|\.)(rpc|explorer|scan|bridge|mainnet)([.-]|$)/.test(x)); });
        const added = diffSetCumulative("crt2", names); // crt.sh ile aynı liste: aynı ad iki kez bildirilmez
        for (const n of added) if (/rpc/.test(n)) addRpc(`https://${n}`);
        if (added.length) notify(`LayerZero alan adlarında yeni sertifika (Cert Spotter):\n${added.slice(0, 10).map((n) => `• <code>${esc(n)}</code>`).join("\n")}`, "hint");
      },
    },
    {
      id: "ghevents", name: "GitHub LayerZero-Labs etkinlikleri (push/PR/release/branch)", every: 180,
      async run() {
        const ev = await gh("orgs/LayerZero-Labs/events?per_page=100");
        if (!ev) throw new Error("etkinlikler okunamadı");
        const seen = new Set(S.seen.ghEvents || []);
        const first = !S.seen.ghEvents;
        for (const e of ev.slice().reverse()) {
          if (seen.has(e.id)) continue;
          seen.add(e.id);
          if (first) continue;
          const p = e.payload || {};
          const texts = [e.repo?.name, p.ref, p.ref_type, p.pull_request?.title, p.pull_request?.head?.ref, p.release?.name, p.release?.tag_name, ...(p.commits || []).map((c) => c.message)].filter(Boolean).join("\n");
          if (!(zeroish(texts) || /\b3300\d\b|zero[-_ ]?mainnet|zerointerop/i.test(texts))) continue;
          const url = p.pull_request?.html_url || p.release?.html_url || `https://github.com/${e.repo?.name}`;
          notify(`LayerZero-Labs GitHub'ında Zero ile ilgili hareket (<b>${esc(e.type)}</b>):\nDepo: <code>${esc(e.repo?.name)}</code>\n${esc(texts.replace(e.repo?.name || "", "").trim().slice(0, 400))}\n${url}`, "hint");
        }
        S.seen.ghEvents = [...seen].slice(-500);
      },
    },
    {
      id: "npmscope", name: "npm @layerzerolabs yeni paketler", every: 600,
      async run() {
        const r = await http("https://registry.npmjs.org/-/v1/search?text=scope:layerzerolabs&size=250", {}, 30000);
        if (!r.ok) throw new Error(`npm arama ${r.status}`);
        const names = ((await r.json()).objects || []).map((o) => o.package?.name).filter(Boolean);
        const added = diffSetCumulative("npmScope", names).filter((n) => zeroish(n.replace("@layerzerolabs/", "")));
        if (added.length) notify(`npm'de Zero ile ilgili yeni LayerZero paketi:\n${added.map((n) => `• https://www.npmjs.com/package/${esc(n)}`).join("\n")}`, "hint");
      },
    },
    {
      id: "sitemap", name: "layerzero.network site haritası (yeni sayfalar)", every: 600, quiet: true,
      async run() {
        const urls = [];
        for (const u of SITEMAPS) {
          try {
            const r = await http(u, { headers: { "User-Agent": "Mozilla/5.0" } }, 30000);
            if (!r.ok) continue;
            const t = await r.text();
            urls.push(...[...t.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()));
          } catch {}
        }
        if (!urls.length) throw new Error("site haritası okunamadı");
        const added = diffSetCumulative("sitemap", [...new Set(urls)]).filter((u) => zeroish(u.replace(/^https?:\/\/[^/]+/, "")));
        if (added.length) notify(`LayerZero sitesine Zero ile ilgili yeni sayfa eklendi:\n${added.slice(0, 8).map((u) => "• " + esc(u)).join("\n")}`, "hint");
      },
    },
    {
      id: "crt", name: "SSL sertifikaları (crt.sh)", every: 1200, quiet: true,
      async run() {
        const names = [];
        for (const d of CRT_DOMAINS) {
          const r = await http(`https://crt.sh/?q=%25.${d}&output=json&exclude=expired`, {}, 120000);
          if (!r.ok) throw new Error(`crt.sh ${r.status}`);
          for (const c of await r.json()) for (const n of String(c.name_value || "").split("\n")) names.push(n.toLowerCase().replace(/^\*\./, ""));
        }
        // Kök alan adı ("layerzero.network") zaten "zero" içerdiği için eşleşmeyi sadece alt alan adında ara;
        // yoksa trust./enterprise. gibi her şey "ilginç" sayılıyordu. Testnet adları mainnet ipucu değil.
        const sub = (n) => { const d = CRT_DOMAINS.find((x) => n === x || n.endsWith("." + x)); return d ? n.slice(0, -d.length).replace(/\.$/, "") : n; };
        const interesting = [...new Set(names)].filter((n) => {
          const s = sub(n);
          if (!s || /(^|\.)(testnet|sepolia|devnet|staging)(\.|$)/.test(s)) return false;
          return ZERO_WORDS.test(s) || /(^|\.)(rpc|explorer|scan|bridge|mainnet)([.-]|$)/.test(s);
        });
        const added = diffSetCumulative("crt2", interesting);
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
