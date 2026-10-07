// All user-facing Arabic copy lives here; components hold no text.
// Heading convention: text before `//` renders at weight 700, text after it at 400.
// Explicit extension: vite.config.ts loads this file too, and Vite's native config loader requires it
import { sectionIds } from './lib/sections.ts'

const repository = 'https://github.com/MohammedAbuShamleh/sila'

export const meta = {
  title: 'صِلة — ذاكرة مشتركة لوكلاء البرمجة',
  description:
    'أداة مفتوحة تقرأ جلساتك مع Claude Code و Codex و Gemini، وتنقل حالة مشروعك بينها. ينفد حدّ وكيل، تفتح الآخر وتكتب «كمّل».',
}

export const brand = {
  name: 'صِلة',
  tagline: ['ذاكرة مشتركة', 'لوكلائك البرمجية'],
}

export const nav = {
  label: 'أقسام الصفحة',
  links: [
    { label: 'كيف يعمل', href: `#${sectionIds.howItWorks}`, showOnMobile: false },
    { label: 'الضمانات', href: `#${sectionIds.guarantees}`, showOnMobile: false },
    // No section is named «الواجهة»; it points at the integrations strip (MCP is the interface)
    { label: 'الواجهة', href: `#${sectionIds.worksWith}`, showOnMobile: false },
    { label: 'GitHub', href: repository, showOnMobile: true },
  ],
}

export const hero = {
  // One entry per line; lines enter with an 80ms stagger.
  title: ['ذاكرة واحدة', 'لكل وكلائك // البرمجية'],
  lead: 'تقرأ جلساتك مع Claude Code و Codex و Gemini من قرصك، وتستخلص ما تقرّر وما رُفض وأين توقّفت، وتحفظه ملفات Markdown تملكها.',
}

export const install = {
  // The README's first line. Global, not npx: the hook records the program's path, and npx runs it
  // from a cache npm empties; `npx sila` would also fetch a different package of that name.
  command: 'npm install -g sila-memory',
  note: 'بلا مفتاح API',
  copy: 'نسخ',
  copied: 'نُسخ ✓',
  copiedAnnouncement: 'نُسخ الأمر',
}

export const howItWorks = {
  title: 'تتوقف عند وكيل // وتُكمل عند آخر',
  lead: 'لا تنتقل المحادثة — تنتقل حالة المشروع: ما تقرّر، ولماذا رُفض غيره، وأين وقفت الجلسة بالضبط. الوكيل الجديد لا يحتاج أربعة آلاف سطر من حوارك، يحتاج الأربعين التي تهمّ.',
  cards: [
    {
      title: 'كلود توقّف // ١١:٣٠',
      quote: '«راجعت الحارس. أقترح حقل تحقّق مستقلاً، ويلزم حسم نقطتين قبل الكتابة. لم أعدّل شيئاً.»',
      note: 'أغلقتَ الجلسة هنا',
    },
    {
      title: 'كودكس أكمل // ١١:٣١',
      quote: '«نقطة التوقف هي إصلاح التحقّق قبل تعديل البيانات. الملف يطلب حسم نقطتين قبل كتابة الإصلاح…»',
      note: 'كتبتَ «كمّل» فقط',
    },
  ],
  closing: 'وكيلان من شركتين مختلفتين، ولا حرف واحد أُعيد شرحه.',
}

export const guarantees = {
  title: 'ليست شعارات // لكلٍّ اختبار يُشغَّل',
  items: [
    {
      title: 'لا تُحذف حقيقة أبداً',
      body: 'حين يتغيّر شيء، تبقى القيمة القديمة مشطوبة بتاريخها وبمصدرها. الخانة تحمل قيمة واحدة صحيحة، لا كومة متناقضة.',
    },
    {
      title: 'الملفات هي المصدر',
      body: 'احذف الفهرس كلّه وأعد بناءه من ملفات Markdown وحدها — يعطيك الخانات نفسها. والمخزن مستودع git، فالتراجع ممكن دائماً.',
    },
    {
      title: 'لا توسيع لدائرة من رأى بياناتك',
      body: 'كل جلسة يلخّصها الوكيل الذي أنشأها. جلسة Codex لا تذهب إلى Claude، والعكس. ومن أراد ألّا يغادر شيء جهازه، فله وضع بلا نموذج.',
    },
    {
      title: 'بلا مفتاح ولا اشتراك ثانٍ',
      body: 'التلخيص يجري عبر أدوات الوكلاء المثبّتة عندك، باشتراكك الحالي. ولا شيء يُباع هنا: المشروع مفتوح ومجاني.',
    },
  ],
}

// Values are numbers so the counter can climb to them; they render in Arabic-Indic digits.
// The README's figures of 2026-10-06 (`sila stats`, `npm test`); CONTRIBUTING.md lists where each
// lives, and they change together.
export const stats = [
  { value: 172, label: 'جلسة قُرئت في أول مخزن' },
  { value: 389, label: 'حقيقة صحيحة الآن' },
  { value: 360, label: 'حقيقة استُبدلت بأحدث منها' },
  { value: 266, label: 'اختباراً تشغّله بنفسك' },
]

export const limits = {
  title: 'ما لا يفعله بعد',
  lead: 'تُذكر هنا لا في مكان مخفيّ. أداة تخفي حدودها لا تستحق أن تُصدَّق في ادعاءاتها.',
  items: [
    {
      title: 'لا بحث دلالي',
      body: 'البحث نصّي مع تطبيع عربي كامل. يكفي لآلاف الجلسات، ولا يربط بين مفهومين بمفردات مختلفة.',
    },
    {
      title: 'شخص واحد، جهاز واحد',
      body: 'لا مزامنة فريق ولا سحابة. المخزن مستودع git — ادفعه إلى ريبو خاص إن أردت مزامنة.',
    },
    {
      title: 'جودة الاستخلاص تتبع النموذج',
      body: 'ما لا تثق به الآلة يذهب إلى صندوق انتظارك، لا إلى الذاكرة. وما تقبله أنت لا يستبدله نموذج بعدها.',
    },
    {
      title: 'صيغ الجلسات تتغيّر بلا إعلان',
      body: 'حين يغيّر وكيل صيغة ملفاته ينكسر محوّله، فيفكّ الفحص الذاتي آخر ملف لكل وكيل ويحذّرك قبل أن تصمت الذاكرة.',
    },
  ],
}

export const worksWith = {
  title: 'يعمل مع',
  tools: ['Claude Code', 'Codex', 'Gemini CLI', 'MCP'],
}

export const footer = {
  credits: ['صِلة', 'بناه محمد أبو شملة في غزّة', 'رخصة MIT'],
  navLabel: 'روابط المشروع',
  links: [
    { label: 'GitHub', href: repository },
    { label: 'التوثيق', href: `${repository}#readme` },
  ],
}
