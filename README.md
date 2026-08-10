# ProSkill Store

متجر الاشتراكات الرقمية — React + Vite + Supabase + Vercel + EasyKash.
يشارك نفس قاعدة بيانات بوت تيليجرام (نفس المنتجات والمخزون والفيندورز).

## 1) SQL في Supabase (بالترتيب)
1. `store_setup.sql`     — أعمدة المتجر + bucket الصور
2. `store_rls.sql`       — السماح بقراءة الكتالوج فقط للعامة
3. `store_payments.sql`  — جدول web_orders + دوال الدفع والتسليم

## 2) متغيرات البيئة في Vercel

**Frontend (تظهر في المتصفح — عادي):**
| المتغير | القيمة |
|---|---|
| `VITE_SUPABASE_URL` | https://jsemibrimkacjbbsdozm.supabase.co |
| `VITE_SUPABASE_ANON_KEY` | مفتاح anon |

**Backend (سرية — لا تظهر أبداً في المتصفح):**
| المتغير | القيمة |
|---|---|
| `SUPABASE_URL` | نفس الرابط |
| `SUPABASE_SERVICE_ROLE_KEY` | مفتاح service_role |
| `ENCRYPTION_KEY` | نفس اللي في البوت (مهم لفك تشفير المخزون) |
| `VENDOR_API_URL` | https://ins2112131.onrender.com/8f71aedd3494e042bb06408f50b7f938 |
| `VENDOR_API_KEY` | نفس اللي في البوت |
| `SUBNOVA_API_URL` | https://subnovaa.com/api/cdk |
| `SUBNOVA_API_KEY` | نفس اللي في البوت |
| `EASYKASH_API_KEY` | من EasyKash → Integration Settings |
| `EASYKASH_HMAC_SECRET` | من EasyKash (مفتاح التوقيع) |
| `SITE_URL` | https://store.proskillagency.com |

## 3) إعداد EasyKash
في لوحة EasyKash، ضع رابط الـ Callback:
```
https://<your-vercel-domain>/api/easykash-callback
```

## 4) نشر
ريبو GitHub جديد `proskill-store` → مشروع Vercel جديد.

---

## قواعد الأمان المطبّقة
- السعر يُقرأ من قاعدة البيانات، **لا يُقبل أبداً من المتصفح**.
- الـ redirect ليس دليل دفع — **الـ callback الموقّع فقط** هو مصدر الحقيقة.
- التحقق من التوقيع HMAC-SHA512 قبل أي إجراء.
- مطابقة المبلغ المدفوع مع إجمالي الطلب (دفاع مزدوج).
- `mark_web_order_paid()` ينتقل بالطلب **مرة واحدة فقط** — استدعاء callback مكرر لا يسلّم مرتين ولا يشتري من الفيندور مرتين.
- شراء الفيندور **محاولة واحدة، بدون إعادة** (تجنّب الخصم المزدوج).
- الرد دائماً HTTP 200 حتى لا يعيد EasyKash المحاولة 24 ساعة.
- الأكواد تُعرض فقط لمن يعرف رقم الطلب **والبريد الإلكتروني** معاً.
- مفاتيح الفيندورز لا تصل المتصفح إطلاقاً.

## ملاحظة على المنتجات اليدوية
منتجات "1-3 ساعات" تصبح `manual_pending` بعد الدفع — فعّلها يدوياً وأرسلها للعميل.
