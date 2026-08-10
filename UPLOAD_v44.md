# ⚠️ اقرأ قبل الرفع

## إذا كنت قد رفعت v42 من قبل — احذف ملفاً

في v42 كان اسم الملف `api/p.js`. في هذه النسخة أصبح `api/meta.js` (لأنه صار يخدم المنتجات **والأقسام** معاً — لتوفير function).

**لو رفعت v42:** ادخل على GitHub → مجلد `api/` → **احذف `p.js`**.

لو تركته: سيكون لديك 12 function (الحد الأقصى بالضبط) وملف ميت لا يُستدعى. البناء سينجح لكنك على الحافة.

**لو لم ترفع v42 أصلاً:** تجاهل هذا — لا يوجد `p.js` على GitHub.

## بعد الرفع تأكد
`api/` يجب أن يحتوي **11 ملف** بالضبط:
admin.js · catalog.js · checkout.js · easykash-callback.js · fx.js · meta.js · my-orders.js · order-status.js · reviews.js · sitemap.js · validate-coupon.js

## تحقق سريع بعد النشر
1. افتح `store.proskillagency.com/sitemap.xml` → يجب أن ترى منتجاتك وأقسامك
2. افتح رابط قسم من الشريط → يجب أن تُفتح الصفحة عادية (لا كود خام)
3. `search.google.com/test/rich-results` → الصق رابط منتج → Product + Breadcrumb
