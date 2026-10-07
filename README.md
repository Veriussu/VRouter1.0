# VRouter 1.0

Çoklu sağlayıcılı LLM yönlendirici (gateway). Bir sağlayıcıya birden fazla API anahtarı
tanımlanır; kota/hız limiti hatalarında **sıradaki anahtara otomatik geçer**, bağlantı
koptuğunda istek kesintiye uğramaz.

**Port:** `10090`

```
Arayüz   http://localhost:10090/dashboard/
API      http://localhost:10090/v1
```

---

## Kurulum

### Tek komutla kurulum

Linux/macOS üzerinde Node.js 20+ kuruluysa:

```bash
curl -fsSL https://raw.githubusercontent.com/Veriussu/VRouter1.0/main/install.sh | bash
```

Kurulum `~/.vrouter` içine yapılır ve `vrouter` komutu `~/.local/bin` altına eklenir.
PATH henüz tanımlı değilse terminalin önerdiği `export PATH=...` satırını çalıştırın.
Kurulum sırasında GitHub kullanıcı adı veya şifre istenmez; proje public olarak indirilir.

VRouter hakkında: [veriussu.com](https://veriussu.com) · `info@veriussu.com`

### Kaynak koddan kurulum

```bash
git clone https://github.com/Veriussu/VRouter1.0.git
cd VRouter1.0
npm install
cp .env.example .env      # ENCRYPTION_KEY değerini değiştirin
npm run sync              # models.dev kataloğunu indirir (226 sağlayıcı / 8431 model)
vrouter start
```

Yerleşik sağlayıcılar (`local`, `vprovider`, `veriussu`) ilk açılışta otomatik oluşturulur.

### Panel girişi

Panel ilk açıldığında bir yönetici hesabı oluşturma ekranı gelir. Bu hesap yalnızca ilk
kurulumda oluşturulur; sonraki girişlerde kullanıcı adı ve şifre ile login ekranı açılır.
Yönetim API'si ve panel sayfalarının işlemleri oturum gerektirir. Oturum, sol menünün
altındaki **Çıkış yap** düğmesiyle kapatılabilir.

## Terminal komutları

VRouter servis olarak arka planda çalışır ve `stop` verilene kadar açık kalır:

```bash
vrouter start     # arka planda başlat
vrouter stop      # durdur
vrouter reboot    # durdurup yeniden başlat
vrouter update    # GitHub'dan güncelle, bağımlılıkları kur, çalışıyorsa yeniden başlat
vrouter clear     # istek loglarını temizle, sağlayıcı anahtar durumlarını sıfırla
```

`clear`; sağlayıcıları, modelleri ve kayıtlı anahtarları silmez. Yalnızca istek geçmişini
temizler ve cooldown/invalid durumundaki sağlayıcı anahtarlarını tekrar aktif eder.
Çalışan sürecin PID ve log dosyaları `/tmp/vrouter.pid` ve `/tmp/vrouter.log` altında tutulur.

Kaynak klasöründe değilseniz kurulum dizinini değiştirmek için `VROUTER_HOME` kullanabilirsiniz:

```bash
curl -fsSL https://raw.githubusercontent.com/Veriussu/VRouter1.0/main/install.sh | VROUTER_HOME=/opt/vrouter bash
```

---

## Hızlı başlangıç

1. Paneli açın: `http://localhost:10090/dashboard/`
2. **Sağlayıcılar** → bir sağlayıcı seçin → **Anahtarlar** → API anahtarınızı ekleyin
3. **API Anahtarları** → istemci anahtarınızı oluşturun (kapsam + limit + tarih belirleyin)
4. Kullanmaya başlayın:

```bash
KEY=vr_xxxxxxxx

curl http://localhost:10090/v1/chat/completions \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4o",
    "messages": [{"role": "user", "content": "merhaba"}]
  }'
```

---

## API uçları

| Yöntem | Yol | Açıklama |
|---|---|---|
| `GET` | `/v1/models` | Tüm modeller (filtrelenebilir) |
| `GET` | `/v1/models/categories` | Kategori listesi + model sayıları |
| `GET` | `/v1/models/:id` | Tek model detayı |
| `POST` | `/v1/chat/completions` | Sohbet (streaming destekler) |
| `POST` | `/v1/completions` | Metin tamamlama |
| `POST` | `/v1/embeddings` | Embedding |
| `POST` | `/v1/images/generations` | Görsel üretimi |
| `POST` | `/v1/audio/speech` | Metin → ses (TTS) |
| `POST` | `/v1/audio/transcriptions` | Ses → metin |
| `GET` | `/health` | Sağlık kontrolü |

### Filtreleme

```bash
curl -H "Authorization: Bearer $KEY" "http://localhost:10090/v1/models?category=vision"
curl -H "Authorization: Bearer $KEY" "http://localhost:10090/v1/models?category=tts,image"
curl -H "Authorization: Bearer $KEY" "http://localhost:10090/v1/models?provider=openai"
curl -H "Authorization: Bearer $KEY" "http://localhost:10090/v1/models?search=gpt-4o"
curl -H "Authorization: Bearer $KEY" "http://localhost:10090/v1/models?capability=function_calling"
```

### Kategoriler

`chat` · `vision` · `image` · `tts` · `transcription` · `audio` · `embedding` ·
`reasoning` · `planning` · `video` · `code` · `moderation` · `rerank` ·
`structured-output` · `video-understanding`

Kategoriler models.dev `modalities` alanından ve model adı kalıplarından türetilir:
görsel üreten modeller `image`, görsel anlayanlar `vision`, `reasoning` bayrağı taşıyanlar
`reasoning` + `planning` alır.

---

## Anahtar rotasyonu

Bir sağlayıcıya istediğiniz kadar anahtar ekleyebilirsiniz. Öncelik numarası küçük olan
denenir; hata olursa sıradakine geçilir.

| Hata | Davranış | Soğuma |
|---|---|---|
| `429` kota | sıradaki anahtar | 300 sn (veya `Retry-After`) |
| `429` hız limiti | sıradaki anahtar | 60 sn |
| `402` kredi yok | sırdaki anahtar | 300 sn |
| `401` / `403` | sıradaki anahtar | 3600 sn + `invalid` işareti |
| `5xx` / ağ hatası | sıradaki anahtar | 30 / 15 sn |
| `400` / `404` / `422` | **tekrar denenmez** (istemci hatası) | — |

Soğuma süresi dolan anahtarlar otomatik olarak yeniden aktifleşir. Tüm anahtarlar
kullanılamaz durumdaysa `429` döner.

Aynı sağlayıcıda tükenen anahtarlar varsa, model birden fazla sağlayıcıda bulunuyorsa
sıradaki sağlayıcıya da geçilir.

---

## Model takma adı (alias)

Modeli istemciye orijinal adıyla göstermek istemiyorsanız takma ad verin:

```bash
curl -X PATCH http://localhost:10090/admin/api/models/<model_id> \
  -H "Content-Type: application/json" \
  -d '{"alias":"gpt-4"}'
```

Bundan sonra isteklerde `model: "gpt-4"` kullanabilirsiniz. Takma ad verilmemiş modeller
orijinal adıyla çalışmaya devam eder.

---

## API anahtarı (istemci) kısıtlamaları

Her oluşturulan API anahtarı için:

- **Model kapsamı** — tümü ya da seçili modeller
- **Dakikada istek limiti**
- **Günlük token limiti**
- **Günlük istek limiti**
- **Başlangıç / bitiş tarihi**

Limitler 24 saatlik kayan pencerede uygulanır. Anahtar yalnızca oluşturulurken bir kez
gösterilir, veritabanında SHA-256 karması saklanır.

---

## Token sıkıştırma

`COMPRESSION_THRESHOLD` (varsayılan 2000 token) üzerindeki isteklerde:

- Birebir tekrarlanan mesajlar kaldırılır
- Çok boşluklu metinler sadeleştirilir
- Uzun araç çıktıları başı/sonu korunarak ortası atılır
- Çok eski konuşma adımları tek bir özet satırına indirilir

**Gerekçe:** Anlamlı içeriği bir LLM çağrısıyla özetlemek çıktınızı sessizce
değiştirir. Bu yüzden yalnızca kayıpsız işlemler uygulanır. Tasarruf miktarı her
log kaydında `saved_tokens` alanında raporlanır. Kapatmak için `COMPRESSION_ENABLED=false`.

---

## Yönetim API'si

Panel `/admin/api/*` uçlarını kullanır. Panel açılmadan da yönetebilirsiniz:

```bash
# Sağlayıcıya anahtar ekle
curl -X POST http://localhost:10090/admin/api/providers/openai/keys \
  -H "Content-Type: application/json" \
  -d '{"key":"sk-...","key_name":"ana","priority":0}'

# İstemci anahtarı oluştur (model kapsamı + limitler)
curl -X POST http://localhost:10090/admin/api/api-keys \
  -H "Content-Type: application/json" \
  -d '{
    "name":"OpenCode",
    "models":["gpt-4o","claude-sonnet-5"],
    "rate_limit":60,
    "daily_token_limit":1000000,
    "valid_until":"2026-12-31"
  }'

# Loglar
curl "http://localhost:10090/admin/api/logs?limit=50&status=error"

# İstatistik
curl http://localhost:10090/admin/api/stats

# models.dev senkronizasyonu
curl -X POST http://localhost:10090/admin/api/sync
```

---

## Test

```bash
npm run mock       # sahte sağlayıcı (127.0.0.1:10099)
npm test           # 48 test — rotasyon, streaming, alias, limitler, sıkıştırma
npm run test:ui    # 17 test — panelin kullandığı API sözleşmesi
npm run ui:pages   # 6 sayfanın headless Chrome ile render + silme onayı kontrolü
```

`npm test` anahtar rotasyonunu (429 → 401 → başarı), streaming i, alias ı, limitleri,
kapsam kısıtlarını, sıkıştırmayı ve logları doğrular.

`npm run ui:pages` her panel sayfasını gerçek bir tarayıcıda açar; konsol hatası,
yüklenmemiş sayfa veya eksik silme onayı varsa başarısız olur.

---

## Silme onayları

Her silme işlemi tasarımla uyumlu bir onay diyaloğundan geçer:

| Ekran | Onay metni |
|---|---|
| Sağlayıcılar → Anahtarlar → Sil | Sağlayıcıya yapılan isteklerde kullanılamaz ve kaldırılamaz |
| Anahtarlar → Sil | Sağlayıcıya yapılan isteklerde kullanılamaz ve kaldırılamaz |
| API Anahtarları → Sil | Bu anahtarı kullanan tüm istemciler anında erişim kaybeder |

Diyalog silinecek kaydın adını ve maskeli anahtarını gösterir. `Enter` onaylar,
`Esc` / arka plan / **Vazgeç** iptal eder.

Onay diyaloğu, açık modalın üstüne açılabilen bir modal yığını kullanır; bu
sayede "Anahtarlar" modalının içindeki Sil butonu da onay alabiliyor.

---

## Yapılandırma (`.env`)

| Değişken | Varsayılan | Açıklama |
|---|---|---|
| `PORT` | `10090` | Dinlenen port |
| `HOST` | `0.0.0.0` | Dinlenen adres |
| `ENCRYPTION_KEY` | — | Sağlayıcı anahtarlarını şifreler. **Üretimde değiştirin.** |
| `MODELS_DEV_URL` | models.dev api.json | Katalog kaynağı |
| `SYNC_INTERVAL_HOURS` | `24` | Otomatik senkronizasyon aralığı |
| `COMPRESSION_ENABLED` | `true` | Token sıkıştırma |
| `COMPRESSION_THRESHOLD` | `2000` | Sıkıştırma eşiği (token) |
| `REQUEST_TIMEOUT_MS` | `600000` | Yukarı yönlü istek zaman aşımı |

---

## Veri

SQLite (`data/vrouter.db`, WAL modunda). Şemalar `src/db.js` içinde.

Sağlayıcı API anahtarları AES-256-GCM ile şifrelenir; istemci API anahtarları yalnızca
SHA-256 karması olarak tutulur.

---

## Beta sınırlamaları

- Yalnızca OpenAI-uyumlu ve Anthropic biçimleri desteklenir; Google'ın yerel SDK biçimi
  (`google` formatı) kullanılmaz, Gemini'nin OpenAI-uyumlu ucu tercih edilir.
- `audio/transcriptions` multipart gövdesi olduğu gibi iletilir; dosya boyutu sınırı
  `MAX_REQUEST_BODY` ile belirlenir.
- Çok örnekli (multi-instance) dağıtım desteklenmez — anahtar durumu SQLite'ta tutulur.
- Admin API kimlik doğrulaması yoktur; paneli internete açmadan önce bir reverse proxy
  arkasına alın.
