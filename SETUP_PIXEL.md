# تفعيل Pixel و GA4

## متغيرات Vercel (كلها اختيارية — الغائب يُتجاهل بهدوء)

| المتغير | من أين | مثال |
|---|---|---|
| `VITE_META_PIXEL_ID` | Meta Events Manager | `1367489998718107` |
| `VITE_TIKTOK_PIXEL_ID` | TikTok Events Manager | `CXXXXXXXXXXXXX` |
| `VITE_GA4_ID` | Google Analytics → Admin → Data Streams | `G-XXXXXXXXXX` |

> `VITE_` تعني أن القيمة تُدمج وقت البناء → **لازم Redeploy** بعد أي تعديل.

## الأحداث المُرسَلة

| متى | Meta | TikTok | GA4 |
|---|---|---|---|
| فتح صفحة | `PageView` | `page` | `page_view` |
| فتح منتج | `ViewContent` | `ViewContent` | `view_item` |
| ضغط "اشترِ الآن" | `InitiateCheckout` | `InitiateCheckout` | `begin_checkout` |
| نجاح الدفع | `Purchase` | `CompletePayment` | `purchase` |

كل الأحداث تحمل **القيمة الحقيقية بالدولار** — وهذا ما تتعلّم منه الحملات.

## حمايتان مهمّتان

1. **Purchase يُرسَل مرة واحدة فقط لكل رقم طلب** (حتى لو حدّث العميل الصفحة عشر مرات).
   بدون هذا تُبلّغ المنصّات بمبيعات وهمية ويفسد حساب ROAS.
2. **لا نرسل بريد العميل ولا الأكواد** لأي منصّة إعلانية إطلاقاً.

## التحقق
- Meta: ثبّت إضافة **Meta Pixel Helper** وافتح المتجر.
- GA4: **Reports → Realtime**.
- TikTok: **Pixel → Test Events**.

اشترِ منتجاً رخيصاً واحداً وتأكّد أن `Purchase` ظهر بقيمة صحيحة **مرة واحدة**.

---

# رفع صور المنتجات

الداش بورد → **المنتجات** → ✏️ تعديل → **📤 رفع صورة**
- JPG / PNG / WebP · حتى 3 ميجابايت
- تُخزَّن في Supabase Storage وتظهر في المتجر فوراً
- يمكن أيضاً لصق رابط مباشر بدلاً من الرفع

الرفع يتم عبر السيرفر (`/api/admin/upload`) بعد التحقق من صلاحية الأدمن — المتصفح
لا يملك صلاحية كتابة في التخزين إطلاقاً.
