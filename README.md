# GIWA Mainnet Watch

GIWA mainnet'inin açıldığını gösteren sinyalleri izler ve Telegram'a bildirim atar.

## Neleri izliyor

| İzleyici | Sıklık | Neyi yakalar |
|---|---|---|
| Mainnet RPC adresleri | 1 dk | `rpc.giwa.io` gibi resmi adreslerden biri Sepolia dışında bir chain ID ile cevap verirse |
| giwa.io DNS | 2 dk | `rpc`, `mainnet-rpc`, `explorer`, `bridge` gibi yeni alt alan adları açılırsa |
| Resmi doküman | 2 dk | docs.giwa.io'da "Mainnet geliştiriliyor" yazısı kalkarsa ya da yeni chain ID eklenirse |
| GitHub `giwa-io/node` | 3 dk | Her yeni commit; `.env.mainnet`, `mainnet-rollup.json` gibi mainnet dosyaları. Rollup dosyası gelirse resmi chain ID ve köprü adresini mesaja yazar |
| GitHub `giwa-io` | 10 dk | Yeni public depo açılırsa |
| superchain-registry + chainlist | 10 dk | GIWA geçen yeni PR/issue; superchain-registry'ye mainnet config'i eklenirse |
| SSL sertifikaları (crt.sh) | 15 dk | giwa.io için yeni sertifika alınan alan adları |
| Ethereum L1 (isteğe bağlı) | 5 dk | Sepolia batcher adresi ana ağda işlem yaparsa; resmi köprü kontratı ana ağa deploy edilirse |

Kritik sinyaller 🚨 ile ve her biri bir kez gelir. Bot ilk açıldığında mevcut durumu sessizce kaydeder, yanlış alarm vermez. Her gün 09:00'da (İstanbul) "çalışıyorum" mesajı atar.

## Railway'e kurulum

1. GitHub'da yeni bir **private** repo aç (ör. `giwa-watch`), `index.js`, `package.json`, `README.md` dosyalarını yükle (Add file → Upload files).
2. Railway → **New Project** → **Deploy from GitHub repo** → `giwa-watch`.
3. Servisin **Variables** sekmesine ekle:
   - `TELEGRAM_BOT_TOKEN` — BotFather'dan aldığın token
   - `GITHUB_TOKEN` — önerilir. github.com/settings/tokens → Fine-grained token, "Public repositories (read-only)", başka izin verme
   - `ETH_RPC_URL` — isteğe bağlı. Alchemy'de Ethereum Mainnet uygulaması açıp HTTPS adresini koy
   - `DATA_DIR` = `/data`
4. Servise sağ tıkla → **Attach Volume** → mount path `/data`. (Yeniden deploy'da bot hafızasını kaybetmesin diye.)
5. Deploy bitince Telegram'da botuna `/start` yaz. Bildirimler o sohbete gelir.

## Komutlar

- `/status` — her izleyicinin son çalışma zamanı ve hata durumu
- `/test` — deneme bildirimi

## Güvenlik

Bot sadece resmi kaynakları izler. Bir RPC cevap verdiğinde chain ID'yi GitHub'daki resmi config ile karşılaştırır ve eşleşip eşleşmediğini yazar. Sahte "mainnet açıldı" zincirleri yüzünden 766 ETH'den fazla çalındı; doğrulanmamış hiçbir köprüye para gönderme. Private mainnet whitelist ile açılacağı için zinciri görmek, işlem yapabileceğin anlamına gelmez.
