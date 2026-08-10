# ProSkill Store — نشر كامل

## 1) SQL في Supabase (بالترتيب، مرة واحدة)
1. `store_setup.sql`
2. `store_rls.sql`
3. `store_payments.sql`
4. `admin_setup.sql`

## 2) حساب الأدمن
- Supabase → **Authentication → Users → Add user**
  - Email + Password + ✅ **Auto Confirm User**
- ثم في SQL Editor:
```sql
insert into store_admins (auth_user_id, email)
select id, email from auth.users where email = 'YOUR_EMAIL'
on conflict (auth_user_id) do nothing;
```

## 3) متغيرات البيئة في Vercel

### للمتصفح (عادي أنها ظاهرة)
| المتغير | القيمة |
|---|---|
| `VITE_SUPABASE_URL` | https://jsemibrimkacjbbsdozm.supabase.co |
| `VITE_SUPABASE_ANON_KEY` | `sb_publishable_...` (أو anon القديم `eyJ...`) |

### للسيرفر (سرية)
| المتغير | القيمة |
|---|---|
| `SUPABASE_URL` | نفس الرابط |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` — أو استخدم `SUPABASE_SERVICE_ROLE_KEY` القديم |
| `ENCRYPTION_KEY` | **نفس اللي في البوت بالضبط** |
| `VENDOR_API_URL` | https://ins2112131.onrender.com/8f71aedd3494e042bb06408f50b7f938 |
| `VENDOR_API_KEY` | نفس اللي في البوت |
| `SUBNOVA_API_URL` | https://subnovaa.com/api/cdk |
| `SUBNOVA_API_KEY` | نفس اللي في البوت |
| `EASYKASH_API_KEY` | من EasyKash → Integration Settings |
| `EASYKASH_HMAC_SECRET` | من EasyKash |
| `SITE_URL` | https://proskill-store.vercel.app |

⚠️ بعد أي تعديل في المتغيرات: **Deployments → ⋯ → Redeploy**

## 4) EasyKash
Callback URL (ولا تنسَ **Save**):
```
https://proskill-store.vercel.app/api/easykash-callback
```

## 5) الروابط
- المتجر: `/`
- الطلب: `/order/PSXXXXX`
- الداش بورد: `/admin`

---

## مفاتيح Supabase الجديدة
هذا المشروع يدعم الجيلين:
- الجديد: `sb_publishable_...` (للمتصفح) + `sb_secret_...` (للسيرفر)
- القديم: `anon` JWT + `service_role`

يتطلب `@supabase/supabase-js` ≥ 2.75 — موجود في `package.json`.

## استكشاف الأخطاء
| العرض | السبب الغالب |
|---|---|
| منتجات = "نفذت الكمية" كلها | `VENDOR_API_URL` / `SUBNOVA_API_URL` بها مسار زائد أو Redeploy ناقص |
| 401 عند تسجيل الدخول | مفتاح `VITE_SUPABASE_ANON_KEY` قديم/ناقص، أو المكتبة قديمة |
| "🚫 غير مصرّح لك" | الدخول نجح لكن المستخدم غير موجود في `store_admins` |
| دفع تم لكن لا يوجد كود | Callback URL غير محفوظ في EasyKash |
| "Amount must be more than 1" | EasyKash يرفض أقل من $1 (محمي في الواجهة) |
