# GIWA Mainnet Watch

GIWA mainnet'inin açıldığını gösteren sinyalleri izler ve Telegram'a bildirim atar.

## Neleri izliyor

| İzleyici | Sıklık | Neyi yakalar |
|---|---|---|
| Mainnet RPC adresleri | 1 dk | Tahmin edilen ve keşfedilen tüm giwa.io adreslerini RPC olarak dener; cevap gelirse adresi ve chain ID'yi gönderir |
| Upbit duyuruları | 2 dk | Upbit'te başlığında GIWA/기와 geçen yeni resmi duyuru |
| giwa.io DNS | 2 dk | `rpc`, `mainnet-rpc`, `explorer`, `bridge` gibi yeni alt alan adları |
| Resmi doküman | 2 dk | "Mainnet geliştiriliyor" yazısının kalkması, yeni chain ID |
| GitHub `giwa-io/node` | 3 dk | Her yeni commit; `.env.mainnet`, `mainnet-rollup.json` gibi mainnet dosyaları (gelirse resmi chain ID ve köprü adresi mesaja yazılır) |
| Ethereum L1 | 5 dk | Sepolia batcher adresinin ana ağda işlem yapması; resmi köprü kontratının ana ağa deploy edilmesi |
| Doküman sayfa listesi | 5 dk | docs.giwa.io'ya eklenen yeni sayfalar, özellikle mainnet sayfaları |
| GitHub `giwa-io` | 10 dk | Yeni public depo; herhangi bir depoda mainnet/launch/deploy geçen commit |
| superchain-registry + chainlist | 10 dk | GIWA geçen yeni PR/issue; superchain-registry'ye mainnet config'i |
| RPC sağlayıcıları | 10 dk | Alchemy'nin `giwa-mainnet` adresinin cevabının değişmesi (sağlayıcılar ağı genelde herkesten önce alır) |
| SSL sertifikaları (crt.sh) | 15 dk | giwa.io için yeni sertifika alınan alan adları; bunlar RPC izleyicisine otomatik eklenir |

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

- `/status` — her izleyicinin son çalışma zamanı ve hata durumu
- `/test` — deneme bildirimi

## Güvenlik

Bot sadece resmi kaynakları izler. Bir RPC cevap verdiğinde chain ID'yi GitHub'daki resmi config ile karşılaştırır ve eşleşip eşleşmediğini yazar. Sahte "mainnet açıldı" zincirleri yüzünden 766 ETH'den fazla çalındı; doğrulanmamış hiçbir köprüye para gönderme. Private mainnet whitelist ile açılacağı için zinciri görmek, işlem yapabileceğin anlamına gelmez.
