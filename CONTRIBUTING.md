# المساهمة · Contributing

## الأرقام تُحدَّث معاً: الموقع والـREADME

الموقع (`site/`) يعرض أرقاماً يعرضها الـREADME أيضاً. رقم يتغيّر يُحدَّث في كل مواضعه في commit واحد: `site/src/content.ts` و`README.md` و`README.en.md`. رقمٌ يقوله الموقع بخلاف الـREADME يجعل أحدهما كاذباً، والموقع أول ما يُقرأ.

| الرقم | الموقع: `stats` في `site/src/content.ts` | `README.md` | `README.en.md` | من أين يُؤخذ |
|---|---|---|---|---|
| الجلسات | «جلسة قُرئت في أول مخزن» | `sessions` في كتلة `stats`، قسم «الأرقام من مخزني» | `sessions` في كتلة `stats`، قسم “Numbers from my vault” | `sila stats` ← `sessions`: جلسات لها ملاحظة |
| الحقائق الحيّة | «حقيقة صحيحة الآن» | `facts` في الكتلة نفسها | `facts` | `sila stats` ← `facts` |
| الحقائق المستبدَلة | «حقيقة استُبدلت بأحدث منها» | `superseded` في الكتلة نفسها | `superseded` | `sila stats` ← `superseded` |
| الاختبارات | «اختباراً تشغّله بنفسك» | سطر «**الاختبارات:**» وجدول الملفات تحته | سطر “**Tests:**” وجدول الملفات تحته | `npm test`: مجموع «ناجح» في الملفات الثلاثة عشر |

ومع كل تحديث للأرقام الثلاثة الأولى، يتغيّر تاريخ الـREADME معها: «`stats` على المخزن في …» و«كل رقم في هذا القسم من …» (وما يقابلهما في `README.en.md`). الموقع لا يعرض تاريخاً، فالـREADME هو ما يقول متى قيست.

وليس رقماً لكنه يُحدَّث معها بالقاعدة نفسها: **أمر التثبيت** — `install.command` في `site/src/content.ts`، وقسم «البدء» / “Getting started” في الـREADME.

أرقام الـREADME الأخرى (الجلسات بالوكيل، والملفات على القرص، والتكلفة، و`--dry-run`) لا يعرضها الموقع، فلا تدخل هذه القائمة. وإن عرضها الموقع يوماً، تُضاف هنا في الـcommit نفسه.

---

## Numbers move together: the site and the READMEs

The site (`site/`) shows figures the README shows too. When one changes, every place it appears changes in the same commit: `site/src/content.ts`, `README.md` and `README.en.md`. A site that disagrees with the README makes one of them false, and the site is read first.

| Figure | Site: `stats` in `site/src/content.ts` | Where in the READMEs | Source |
|---|---|---|---|
| Sessions | «جلسة قُرئت في أول مخزن» | `sessions` in the `stats` block, “Numbers from my vault” | `sila stats` → `sessions` (sessions with a note) |
| Live facts | «حقيقة صحيحة الآن» | `facts` in the same block | `sila stats` → `facts` |
| Superseded facts | «حقيقة استُبدلت بأحدث منها» | `superseded` in the same block | `sila stats` → `superseded` |
| Tests | «اختباراً تشغّله بنفسك» | the “**Tests:**” line and the per-file table under it | `npm test`: the sum of passes across the thirteen files |

When the first three change, so do the README's dates: “`stats` on the vault, …” and “Every figure in this section is from …”. The site shows no date; the README is what says when the figures were taken.

Not a number, but kept in step by the same rule: **the install command**, `install.command` in `site/src/content.ts` and “Getting started” in the READMEs.

The README's other figures (sessions by agent, files on disk, cost, `--dry-run`) don't appear on the site, so they aren't on this list. If the site ever shows one, it joins the list in the same commit.
