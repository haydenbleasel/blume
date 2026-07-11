import type { UIStringsOverride } from "../i18n-ui.ts";

/** Arabic (ar) UI strings. */
export const ar: UIStringsOverride = {
  actions: {
    addToCursor: "إضافة إلى Cursor",
    addToVscode: "إضافة إلى VS Code",
    askAI: "اسأل الذكاء الاصطناعي عن هذه الصفحة",
    connectMcp: "الاتصال بـ MCP",
    copied: "تم النسخ!",
    copyClaudeCode: "نسخ أمر Claude Code",
    copyMarkdown: "نسخ بصيغة Markdown",
    copyServerUrl: "نسخ عنوان URL للخادم",
    edit: "التعديل على GitHub",
    openInChat: "فتح في المحادثة",
    scrollToTop: "العودة إلى الأعلى",
  },
  ask: {
    empty: "اطرح سؤالاً حول الوثائق.",
    error: "عذراً، حدث خطأ ما.",
    label: "اطرح سؤالاً",
    placeholder: "اطرح سؤالاً…",
    send: "إرسال",
    title: "اسأل الذكاء الاصطناعي",
  },
  banner: { dismiss: "إغلاق الإعلان" },
  changelog: {
    description: "تحديثات المنتج وملاحظات الإصدارات.",
    title: "سجل التغييرات",
  },
  feedback: {
    no: "لا",
    question: "هل كانت هذه الصفحة مفيدة؟",
    thanks: "شكراً على ملاحظاتك!",
    yes: "نعم",
  },
  languageSwitcher: { label: "اللغة", untranslated: "غير مترجم" },
  nav: { breadcrumb: "مسار التنقل" },
  page: {
    lastUpdated: "آخر تحديث في",
    next: "التالي",
    pagination: "ترقيم الصفحات",
    previous: "السابق",
    skipToContent: "الانتقال إلى المحتوى",
  },
  search: {
    all: "الكل",
    button: "بحث",
    devOnly: "البحث متاح في إصدار الإنتاج.",
    label: "البحث في الوثائق",
    noResults: "لم يتم العثور على نتائج.",
    placeholder: "البحث في الوثائق…",
  },
  toc: { title: "في هذه الصفحة" },
};
