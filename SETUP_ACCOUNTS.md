# حسابات العملاء

## 1) SQL
شغّل `store_accounts.sql` في Supabase SQL Editor.

## 2) تفعيل الدخول بجوجل (اختياري)

1. **Google Cloud Console** → APIs & Services → **Credentials**
   → Create **OAuth client ID** → Web application
2. **Authorized redirect URI**:
   ```
   https://tszuepeksxyinhtyccjq.supabase.co/auth/v1/callback
   ```
   (استبدل بمرجع مشروعك إن اختلف)
3. انسخ **Client ID** و **Client Secret**
4. Supabase → **Authentication → Sign In / Providers → Google** → Enable → الصقهما → Save

## 3) إعدادات Supabase Auth

**Authentication → URL Configuration**
- Site URL: `https://proskill-store.vercel.app`
- Redirect URLs: أضف `https://proskill-store.vercel.app/account`

> عند ربط الدومين لاحقاً، حدّث القيمتين إلى `https://store.proskillagency.com`.

**Authentication → Providers → Email**
- `Confirm email` مفعّل = العميل يؤكد بريده قبل الدخول (موصى به).

---

## كيف تعمل؟

- `/account` — تسجيل دخول / إنشاء حساب / **طلباتي**
- الحسابات **منفصلة تماماً** عن حسابات بوت تيليجرام (لا محفظة ولا رصيد مشترك).
- **الطلبات القديمة تظهر تلقائياً**: أي طلب اشتُري كضيف بنفس البريد يُربط بالحساب
  عند أول دخول (`claim_orders_for_user`).
- المشتري المسجَّل: طلبه يُختم برقم حسابه لحظة الشراء.

## الأمان
- التحقق من الهوية يتم **على السيرفر** (`auth.getUser(token)`) — لا نثق برقم مستخدم
  قادم من المتصفح إطلاقاً.
- الأكواد تُعرض فقط لطلبات `paid` + `delivered`.
- سياسة RLS تسمح للعميل بقراءة **طلباته هو فقط**، ولا تسمح له بالكتابة إطلاقاً.
- الكتابة في `web_orders` تتم حصراً من السيرفر بمفتاح الخدمة.
