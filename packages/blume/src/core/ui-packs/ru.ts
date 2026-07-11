import type { UIStringsOverride } from "../i18n-ui.ts";

/** Russian (ru) UI strings. */
export const ru: UIStringsOverride = {
  actions: {
    addToCursor: "Добавить в Cursor",
    addToVscode: "Добавить в VS Code",
    askAI: "Спросить ИИ об этой странице",
    connectMcp: "Подключиться к MCP",
    copied: "Скопировано!",
    copyClaudeCode: "Скопировать команду Claude Code",
    copyMarkdown: "Скопировать как Markdown",
    copyServerUrl: "Скопировать URL сервера",
    edit: "Редактировать на GitHub",
    openInChat: "Открыть в чате",
    scrollToTop: "Наверх",
  },
  ask: {
    empty: "Задайте вопрос по документации.",
    error: "Извините, что-то пошло не так.",
    label: "Задать вопрос",
    placeholder: "Задайте вопрос…",
    send: "Отправить",
    title: "Спросить ИИ",
  },
  banner: { dismiss: "Закрыть объявление" },
  changelog: {
    description: "Обновления продукта и примечания к выпускам.",
    title: "Журнал изменений",
  },
  feedback: {
    no: "Нет",
    question: "Эта страница была полезной?",
    thanks: "Спасибо за ваш отзыв!",
    yes: "Да",
  },
  languageSwitcher: { label: "Язык", untranslated: "Не переведено" },
  nav: { breadcrumb: "Навигационная цепочка" },
  page: {
    lastUpdated: "Последнее обновление",
    next: "Далее",
    pagination: "Пагинация",
    previous: "Назад",
    skipToContent: "Перейти к содержимому",
  },
  search: {
    all: "Все",
    button: "Поиск",
    devOnly: "Поиск доступен в production-сборке.",
    label: "Поиск по документации",
    noResults: "Ничего не найдено.",
    placeholder: "Поиск по документации…",
  },
  toc: { title: "На этой странице" },
};
