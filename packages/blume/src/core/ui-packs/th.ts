import type { UIStringsOverride } from "../i18n-ui.ts";

/** Thai (th) UI strings. */
export const th: UIStringsOverride = {
  actions: {
    addToCursor: "เพิ่มไปยัง Cursor",
    addToVscode: "เพิ่มไปยัง VS Code",
    askAI: "ถาม AI เกี่ยวกับหน้านี้",
    connectMcp: "เชื่อมต่อกับ MCP",
    copied: "คัดลอกแล้ว!",
    copyClaudeCode: "คัดลอกคำสั่ง Claude Code",
    copyMarkdown: "คัดลอกเป็น Markdown",
    copyServerUrl: "คัดลอก URL ของเซิร์ฟเวอร์",
    edit: "แก้ไขบน GitHub",
    openInChat: "เปิดในแชท",
    scrollToTop: "กลับไปด้านบน",
  },
  ask: {
    empty: "ถามคำถามเกี่ยวกับเอกสาร",
    error: "ขออภัย เกิดข้อผิดพลาดบางอย่าง",
    label: "ถามคำถาม",
    placeholder: "ถามคำถาม…",
    send: "ส่ง",
    title: "ถาม AI",
  },
  banner: { dismiss: "ปิดประกาศ" },
  changelog: {
    description: "อัปเดตผลิตภัณฑ์และบันทึกประจำรุ่น",
    title: "บันทึกการเปลี่ยนแปลง",
  },
  feedback: {
    no: "ไม่",
    question: "หน้านี้มีประโยชน์หรือไม่?",
    thanks: "ขอบคุณสำหรับความคิดเห็นของคุณ!",
    yes: "ใช่",
  },
  languageSwitcher: { label: "ภาษา", untranslated: "ยังไม่ได้แปล" },
  nav: { breadcrumb: "เส้นทางนำทาง" },
  page: {
    lastUpdated: "อัปเดตล่าสุดเมื่อ",
    next: "ถัดไป",
    pagination: "การแบ่งหน้า",
    previous: "ก่อนหน้า",
    skipToContent: "ข้ามไปยังเนื้อหา",
  },
  search: {
    all: "ทั้งหมด",
    button: "ค้นหา",
    devOnly: "การค้นหาพร้อมใช้งานในบิลด์โปรดักชัน",
    label: "ค้นหาเอกสาร",
    noResults: "ไม่พบผลลัพธ์",
    placeholder: "ค้นหาเอกสาร…",
  },
  toc: { title: "ในหน้านี้" },
};
