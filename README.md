# GIWA Mainnet Watch

GIWA mainnet'inin açıldığını gösteren sinyalleri izler ve Telegram'a bildirim atar.

## Neleri izliyor

| İzleyici | Sıklık | Neyi yakalar |
|---|---|---|
| Mainnet RPC adresleri | 1 dk | Tahmin edilen ve keşfedilen tüm giwa.io adreslerini RPC olarak dener; cevap gelirse adresi ve chain ID'yi gönderir |
| Upbit duyuruları | 2 dk | Upbit'te başlığında GIWA/기와 geçen yeni resmi duyuru |
| giwa.io DNS | 2 dk | `rpc`, `mainnet-rpc`, `explorer`, `bridge` gibi yeni alt alan adları |
| Resmi doküman | 2 dk | "Mainnet geliştiriliyor" yazısının kalkması, yeni chain ID |
| GitHub `giwa-io/chain-operations` | 3 dk | Dosya yolundan ağı ayırt eder; Ethereum ana ağı (L1 ID 1) operasyonu gelirse resmi chain ID, kontrat adresleri ve işlem hash'lerini okur |
| GitHub `giwa-io/node` | 3 dk | Her yeni commit; `.env.mainnet`, `mainnet-rollup.json` gibi mainnet dosyaları (gelirse resmi chain ID ve köprü adresi mesaja yazılır) |
| Ethereum L1 | 5 dk | Resmi config'teki OptimismPortal/SystemConfig kontratlarının ana ağda kodu; resmi operasyon işlemlerinin ana ağda onayı; Sepolia batcher adresinin ana ağda işlem yapması (ipucu) |
| Doküman sayfa listesi | 5 dk | docs.giwa.io'ya eklenen yeni sayfalar, özellikle mainnet sayfaları |
| GitHub `giwa-io` | 10 dk | Yeni public depo; diğer depolarda mesajında açıkça "mainnet" geçen commit (ipucu) |
| superchain-registry + chainlist | 10 dk | GIWA geçen yeni PR/issue; superchain-registry'ye mainnet config'i |
| RPC sağlayıcıları | 10 dk | Alchemy'nin `giwa-mainnet` adresinin cevabının değişmesi (sağlayıcılar ağı genelde herkesten önce alır) |
| SSL sertifikaları (crt.sh) | 15 dk | giwa.io için yeni sertifika alınan alan adları; bunlar RPC izleyicisine otomatik eklenir |

## Alarm seviyeleri

| Seviye | Ne zaman |
|---|---|
| 🔔 Bilgi | Rutin değişiklik (ör. Sepolia testnet operasyonu) — mainnet olmadığı açıkça yazılır |
| 🔎 İpucu — doğrulanmadı | DNS, SSL sertifikası, commit mesajında "mainnet", sağlayıcı cevabı değişti. Tek başına bir şey kanıtlamaz |
| 🟠 Güçlü sinyal | Resmi kaynakta mainnet izi: GitHub'da L1 ID'si 1 olan config/operasyon, dokümanda mainnet, superchain-registry, Upbit duyurusu; ya da kontratların Ethereum'da bulunması |
| 🚨 Zincir üstünde doğrulandı | Resmi giwa.io RPC'si Ethereum ana ağına bağlı, blok üretiyor ve chain ID'si bağımsız bir resmi kaynakla (GitHub config, doküman veya Upbit) eşleşiyor |

Güçlü ve doğrulandı mesajlarının altında her zaman güncel **kesinlik tablosu** olur.

### `giwa-io/chain-operations` nasıl okunuyor

Depodaki dosya yolu ağı söyler: `<ağ>/<tarih-iş>/artifacts/<adım>/<L1 chain ID>/…json`. `11155111` Sepolia testnet, `1` Ethereum ana ağıdır. Bot commit mesajına değil dosya yoluna bakar. L1 ID'si 1 olan bir klasör gelirse:

1. `deploy-config.json`'dan resmi mainnet chain ID'sini okur
2. `l1-contracts.json`'dan OptimismPortal ve SystemConfig adreslerini okur ve Ethereum ana ağında kodlarının olup olmadığına bakar
3. `execute.json` içindeki işlem hash'lerinin Ethereum'da onaylanıp onaylanmadığını kontrol eder

## Gizli launch'a karşı doğrulama

Bir RPC bulunduğunda bot 5 kontrol yapar ve sonucu mesaja yazar:

1. Alan adı resmi `giwa.io` altında mı
2. OP Stack sistem kontratları (`0x4200…0015`, `0x4200…0016`) zincirde var mı
3. Zincirin L1Block kontratındaki Ethereum blok hash'i, gerçek Ethereum ana ağındaki hash ile birebir aynı mı. Sahte ya da testnet zincir bunu taklit edemez.
4. Zincir blok üretiyor mu
5. Chain ID, GitHub'daki resmi config ile eşleşiyor mu (config yayınlandıysa)

Ekip doküman ve GitHub'ı güncellemeden açsa bile Ethereum'daki deploy, RPC sağlayıcıları, SSL sertifikası ve DNS izlerini saklayamaz.

## Railway'e kurulum

1. GitHub'da yeni bir **private** repo aç (ör. `giwa-watch`), `index.js`, `package.json`, `README.md` dosyalarını yükle (Add file → Upload files).
2. Railway → **New Project** → **Deploy from GitHub repo** → `giwa-watch`.
3. Servisin **Variables** sekmesine ekle:
   - `TELEGRAM_BOT_TOKEN` — BotFather'dan aldığın token
   - `GITHUB_TOKEN` — önerilir. github.com/settings/tokens → Fine-grained token, "Public repositories (read-only)", başka izin verme
   - `ETH_RPC_URL` — isteğe bağlı. Boşsa ücretsiz publicnode kullanılır; daha güvenilir olması için Alchemy'den Ethereum Mainnet adresi koyabilirsin
   - `DATA_DIR` = `/data`
4. Servise sağ tıkla → **Attach Volume** → mount path `/data`. (Yeniden deploy'da bot hafızasını kaybetmesin diye.)
5. Deploy bitince Telegram'da botuna `/start` yaz. Bildirimler o sohbete gelir.

## Komutlar

- `/dogrula` — kesin kaynakları (GitHub config, Ethereum ana ağı, RPC, doküman) hemen yeniden kontrol eder ve kesinlik tablosunu gönderir
- `/status` — her izleyicinin son çalışma zamanı, hata durumu ve güncel karar
- `/test` — deneme bildirimi

## Güvenlik

Bot sadece resmi kaynakları izler. Bir RPC cevap verdiğinde chain ID'yi GitHub'daki resmi config ile karşılaştırır ve eşleşip eşleşmediğini yazar. Sahte "mainnet açıldı" zincirleri yüzünden 766 ETH'den fazla çalındı; doğrulanmamış hiçbir köprüye para gönderme. Private mainnet whitelist ile açılacağı için zinciri görmek, işlem yapabileceğin anlamına gelmez.
