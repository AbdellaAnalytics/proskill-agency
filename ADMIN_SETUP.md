# تشغيل الداش بورد

## 1) SQL
شغّل `admin_setup.sql` في Supabase SQL Editor.

## 2) اعمل حساب الأدمن
Supabase → **Authentication → Users** → **Add user**
- Email: بريدك
- Password: كلمة مرور قوية
- ✅ Auto Confirm User

## 3) اجعله أدمن
في SQL Editor (غيّر البريد):
```sql
insert into store_admins (auth_user_id, email)
select id, email from auth.users where email = 'YOUR_EMAIL_HERE';
```

## 4) ادخل
```
https://proskill-store.vercel.app/admin
```

---

## أمان
- التحقق من الأدمن يتم **على السيرفر** في كل طلب (`requireAdmin`).
- جدول `store_admins` غير قابل للقراءة بمفتاح anon (RLS بدون سياسات).
- `/admin` مستبعد من محركات البحث (robots + noindex).
- أي مستخدم Supabase عادي لن يستطيع الدخول ما لم يُضف لجدول الأدمن.

## سعر الصرف
- `/api/fx` يجلب سعر USD→EGP لايف ويخزّنه 6 ساعات في `store_settings`.
- لتعديل هامش الربح (افتراضي 2%):
```sql
update store_settings
set value = jsonb_set(value, '{markup_percent}', '3'::jsonb)
where key = 'fx_usd_egp';
```
