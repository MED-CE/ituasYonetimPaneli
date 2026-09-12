# İTÜAS Otonom Tekne Takımı - Yönetim Paneli

Bu proje, İTÜAS Otonom Tekne Takımı için geliştirilmiş yönetim paneli ve atölye takip sistemidir.

## Yerel Kurulum (Şu Anki Durum)

Projeyi bilgisayarınızda çalıştırmak için:

1. Node.js'in yüklü olduğundan emin olun.
2. Terminali projenin bulunduğu klasörde açın.
3. Paketleri yükleyin:
   ```bash
   npm install
   ```
4. Projeyi başlatın:
   ```bash
   npm run dev
   ```

*Not: Mevcut `.env` dosyasında eski test veritabanı ayarları olabilir, şimdilik bu şekilde yerel olarak çalıştırıp tasarımları görebilirsiniz.*

## Supabase (Veritabanı) Sıfırdan Kurulum Rehberi

Proje tam anlamıyla canlıya alınmadan önce takımınıza ait kendi Supabase veritabanınızı kurmanız gereklidir.

1. **Hesap Oluşturma:**
   - [Supabase](https://supabase.com/)'e gidin ve GitHub ile giriş yapın veya yeni bir hesap açın.
   - Yeni bir proje oluşturun (Örn: `ituas-otonom-db`).

2. **Veritabanı Şemalarını Oluşturma (SQL):**
   - Supabase panelinizden sol menüdeki **SQL Editor** bölümüne gidin.
   - `supabase/migrations/` klasörü içerisinde yer alan `.sql` dosyalarını sırasıyla (veya içeriklerini birleştirerek) buraya kopyalayın ve **RUN (Çalıştır)** butonuna basarak veritabanı tablolarını oluşturun.

3. **.env Dosyasını Güncelleme:**
   - Supabase sol menüsünden **Project Settings -> API** kısmına gidin.
   - Projenizdeki `.env` dosyasını açın.
   - Aşağıdaki satırları kendi projenizin API URL ve `anon public` key'i ile güncelleyin:
     ```env
     VITE_SUPABASE_URL=https://<KENDI_PROJE_ID>.supabase.co
     VITE_SUPABASE_PUBLISHABLE_KEY=<KENDI_ANON_KEY>
     ```

4. **Kullanıcı Yetkilendirme (Authentication):**
   - Panelden **Authentication -> Providers** menüsüne gidin.
   - Email ile girişi aktif edebilirsiniz veya ek kurallar tanımlayabilirsiniz. (Projede muhtemelen doğrudan tablodan kullanıcı/şifre kontrolü veya supabase auth kullanılıyordur, kodlara göz atarak emin olabilirsiniz).

Bu adımları tamamladıktan sonra kendi veritabanınızla, kendi takım yönetim panelinizi kullanmaya başlayabilirsiniz!
